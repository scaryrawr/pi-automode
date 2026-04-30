import type { CreateAgentSessionOptions, ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/** Result schema for the classify_shell_command tool, indicating if the command is safe to run and the reason if not. */
export const classifyResultSchema = Type.Object(
  {
    requestId: Type.String({
      description: "The classification request id exactly as provided by the prompt",
    }),
    classification: Type.Enum(["safe", "ask", "dangerous"]),
    reason: Type.Optional(
      Type.String({
        description:
          "The reason the command requires user ask or is marked dangerous and should be blocked",
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

export type Classifier = {
  /** Disposes the classifier */
  dispose: () => void;

  /**
   * Classifies the command and returns a block/allow tool call result
   * @param command - The shell command to classify
   * @param prompt - The full prompt given to the model for context (optional, but can improve classification accuracy)
   * @returns A promise resolving to the classification result with block/allow and reason
   */
  classify: ({
    command,
    prompt,
  }: {
    command: string;
    prompt?: string | undefined;
  }) => Promise<ToolCallEventResult>;
};

export const createClassifier = async (options: CreateClassifierOptions): Promise<Classifier> => {
  const { authStorage, modelRegistry, modelIdentifier } = options;

  type ClassificationRequest = {
    command: string;
    result: Deferred<ToolCallEventResult>;
  };

  let nextRequestId = 0;
  const pendingClassifications = new Map<string, ClassificationRequest>();

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
    ].join("\n"),
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    resourceLoader,
    tools: ["classify_shell_command"],
    customTools: [
      defineTool({
        name: "classify_shell_command",
        label: "Shell call classifier",
        description: "Classify a shell tool as safe, ask, or dangerous to run.",
        parameters: classifyResultSchema,
        /**
         * Handles the classify_shell_command tool call by resolving the matching pending classification.
         * @param _toolCallId - The tool call ID (unused).
         * @param params - The classification result params from the AI model.
         * @param _signal - Abort signal (unused).
         * @param _onUpdate - Update callback (unused).
         * @param _ctx - Tool context (unused).
         * @returns The tool call result with classification details.
         */
        execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
          const pendingClassification = pendingClassifications.get(params.requestId);
          if (!pendingClassification) {
            throw new Error(
              "Could not find pending classification for requestId: " + params.requestId,
            );
          }
          const classificationReason =
            typeof params.reason === "string" ? params.reason : undefined;

          if (!pendingClassification) {
            return {
              content: [],
              details: {
                classification: params.classification,
                reason: "No pending classification request matched the tool call",
              },
            };
          }

          switch (params.classification) {
            case "safe":
              pendingClassification.result.resolve({ block: false });
              break;
            default:
              pendingClassification.result.resolve({
                block: true,
                reason:
                  classificationReason ?? `Classifier marked command as ${params.classification}`,
              });
          }

          return {
            content: [],
            details: {
              classification: params.classification,
              reason: classificationReason,
            },
          };
        },
      }),
    ],
  });

  const model = session.modelRegistry.find(modelIdentifier.provider, modelIdentifier.id);
  if (!model) {
    throw Error("Model not found");
  }

  session.setModel(model);

  return {
    /**
     * Disposes the classifier's underlying agent session, freeing resources.
     */
    dispose() {
      session.dispose();
    },
    /**
     * Classifies a shell command as safe, ask, or dangerous using an AI agent.
     * Submits the command to the classifier model and waits for the classification result.
     * @param command - The shell command to classify.
     * @returns A Promise resolving to the ToolCallEventResult with block/allow decision and reason.
     */
    classify: async ({
      command,
      prompt,
    }: {
      command: string;
      prompt?: string | undefined;
    }): Promise<ToolCallEventResult> => {
      const requestId = `classification-${++nextRequestId}`;
      const classificationResult = createDeferred<ToolCallEventResult>();
      pendingClassifications.set(requestId, {
        command,
        result: classificationResult,
      });

      try {
        await session.prompt(
          [
            `The classification request id is "${requestId}", and you must pass it as requestId.`,
            "You must call classify_shell_command exactly once with the classification result.",
            ...(prompt
              ? [
                  "Given the user prompt, take into account if the command being perfomed aligns with the user's desired intent.",
                  "If the user's intent appears to be malicious or harmful, you should still classify the command as dangerous or ask even if the command aligns with the user's intent.",
                  "If the command modifies data in a way that clearly aligns with the user's direct intent, and does not appear to be malicious or harmful, you can classify the command as safe.",
                  "Alignment should be obvious, if it aligns due to extensive thinking in a roundabout way and is potentially destructive/dangerous, it should be classified as ask or dangerous.",
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
        pendingClassifications.delete(requestId);
      }
    },
  };
};
