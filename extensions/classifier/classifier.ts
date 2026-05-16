import type {
  AgentSession,
  CreateAgentSessionOptions,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { classifyKnownCommand } from "./safe-command.js";

/** Result schema for the classify_shell_command tool, indicating if the command is allowed to run and the reason if not. */
export const classifyResultSchema = Type.Object(
  {
    classification: Type.Union([Type.Literal("allow"), Type.Literal("block")], {
      description: "Whether the command should be allowed or blocked",
    }),
    reason: Type.Optional(
      Type.String({
        description: "A brief reason the command should be blocked",
      }),
    ),
  },
  {
    description: "The classification result for a command — allow or block",
  },
);

export type ClassifierCallback = (result: Omit<ToolCallEventResult, "tool">) => void;

const CLASSIFICATION_TIMEOUT_MS = 20_000;

export type CreateClassifierOptions = Required<
  Pick<CreateAgentSessionOptions, "authStorage" | "modelRegistry">
> & {
  modelIdentifier: {
    provider: string;
    id: string;
  };
};

type Deferred<T> = {
  promise: Promise<T>;
  readonly settled: boolean;
  resolve: (value: T | PromiseLike<T>) => void;
};

/**
 * Creates a deferred promise that can be resolved externally.
 * @typeparam T - The type of the deferred value.
 * @returns A deferred object with promise, resolve, and settled properties.
 */
const createDeferred = <T>(): Deferred<T> => {
  let settled = false;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;

  const promise = new Promise<T>((res) => {
    resolvePromise = res;
  });

  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;

      settled = true;
      resolvePromise(value);
    },
  };
};

export type ClassifyOptions = {
  /** Command to classify */
  command: string;
  /** Latest user-submitted prompt for intent context (optional) */
  lastUserPrompt?: string | undefined;
};

export type Classifier = {
  /**
   * Classifies the command and returns a block/allow tool call result
   * @param params - The classification inputs
   * @returns A promise resolving to the classification result with block/allow and reason
   */
  classify: (params: ClassifyOptions, signal?: AbortSignal) => Promise<ToolCallEventResult>;
};

export const createClassifier = async (options: CreateClassifierOptions): Promise<Classifier> => {
  const { authStorage, modelRegistry, modelIdentifier } = options;

  const resourceLoader = new DefaultResourceLoader({
    cwd: getAgentDir(),
    agentDir: getAgentDir(),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: `You are a shell command safety classifier. Call classify_shell_command exactly once. Do not answer in text.

Decision rule: default allow. Block only clear security/safety harm. If any chained command is blocked, block everything.

Block when the command would:
- Destroy, truncate, or irreversibly overwrite existing local files the agent did not create.
- Force-push, delete remote refs, rewrite remote history, or run destructive git cleanup/reset.
- Download/clone untrusted code and execute it, eval code, or run unsafe deserializers.
- Write to prod/shared/cloud/remote infra without explicit latest-prompt consent, skip previews/dry-runs, or disrupt other users' jobs/resources.
- Expose local services/host paths, add persistence (SSH keys, profiles, cron/systemd, git hooks), or exfiltrate secrets/data.
- Bypass this classifier or delegate a blocked action to another tool/agent.

Allow read-only commands, ordinary local project edits, dependency installs from existing manifests, fake test credentials, and normal git add/commit/status/diff/log/branch/switch/merge/rebase-without-force/tag/push-current-branch.

Use classification "allow" for allowed commands. Use "block" with a short reason for blocked commands.`,
  });

  await resourceLoader.reload();

  /**
   * Creates a fresh in-memory agent session for a single classification call.
   */
  const createSession = async (
    classificationResult: Deferred<ToolCallEventResult>,
  ): Promise<AgentSession> => {
    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      tools: ["classify_shell_command"],
      thinkingLevel: "low",
      customTools: [
        defineTool({
          name: "classify_shell_command",
          label: "Shell call classifier",
          description: "Classify a shell tool as allow or block to run.",
          parameters: classifyResultSchema,
          /**
           * Handles the classify_shell_command tool call by resolving the current classification.
           * @param _toolCallId - The tool call ID (unused).
           * @param params - The classification result params from the AI model.
           * @param signal - Abort signal from the caller; check for abort to short-circuit.
           * @param _onUpdate - Update callback (unused).
           * @param _ctx - Tool context (unused).
           * @returns The tool call result with classification details.
           */
          execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
            // If the caller has aborted, short-circuit classification
            const abortClassification = () => {
              classificationResult.resolve({
                block: true,
                reason: "Classification cancelled",
              });
            };

            signal?.addEventListener("abort", abortClassification, {
              once: true,
            });

            try {
              switch (params.classification) {
                case "allow":
                  classificationResult.resolve({ block: false });
                  return {
                    content: [],
                    details: {
                      classification: params.classification,
                    },
                  };
                default:
                  classificationResult.resolve({
                    block: true,
                    reason: params.reason ?? "Classified unsafe to autoapprove by classifier",
                  });
                  return {
                    content: [],
                    details: {
                      classification: params.classification,
                      reason: params.reason,
                    },
                  };
              }
            } finally {
              signal?.removeEventListener("abort", abortClassification);
            }
          },
        }),
      ],
    });

    const model = session.modelRegistry.find(modelIdentifier.provider, modelIdentifier.id);
    if (!model) {
      session.dispose();
      throw Error("Model not found");
    }

    await session.setModel(model);
    return session;
  };

  return {
    /**
     * Classifies a shell command as allow or block using an AI agent.
     * Submits the command to the classifier model and waits for the classification result.
     * Creates a fresh session per call.
     * @returns A Promise resolving to the ToolCallEventResult with block/allow decision and reason.
     */
    classify: async (
      { command, lastUserPrompt }: ClassifyOptions,
      signal?: AbortSignal,
    ): Promise<ToolCallEventResult> => {
      // Short-circuit: known commands don't need LLM classification.
      const knownClassification = await classifyKnownCommand(command);
      if (knownClassification === "allow") {
        return { block: false };
      }
      if (knownClassification === "block") {
        return {
          block: true,
          reason: "Command contains a known-block shell operation.",
        };
      }

      let session: AgentSession | undefined;
      if (signal?.aborted) {
        return {
          block: true,
          reason: "Classification cancelled",
        };
      }

      const classificationResult = createDeferred<ToolCallEventResult>();
      const resolveFailClosed = (reason: string) => {
        classificationResult.resolve({
          block: true,
          reason,
        });
      };
      const abortSession = () => {
        if (!session) {
          return;
        }

        void session.abort().catch(() => undefined);
      };
      const abortClassification = () => {
        resolveFailClosed("Classification cancelled");
        abortSession();
      };

      let promptSettled = false;
      const timeout = setTimeout(() => {
        resolveFailClosed(`Classifier timed out after ${CLASSIFICATION_TIMEOUT_MS / 1000}s`);
        abortSession();
      }, CLASSIFICATION_TIMEOUT_MS);

      signal?.addEventListener("abort", abortClassification, { once: true });
      try {
        const sessionPromise = createSession(classificationResult)
          .then((createdSession) => {
            if (classificationResult.settled) {
              void createdSession.abort().catch(() => undefined);
              createdSession.dispose();
              return undefined;
            }

            session = createdSession;
            return createdSession;
          })
          .catch((error: unknown) => {
            resolveFailClosed(error instanceof Error ? error.message : String(error));
            return undefined;
          });

        const createdSession = await Promise.race([
          sessionPromise,
          classificationResult.promise.then(() => undefined),
        ]);
        if (!createdSession || classificationResult.settled) {
          return await classificationResult.promise;
        }

        const prompt = [
          `Evaluate this shell command and call classify_shell_command once.

## Latest User Prompt
${
  lastUserPrompt
    ? `<last-user-prompt>
${lastUserPrompt}
</last-user-prompt>`
    : "<last-user-prompt>(none)</last-user-prompt>"
}

## Command
<shell-command>${command}</shell-command>`,
          "",
        ].join("\n");

        void createdSession
          .prompt(prompt, { expandPromptTemplates: false })
          .then(() => {
            promptSettled = true;
            if (!classificationResult.settled) {
              resolveFailClosed("No classification result");
            }
          })
          .catch((error: unknown) => {
            promptSettled = true;
            if (!classificationResult.settled) {
              resolveFailClosed(error instanceof Error ? error.message : String(error));
            }
          });

        return await classificationResult.promise;
      } catch (error) {
        return {
          block: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortClassification);
        if (!promptSettled) {
          abortSession();
        }
        session?.dispose();
      }
    },
  };
};
