import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { classifyCommand } from "./classifier.js";
import { expect, describe, it } from "vitest";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const runClassification = (command: string) =>
  classifyCommand({
    authStorage,
    modelRegistry,
    modelIdentifier: {
      provider: "lmstudio",
      id: "qwen3.5-4b",
    },
    command,
  });

describe("when classifiying safe commands", () => {
  it("should be fine for `git log`", async () => {
    const result = await runClassification("git log --oneline");
    console.log(result);
    expect(result.block).toBe(false);
  });
});

describe("when classifying dangerous commands", () => {
  it("should block rm -rf", async () => {
    const result = await runClassification("rm -rf *");

    console.log(result);

    expect(result.block).toBe(true);

    // Validate we actually could load up a model and validate
    expect(result.reason).not.toBe("Model not found");
    expect(result.reason).not.toBe("No classification result");
  });
});
