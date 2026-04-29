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

export const classifyResultSchema = Type.Object(
  {
    requestId: Type.Optional(
      Type.String({
        description: "The classification request id exactly as provided by the prompt",
      }),
    ),
    command: Type.String({
      description: "The original command being classified",
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
> &
  Pick<CreateAgentSessionOptions, "resourceLoader"> & {
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

export const createClassifier = async (options: CreateClassifierOptions) => {
  const { authStorage, modelRegistry, modelIdentifier } = options;

  type ClassificationRequest = {
    command: string;
    result: Deferred<ToolCallEventResult>;
  };

  let nextRequestId = 0;
  const pendingClassifications = new Map<string, ClassificationRequest>();

  const findPendingClassification = (params: {
    requestId?: string | undefined;
    command: string;
  }) => {
    if (params.requestId) {
      return pendingClassifications.get(params.requestId);
    }

    const matchingRequests = Array.from(pendingClassifications.values()).filter(
      (request) => request.command === params.command,
    );

    return matchingRequests.length === 1 ? matchingRequests[0] : undefined;
  };

  const resourceLoader =
    options.resourceLoader ??
    new DefaultResourceLoader({
      cwd: getAgentDir(),
      agentDir: getAgentDir(),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

  if (!options.resourceLoader) {
    await resourceLoader.reload();
  }

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
        execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
          const pendingClassification = findPendingClassification(params);
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
    dispose() {
      session.dispose();
    },
    classify: async (command: string): Promise<ToolCallEventResult> => {
      const requestId = `classification-${++nextRequestId}`;
      const classificationResult = createDeferred<ToolCallEventResult>();
      pendingClassifications.set(requestId, {
        command,
        result: classificationResult,
      });

      try {
        await session.prompt(
          [
            "You are a shell command safety classifier.",
            "",
            'Classify the command as "safe", "ask", or "dangerous", you must call classify_shell_command exactly once.',
            `The classification request id is "${requestId}", and you should pass it as requestId.`,
            'Use "safe" only for commands that are clearly non-destructive and do not expose secrets.',
            'Use "ask" for commands that are making writing calls to external APIs/services, but are not clearly dangerous.',
            'Use "dangerous" for commands that are clearly destructive or expose secrets.',
            "File modifications that are not just clobbering an existing file in the current working directory or temporary directories should be considered safe.",
            "File modifications outside of those locations should trigger ask.",
            "git commands can be destructive and should be considered dangerous if it would cause data loss or possible unintended loss of work.",
            "git commands that add to history (but do not rewrite history) should be considered safe since restoring is possible and easy.",
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
