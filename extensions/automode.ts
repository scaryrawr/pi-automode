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
    // Allow all non-bash tools by default
    if (!isToolCallEventType("bash", event)) {
      return { block: false };
    }

    try {
      if (!automodeConfig.enabled) {
        return { block: false };
      }

      const lastUserPrompt = getLastUserPrompt(ctx.sessionManager.getBranch());
      return (await getClassifier(ctx)).classify(
        {
          command: event.input.command,
          lastUserPrompt,
        },
        ctx.signal,
      );
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  pi.registerCommand("auto", {
    description: "Control if auto mode is [on|off]",
    getArgumentCompletions: (prefix) => {
      const options: AutocompleteItem[] = [
        {
          value: "on",
          label: "on",
          description: "Enable auto mode for bash evaluation",
        },
        {
          value: "off",
          label: "off",
          description: "Disable auto mode for bash evaluation",
        },
        {
          value: "show",
          label: "show",
          description: "Show current auto mode status and model",
        },
      ];

      return options.filter((option) => option.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      switch (arg) {
        case "on":
          automodeConfig.enabled = true;
          ctx.ui.notify("Auto mode enabled", "info");
          break;
        case "off":
          automodeConfig.enabled = false;
          ctx.ui.notify("Auto mode disabled", "info");
          break;
        case "show": {
          const status = automodeConfig.enabled ? "enabled" : "disabled";
          const model = activeAutoModel
            ? `${activeAutoModel.id} [${activeAutoModel.provider}]`
            : "no model configured";
          ctx.ui.notify(`Auto mode is ${status}; model: ${model}`, "info");
          break;
        }
        default:
          automodeConfig.enabled = true;
          ctx.ui.notify("Auto mode enabled", "info");
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
