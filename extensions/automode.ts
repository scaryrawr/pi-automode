import type { Model } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import {
  getClassifierModelIdentifier,
  persistClassifierModelIdentifier,
} from "./automode/config.js";
import type { ModelIdentifier } from "./automode/types.js";
import { type Classifier, createClassifier } from "./classifier/classifier.js";
import { ModelSelectorComponent } from "./ui/model-selector.js";

type ClassifierContext = Pick<ExtensionContext, "modelRegistry">;

export default async function (pi: ExtensionAPI) {
  let selectedModelIdentifier: ModelIdentifier | undefined;
  let classifier: Promise<Classifier> | undefined;

  /**
   * Disposes the current classifier instance, if one exists.
   * Resets the classifier promise to allow recreation on next use.
   */
  const disposeClassifier = async () => {
    const classifierToDispose = classifier;
    classifier = undefined;

    if (!classifierToDispose) {
      return;
    }

    try {
      (await classifierToDispose).dispose();
    } catch {
      // Ignore classifier startup/disposal errors here. Tool-call handling reports creation failures.
    }
  };

  /**
   * Gets the classifier instance, creating it lazily if it doesn't exist.
   * Clears the cached classifier on error to allow retry on next call.
   * @param ctx - The classifier context containing the model registry.
   * @returns The resolved classifier instance.
   * @throws If classifier creation fails.
   */
  const getClassifier = async (ctx: ClassifierContext): Promise<Classifier> => {
    if (!selectedModelIdentifier) {
      throw new Error("Cannot find usable model");
    }

    classifier ??= createClassifier({
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      modelIdentifier: selectedModelIdentifier,
    });

    try {
      return await classifier;
    } catch (error) {
      classifier = undefined;
      throw error;
    }
  };

  pi.on("session_start", async () => {
    selectedModelIdentifier = getClassifierModelIdentifier();
  });

  pi.on("session_shutdown", async () => {
    await disposeClassifier();
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
    // Allow all non-bash tools by default
    if (!isToolCallEventType("bash", event)) {
      return { block: false };
    }

    try {
      return (await getClassifier(ctx)).classify(event.input.command);
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
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

      let selected: Model<any> | undefined;

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const component = new ModelSelectorComponent(tui, theme, {
          currentModel: ctx.model,
          modelRegistry: ctx.modelRegistry,
          onSelect: (model: Model<any>) => {
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
        selectedModelIdentifier = {
          provider: selected.provider,
          id: selected.id,
        };

        persistClassifierModelIdentifier(selectedModelIdentifier);
        await disposeClassifier();

        ctx.ui.notify(
          `Auto mode classifier model set to ${selected.id} [${selected.provider}]`,
          "info",
        );
      }
    },
  });
}
