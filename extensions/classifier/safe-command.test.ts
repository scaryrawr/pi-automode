import { describe, expect, it } from "vitest";

import { classifyKnownCommand, isAllowedCommand } from "./safe-command.js";

describe("when classifying known shell commands with tree-sitter", () => {
  it("should consider read-only git commands allowed", async () => {
    await expect(isAllowedCommand("git status --short")).resolves.toBe(true);
  });

  it("should consider allowed pipelines allowed", async () => {
    await expect(
      isAllowedCommand("grep TODO extensions/classifier/*.ts | sort | uniq"),
    ).resolves.toBe(true);
  });

  it("should not treat dangerous words in arguments as blocked commands", async () => {
    await expect(isAllowedCommand('echo "rm -rf *"')).resolves.toBe(true);
  });

  it("should detect blocked commands in command substitutions", async () => {
    await expect(classifyKnownCommand("echo $(rm -rf *)")).resolves.toBe("block");
  });

  it("should detect blocked commands in command lists", async () => {
    await expect(classifyKnownCommand("git status && rm -rf *")).resolves.toBe("block");
  });

  it("should not auto-approve commands with output redirection to real files", async () => {
    await expect(classifyKnownCommand("echo hi > output.txt")).resolves.toBe("unknown");
    await expect(classifyKnownCommand("echo hi 2>/tmp/errors.log")).resolves.toBe("unknown");
    await expect(classifyKnownCommand("echo hi 2>&1 > output.txt")).resolves.toBe("unknown");
  });

  it("should allow output redirection that does not write real files", async () => {
    await expect(classifyKnownCommand("echo hi 2>&1")).resolves.toBe("allow");
    await expect(classifyKnownCommand("echo hi 2>/dev/null")).resolves.toBe("allow");
    await expect(classifyKnownCommand("echo hi >/dev/null 2>&1")).resolves.toBe("allow");
    await expect(classifyKnownCommand("echo hi &>/dev/null")).resolves.toBe("allow");
    await expect(classifyKnownCommand('echo hi > "/dev/null"')).resolves.toBe("allow");
  });

  it("should leave package manager write commands for the model", async () => {
    await expect(classifyKnownCommand("npm run build")).resolves.toBe("unknown");
  });

  it("should detect destructive git commands", async () => {
    await expect(classifyKnownCommand("git reset --hard HEAD")).resolves.toBe("block");
  });
});
