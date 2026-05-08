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

/** Result schema for the classify_shell_command tool, indicating if the command is safe to run and the reason if not. */
export const classifyResultSchema = Type.Object(
  {
    classification: Type.Enum(["safe", "ask", "dangerous"]),
    reason: Type.Optional(
      Type.String({
        description: "A brief reason the command cannot be considered safe to autoapprove",
      }),
    ),
  },
  {
    description: "The classification result for a command for if it is safe or not to execute",
  },
);

export type ClassifierCallback = (result: Omit<ToolCallEventResult, "tool">) => void;

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
  reject: (reason: unknown) => void;
};

/**
 * Creates a deferred promise that can be resolved or rejected externally.
 * @typeparam T - The type of the deferred value.
 * @returns A deferred object with promise, resolve, reject, and settled properties.
 */
const createDeferred = <T>(): Deferred<T> => {
  let settled = false;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
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
    reject(reason) {
      if (settled) return;

      settled = true;
      rejectPromise(reason);
    },
  };
};

export type ClassifyOptions = {
  /** Command to classify */
  command: string;
  /** Last user prompt to provide additional context for classification (optional) */
  prompt?: string | undefined;
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
    systemPrompt: [
      "You are a shell command safety classifier.",
      "",
      'Classify the shell command as "safe", "ask", or "dangerous", you must call classify_shell_command.',
      'Use "safe" only for commands that are clearly non-destructive and do not expose secrets.',
      'Use "ask" for commands that are making writing calls to external APIs/services, but are not clearly dangerous.',
      'Use "dangerous" for commands that are clearly destructive or expose secrets.',
      "File modifications that are not just clobbering an existing file in the current working directory or temporary directories should be considered safe.",
      "File modifications outside of those locations should trigger ask.",
      "git commands that are possibly destructive should be considered dangerous if it would cause possible unintended loss of work.",
      "git commands that add to git history and do not rewrite git history should be considered safe.",
    ].join("\n"),
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
          description: "Classify a shell tool as safe, ask, or dangerous to run.",
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
              classificationResult.reject(new Error("Classification cancelled"));
            };

            signal?.addEventListener("abort", abortClassification, {
              once: true,
            });

            try {
              switch (params.classification) {
                case "safe":
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
     * Classifies a shell command as safe, ask, or dangerous using an AI agent.
     * Submits the command to the classifier model and waits for the classification result.
     * Creates a fresh session per call.
     * @returns A Promise resolving to the ToolCallEventResult with block/allow decision and reason.
     */
    classify: async (
      { command, prompt }: ClassifyOptions,
      signal?: AbortSignal,
    ): Promise<ToolCallEventResult> => {
      // Short-circuit: known commands don't need LLM classification.
      const knownClassification = await classifyKnownCommand(command);
      if (knownClassification === "safe") {
        return { block: false };
      }
      if (knownClassification === "dangerous") {
        return { block: true, reason: "Command contains a known-dangerous shell operation." };
      }

      let session: AgentSession | undefined;
      const classificationResult = createDeferred<ToolCallEventResult>();
      const abortClassification = () => {
        classificationResult.reject(new Error("Classification cancelled"));
      };

      signal?.addEventListener("abort", abortClassification, { once: true });
      try {
        session = await createSession(classificationResult);
        await session.prompt(
          [
            "You must call classify_shell_command exactly once with the classification result.",
            ...(prompt
              ? [
                  "Given the user prompt, take into account if the command being perfomed aligns with the user's desired intent.",
                  "If the user's intent appears to be malicious, you must classify the command as dangerous even if the command aligns with the user's intent.",
                  "If the command modifies data in a way that clearly aligns with the user's direct intent, and does not appear to be malicious, you must classify the command as safe.",
                  "If the user's intent clearly shows the desire to rewrite git history, commands that rewrite git history should be considered safe.",
                  `<user-prompt>${prompt}</user-prompt>`,
                ]
              : []),
            `<shell-command>${command}</shell-command>`,
          ].join("\n"),
        );

        if (!classificationResult.settled) {
          return {
            block: true,
            reason: "No classification result",
          };
        }

        return classificationResult.promise;
      } catch (error) {
        return {
          block: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        signal?.removeEventListener("abort", abortClassification);
        session?.dispose();
      }
    },
  };
};
