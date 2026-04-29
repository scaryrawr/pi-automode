import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { createClassifier } from "./classifier.js";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const classifier = createClassifier({
  authStorage,
  modelRegistry,
  modelIdentifier: {
    provider: "lmstudio",
    id: "qwen3.5-4b-mxfp8",
  },
});

const runClassification = async (command: string) => (await classifier).classify(command);

afterAll(async () => {
  (await classifier).dispose();
});

describe("when classifying safe commands with the real model", () => {
  it("should be fine for `git log`", async () => {
    const result = await runClassification("git log --oneline");

    expect(result.block).toBe(false);
  }, 120_000);
});

describe("when classifying dangerous commands with the real model", () => {
  it("should block rm -rf", async () => {
    const result = await runClassification("rm -rf *");

    expect(result.block).toBe(true);

    // Validate we actually could load up a model and classify through the tool call.
    expect(result.reason).not.toBe("Model not found");
    expect(result.reason).not.toBe("No classification result");
  }, 120_000);
});

describe("when classifying repeated commands with the real model", () => {
  it("should ask the model again for the repeated command", async () => {
    const firstResult = await runClassification("rm -rf *");
    const secondResult = await runClassification("rm -rf *");

    expect(firstResult.block).toBe(true);
    expect(secondResult.block).toBe(true);
    expect(secondResult.reason).not.toBe("Model not found");
    expect(secondResult.reason).not.toBe("No classification result");
  }, 120_000);
});
