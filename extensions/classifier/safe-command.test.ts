import { describe, expect, it } from "vitest";

import { classifyKnownCommand, isSafeCommand } from "./safe-command.js";

describe("when classifying known shell commands with tree-sitter", () => {
  it("should consider read-only git commands safe", async () => {
    await expect(isSafeCommand("git status --short")).resolves.toBe(true);
  });

  it("should consider safe pipelines safe", async () => {
    await expect(isSafeCommand("grep TODO extensions/classifier/*.ts | sort | uniq")).resolves.toBe(
      true,
    );
  });

  it("should not treat dangerous words in arguments as dangerous commands", async () => {
    await expect(isSafeCommand('echo "rm -rf *"')).resolves.toBe(true);
  });

  it("should detect dangerous commands in command substitutions", async () => {
    await expect(classifyKnownCommand("echo $(rm -rf *)")).resolves.toBe("dangerous");
  });

  it("should detect dangerous commands in command lists", async () => {
    await expect(classifyKnownCommand("git status && rm -rf *")).resolves.toBe("dangerous");
  });

  it("should not auto-approve commands with output redirection", async () => {
    await expect(classifyKnownCommand("echo hi > output.txt")).resolves.toBe("unknown");
  });

  it("should leave package manager write commands for the model", async () => {
    await expect(classifyKnownCommand("npm run build")).resolves.toBe("unknown");
  });

  it("should detect destructive git commands", async () => {
    await expect(classifyKnownCommand("git reset --hard HEAD")).resolves.toBe("dangerous");
  });
});
