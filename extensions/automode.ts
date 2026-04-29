import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_CLASSIFIER_MODEL_IDENTIFIER,
  loadClassifierModelIdentifier,
  persistClassifierModelIdentifier,
} from "./automode/settings.js";
import type { ModelIdentifier } from "./automode/types.js";
import { createClassifier } from "./classifier/classifier.js";

type Classifier = Awaited<ReturnType<typeof createClassifier>>;

type ClassifierContext = Pick<ExtensionContext, "cwd" | "modelRegistry">;

export default async function (pi: ExtensionAPI) {
  let selectedModelIdentifier: ModelIdentifier | undefined;
  let classifier: Promise<Classifier> | undefined;

  const getSelectedModelIdentifier = (cwd: string) => {
    selectedModelIdentifier ??= loadClassifierModelIdentifier(cwd);
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
    const configuredModelIdentifier = getSelectedModelIdentifier(ctx.cwd);
    if (ctx.modelRegistry.find(configuredModelIdentifier.provider, configuredModelIdentifier.id)) {
      return configuredModelIdentifier;
    }

    if (
      ctx.modelRegistry.find(
        DEFAULT_CLASSIFIER_MODEL_IDENTIFIER.provider,
        DEFAULT_CLASSIFIER_MODEL_IDENTIFIER.id,
      )
    ) {
      return DEFAULT_CLASSIFIER_MODEL_IDENTIFIER;
    }

    return configuredModelIdentifier;
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

  pi.on("session_start", async (_event, ctx) => {
    selectedModelIdentifier = loadClassifierModelIdentifier(ctx.cwd);
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

      const settingsErrors = await persistClassifierModelIdentifier(ctx.cwd, selectedModelIdentifier);
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
