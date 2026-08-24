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

  it("should defer dangerous commands to the LLM when static blocking is disabled", async () => {
    await expect(
      classifyKnownCommand("rm -rf investigation-files", { blockDangerousCommands: false }),
    ).resolves.toBe("unknown");
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

  it("should allow cleanup of paths inside cwd under static blocking", async () => {
    await expect(classifyKnownCommand("rm -rf node_modules")).resolves.toBe("allow");
    await expect(classifyKnownCommand("rm -rf dist __pycache__ coverage")).resolves.toBe(
      "allow",
    );
    await expect(classifyKnownCommand("rm -rf ./node_modules/")).resolves.toBe("allow");
    await expect(classifyKnownCommand("rm -rf build/")).resolves.toBe("allow");
    await expect(classifyKnownCommand("rm -rf dist/*")).resolves.toBe("allow");
    await expect(classifyKnownCommand("rm __pycache__ -rf")).resolves.toBe("allow");
    await expect(classifyKnownCommand("rm src/main.ts")).resolves.toBe("allow");
    await expect(classifyKnownCommand("rmdir .next")).resolves.toBe("allow");
  });

  it("should still block cleanup of paths outside cwd", async () => {
    await expect(classifyKnownCommand("rm -rf ../outside")).resolves.toBe("block");
    await expect(classifyKnownCommand("rm -rf ../../etc/passwd")).resolves.toBe(
      "block",
    );
    await expect(classifyKnownCommand("rm -rf /tmp/secret")).resolves.toBe("block");
    await expect(classifyKnownCommand("rm -rf ~/secrets")).resolves.toBe("block");
  });

  it("should honour the cwd option when deciding whether cleanup is local", async () => {
    // `../project/x` looks like it escapes, but relative to this cwd it stays inside.
    await expect(
      classifyKnownCommand("rm -rf ../project/x", { cwd: "/home/user/project" }),
    ).resolves.toBe("allow");
  });
});
