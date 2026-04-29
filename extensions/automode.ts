import {
  type ExtensionAPI,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { classifyCommand } from "./classifier/classifier.js";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

export default async function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
    // Allow all non-bash tools by default
    if (!isToolCallEventType("bash", event)) {
      return { block: false };
    }

    return classifyCommand({
      authStorage,
      modelRegistry,
      modelIdentifier: {
        provider: "lmstudio",
        id: "qwen3.5-4b",
      },
      command: event.input.command,
    });
  });
}
