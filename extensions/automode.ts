import {
  type ExtensionAPI,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { createClassifier } from "./classifier/classifier.js";

export default async function (pi: ExtensionAPI) {
  type Classifier = Awaited<ReturnType<typeof createClassifier>>;
  let classifier: Promise<Classifier> | undefined;

  pi.on("session_shutdown", async () => {
    if (!classifier) {
      return;
    }

    (await classifier).dispose();
    classifier = undefined;
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
    // Allow all non-bash tools by default
    if (!isToolCallEventType("bash", event)) {
      return { block: false };
    }

    classifier ??= createClassifier({
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      modelIdentifier: {
        provider: "lmstudio",
        id: "qwen3.5-4b-mxfp8",
      },
    });

    return (await classifier).classify(event.input.command);
  });
}
