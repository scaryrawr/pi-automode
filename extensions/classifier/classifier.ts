import type { CreateAgentSessionOptions, ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { createAgentSession, SessionManager, defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export const classifyResultSchema = Type.Object({
  classification: Type.Enum(["safe", "ask", "dangerous"]),
  reason: Type.Optional(Type.String),
});

export type ClassifierCallback = (result: Omit<ToolCallEventResult, "tool">) => void;

export type CreateClassifierOptions = Required<
  Pick<CreateAgentSessionOptions, "authStorage" | "modelRegistry">
> & {
  modelIdentifier: {
    provider: string;
    id: string;
  };
  command: string;
};

export async function classifyCommand(
  options: CreateClassifierOptions,
): Promise<ToolCallEventResult> {
  const { authStorage, modelRegistry, modelIdentifier, command } = options;

  let block = true;
  let reason: string | undefined = "No classification result";
  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
    customTools: [
      defineTool({
        name: "classify_shell_command",
        label: "Shell call classifier",
        description: "Classify a shell tool as safe, ask, or dangerous to run.",
        parameters: classifyResultSchema,
        execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
          const classificationReason =
            typeof params.reason === "string" ? params.reason : undefined;

          switch (params.classification) {
            case "safe":
              block = false;
              break;
            default:
              block = true;
              reason =
                classificationReason ?? `Classifier marked command as ${params.classification}`;
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
    return { block: true, reason: "Model not found" };
  }

  session.setModel(model);

  try {
    await session.prompt(
      [
        "You are a shell command safety classifier.",
        "",
        'Classify the command as "safe", "ask", or "dangerous", you must call classify_shell_command exactly once.',
        'Use "safe" only for commands that are clearly non-destructive and do not expose secrets.',
        'Use "ask" for commands that are making writing calls to external APIs/services, but are not clearly dangerous.',
        'Use "dangerous" for commands that are clearly destructive or expose secrets.',
        "File modifications that are not just clobbering an existing file in the current working directory or temporary directories should be considered safe.",
        "File modifications outside of those locations should trigger ask.",
        "git commands can be destructive and should be considered dangerous if it would cause data loss or possible unintended loss of work.",
        `<shell-command>${command}<shell-command>`,
      ].join("\n"),
    );
    return { block, reason };
  } catch (error) {
    return {
      block: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    session.dispose();
  }
}
