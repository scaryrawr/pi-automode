import type { Api, Model, UserMessage } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { AutomodeConfigManager } from "./automode/config.js";
import { createClassifier } from "./classifier/classifier.js";
import { ModelSelectorComponent } from "./ui/model-selector.js";

type ClassifierContext = Pick<ExtensionContext, "modelRegistry">;

/**
 * Convert user message content to plain text for classifier input.
 * @param content - The content of a user message, which can be a string or an array of text/image blocks.
 * @returns The extracted plain text from the user message content, concatenating text blocks if necessary.
 */
const userPrompt = (content: UserMessage["content"]): string => {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
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

      const lastUserEntry = ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "user");
      const prompt =
        lastUserEntry?.type === "message" && lastUserEntry.message.role === "user"
          ? userPrompt(lastUserEntry.message.content)
          : undefined;
      return (await getClassifier(ctx)).classify(
        {
          command: event.input.command,
          prompt,
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
