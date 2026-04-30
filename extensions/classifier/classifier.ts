import type {
  AgentSession,
  CreateAgentSessionOptions,
  ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  createReadToolDefinition,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { isSafeCommand } from "./safe-command.js";

/** Result schema for the classify_shell_command tool, indicating if the command is safe to run and the reason if not. */
export const classifyResultSchema = Type.Object(
  {
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
   * Using a new session per call keeps the system prompt at the stable prompt-prefix,
   * which maximizes cache hit rates with providers that support prompt caching.
   */
  const createSession = async (
    classificationResult: Deferred<ToolCallEventResult>,
  ): Promise<AgentSession> => {
    const readTool = defineTool(createReadToolDefinition(process.cwd()));
    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      tools: ["classify_shell_command", readTool.name],
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
           * @param _signal - Abort signal (unused).
           * @param _onUpdate - Update callback (unused).
           * @param _ctx - Tool context (unused).
           * @returns The tool call result with classification details.
           */
          execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
            const classificationReason =
              typeof params.reason === "string" ? params.reason : undefined;

            switch (params.classification) {
              case "safe":
                classificationResult.resolve({ block: false });
                break;
              default:
                classificationResult.resolve({
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
        readTool,
      ],
    });

    const model = session.modelRegistry.find(modelIdentifier.provider, modelIdentifier.id);
    if (!model) {
      session.dispose();
      throw Error("Model not found");
    }

    session.setModel(model);
    return session;
  };

  return {
    /**
     * Classifies a shell command as safe, ask, or dangerous using an AI agent.
     * Submits the command to the classifier model and waits for the classification result.
     * Creates a fresh session per call for optimal prompt cache hits.
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
      // Short-circuit: known safe commands don't need LLM classification
      if (isSafeCommand(command)) {
        return { block: false };
      }

      const classificationResult = createDeferred<ToolCallEventResult>();

      let session: AgentSession | undefined;
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
        session?.dispose();
      }
    },
  };
};
