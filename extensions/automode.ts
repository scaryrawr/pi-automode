import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import {
  loadClassifierModelIdentifier,
  persistClassifierModelIdentifier,
} from "./automode/config.js";
import type { ModelIdentifier } from "./automode/types.js";
import { createClassifier } from "./classifier/classifier.js";

type Classifier = Awaited<ReturnType<typeof createClassifier>>;

type ClassifierContext = Pick<ExtensionContext, "modelRegistry">;

export default async function (pi: ExtensionAPI) {
  let selectedModelIdentifier: ModelIdentifier | undefined;
  let classifier: Promise<Classifier> | undefined;

  const getSelectedModelIdentifier = () => {
    selectedModelIdentifier ??= loadClassifierModelIdentifier();
    return selectedModelIdentifier;
  };

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

  const resolveClassifierModelIdentifier = (ctx: ClassifierContext) => {
    const configuredModelIdentifier = getSelectedModelIdentifier();
    if (!configuredModelIdentifier) {
      throw new Error(
        "No automode classifier model configured. Run /automodel to select one.",
      );
    }

    if (ctx.modelRegistry.find(configuredModelIdentifier.provider, configuredModelIdentifier.id)) {
      return configuredModelIdentifier;
    }

    throw new Error(
      `Classifier model ${configuredModelIdentifier.id} [${configuredModelIdentifier.provider}] is not available`,
    );
  };

  const getClassifier = async (ctx: ClassifierContext) => {
    classifier ??= createClassifier({
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      modelIdentifier: resolveClassifierModelIdentifier(ctx),
    });

    try {
      return await classifier;
    } catch (error) {
      classifier = undefined;
      throw error;
    }
  };

  pi.on("session_start", async () => {
    selectedModelIdentifier = loadClassifierModelIdentifier();
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
    handler: async (_args, ctx) => {
      const models = ctx.modelRegistry.getAvailable();
      const normalize = (m: (typeof models)[number]) => `${m.id} [${m.provider}]`;
      const modelSelection = await ctx.ui.select("Select auto mode model", models.map(normalize));

      const model = models.find((m) => normalize(m) === modelSelection);
      if (!model) {
        return;
      }

      selectedModelIdentifier = {
        provider: model.provider,
        id: model.id,
      };

      const settingsErrors = persistClassifierModelIdentifier(selectedModelIdentifier);
      await disposeClassifier();

      if (settingsErrors.length > 0) {
        ctx.ui.notify(
          `Auto mode model selected, but failed to persist settings: ${settingsErrors
            .map(({ scope, error }) => `${scope}: ${error.message}`)
            .join("; ")}`,
          "error",
        );
        return;
      }

      ctx.ui.notify(`Auto mode classifier model set to ${model.id} [${model.provider}]`, "info");
    },
  });
}
