import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { getPermissionPrompt, isPathWithinCwd } from "./permissions.js";

const createWorkspace = async () => mkdtemp(join(tmpdir(), "pi-automode-permissions-"));

describe("when checking permission path containment", () => {
  it("should allow existing files inside cwd", async () => {
    const cwd = await createWorkspace();
    const filePath = join(cwd, "file.txt");
    await writeFile(filePath, "content");

    await expect(isPathWithinCwd("file.txt", cwd)).resolves.toBe(true);
  });

  it("should allow new files inside cwd", async () => {
    const cwd = await createWorkspace();

    await expect(isPathWithinCwd("new-dir/file.txt", cwd)).resolves.toBe(true);
  });

  it("should reject paths outside cwd", async () => {
    const cwd = await createWorkspace();
    const outside = await createWorkspace();

    await expect(isPathWithinCwd(join(outside, "file.txt"), cwd)).resolves.toBe(false);
  });

  it("should reject paths that escape through symlinks", async () => {
    const cwd = await createWorkspace();
    const outside = await createWorkspace();
    await symlink(outside, join(cwd, "outside-link"));

    await expect(isPathWithinCwd("outside-link/file.txt", cwd)).resolves.toBe(false);
  });
});

describe("when deciding disabled-automode permission prompts", () => {
  it("should allow read-only tools without prompting", async () => {
    const cwd = await createWorkspace();
    const event = {
      type: "tool_call",
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "package.json" },
    } satisfies ToolCallEvent;

    await expect(getPermissionPrompt(event, { cwd })).resolves.toBeUndefined();
  });

  it("should allow safe bash commands without prompting", async () => {
    const cwd = await createWorkspace();
    const event = {
      type: "tool_call",
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "git status --short" },
    } satisfies ToolCallEvent;

    await expect(getPermissionPrompt(event, { cwd })).resolves.toBeUndefined();
  });

  it("should prompt for unsafe bash commands", async () => {
    const cwd = await createWorkspace();
    const event = {
      type: "tool_call",
      toolCallId: "bash-2",
      toolName: "bash",
      input: { command: "rm -rf build" },
    } satisfies ToolCallEvent;

    await expect(getPermissionPrompt(event, { cwd })).resolves.toMatchObject({
      toolName: "bash",
    });
  });

  it("should allow writes inside cwd without prompting", async () => {
    const cwd = await createWorkspace();
    await mkdir(join(cwd, "src"));
    const event = {
      type: "tool_call",
      toolCallId: "write-1",
      toolName: "write",
      input: { path: "src/new-file.txt", content: "content" },
    } satisfies ToolCallEvent;

    await expect(getPermissionPrompt(event, { cwd })).resolves.toBeUndefined();
  });

  it("should prompt for writes outside cwd", async () => {
    const cwd = await createWorkspace();
    const event = {
      type: "tool_call",
      toolCallId: "write-2",
      toolName: "write",
      input: { path: resolve(cwd, "..", "outside.txt"), content: "content" },
    } satisfies ToolCallEvent;

    await expect(getPermissionPrompt(event, { cwd })).resolves.toMatchObject({
      toolName: "write",
    });
  });
});
