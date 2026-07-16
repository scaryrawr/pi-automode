import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { AutomodeConfigManager } from "./automode/config.js";
import { createClassifier } from "./classifier/classifier.js";
import { handlePermissionToolCall } from "./permissions/permissions.js";
import { classifyKnownCommand } from "./classifier/safe-command.js";
import { ModelSelectorComponent } from "./ui/model-selector.js";

type ClassifierContext = Pick<ExtensionContext, "modelRegistry">;

/**
 * Extract plain text from message content (string or array of text/image blocks).
 * @param content - The content of a message, which can be a string or an array of text/image blocks.
 * @returns The extracted plain text, concatenating text blocks if necessary.
 */
const extractText = (content: string | (TextContent | ImageContent)[]): string => {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(
      (b): b is TextContent =>
        typeof b === "object" && b !== null && "type" in b && b.type === "text",
    )
    .map((b) => (b as TextContent).text)
    .join("\n");
};

/**
 * Check if a message is a user message (role === "user").
 * @param msg - The agent message to check.
 * @returns True if the message is a user message.
 */
const isUserMessage = (msg: AgentMessage): boolean => {
  return "role" in msg && msg.role === "user";
};

/**
 * Find the latest user-submitted prompt for the classifier.
 * Full session histories are too heavy; the classifier only needs the latest user intent to evaluate
 * whether the current bash command aligns with what the user asked for.
 *
 * @param entries - Session entries from getBranch()
 * @returns The latest user message text, or an empty string if none is present.
 */
const getLastUserPrompt = (entries: SessionEntry[]): string => {
  // Iterate in reverse to find the last user message
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message") {
      const msg = entry.message;
      if (isUserMessage(msg)) {
        const content = msg as AgentMessage & { content: string | (TextContent | ImageContent)[] };
        const text = extractText(content.content);
        return text;
      }
    }
  }
  return "";
};

/**
 * Extension entry point that registers the automode bash command classifier and /auto, /automodel commands.
 * Subscribes to tool_call events and either auto-approves or prompts for permission based on config.
 * @param pi - The extension API.
 */
export default async function (pi: ExtensionAPI) {
  const automodeConfig = new AutomodeConfigManager();
  let activeAutoModel = automodeConfig.modelIdentifier;

  /**
   * Creates a classifier instance for the current model.
   * @param ctx - The classifier context containing the model registry.
   * @returns The classifier instance.
   * @throws If classifier creation fails.
   */
  const getClassifier = async (
    ctx: ClassifierContext,
  ): Promise<ReturnType<typeof createClassifier>> => {
    if (!activeAutoModel) {
      throw new Error("Cannot find usable model");
    }

    return createClassifier({
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      modelIdentifier: activeAutoModel,
    });
  };

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
    try {
      // Allow all non-bash tools by default.
      if (!isToolCallEventType("bash", event)) {
        return { block: false };
      }

      switch (automodeConfig.autoMode) {
        case "off":
          return handlePermissionToolCall(event, ctx);
        case "yolo": {
          const allowed = await classifyKnownCommand(event.input.command);
          return allowed === "block"
            ? { block: true, reason: "Command classified as potentially dangerous" }
            : { block: false };
        }
        case "auto":
        default: {
          const lastUserPrompt = getLastUserPrompt(ctx.sessionManager.getBranch());
          return (await getClassifier(ctx)).classify(
            {
              command: event.input.command,
              lastUserPrompt,
            },
            ctx.signal,
          );
        }
      }
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  pi.registerCommand("auto", {
    description: "Control auto mode: [auto|yolo|off]",
    getArgumentCompletions: (prefix) => {
      const options: AutocompleteItem[] = [
        {
          value: "auto",
          label: "auto",
          description: "LLM-powered classifier for bash evaluation",
        },
        {
          value: "yolo",
          label: "yolo",
          description: "Only use static dangerous command filter",
        },
        {
          value: "off",
          label: "off",
          description: "Full permission prompts for risky commands",
        },
        {
          value: "show",
          label: "show",
          description: "Show current auto mode and model",
        },
      ];

      return options.filter((option) => option.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      switch (arg) {
        case "auto":
          automodeConfig.autoMode = "auto";
          ctx.ui.notify("Auto mode set to: LLM classifier", "info");
          break;
        case "yolo":
          automodeConfig.autoMode = "yolo";
          ctx.ui.notify("Auto mode set to: yolo (static filter only)", "info");
          break;
        case "off":
          automodeConfig.autoMode = "off";
          ctx.ui.notify("Auto mode set to: off (permission prompts)", "info");
          break;
        case "show": {
          const mode = automodeConfig.autoMode;
          const model = activeAutoModel
            ? `${activeAutoModel.id} [${activeAutoModel.provider}]`
            : "no model configured";
          ctx.ui.notify(
            `Auto mode: ${mode}; model: ${model}`,
            "info",
          );
          break;
        }
        default:
          automodeConfig.autoMode = arg as "auto" | "yolo" | "off";
          ctx.ui.notify(`Auto mode set to: ${arg}`, "info");
          break;
      }
    },
  });

  pi.registerCommand("automodel", {
    description: "Set the model for auto mode bash evaluation",
    /**
     * Command handler for /automodel - prompts the user to select a model for auto mode bash evaluation.
     * Persists the selection and notifies the user of the result.
     * @param _args - Command arguments (unused).
     * @param ctx - The extension context with model registry and UI access.
     */
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Auto mode model selection requires an interactive UI", "warning");
        return;
      }

      let selected: Model<Api> | undefined;
      const currentModel = activeAutoModel
        ? ctx.modelRegistry.find(activeAutoModel.provider, activeAutoModel.id)
        : undefined;

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const component = new ModelSelectorComponent(tui, theme, {
          currentModel,
          modelRegistry: ctx.modelRegistry,
          onSelect: (model: Model<Api>) => {
            selected = model;
            done(model.id);
          },
          onCancel: () => {
            done(null);
          },
        });

        return {
          render: (w: number) => component.render(w),
          invalidate: () => component.invalidate(),
          handleInput: (data: string) => {
            component.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result && selected) {
        activeAutoModel = {
          provider: selected.provider,
          id: selected.id,
        };

        automodeConfig.modelIdentifier = activeAutoModel;

        ctx.ui.notify(
          `Auto mode classifier model set to ${selected.id} [${selected.provider}]`,
          "info",
        );
      }
    },
  });
}
