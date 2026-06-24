import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { classifyKnownCommand } from "../classifier/safe-command.js";
import { PermissionDialog } from "../ui/permission-dialog.js";

/**
 * Context type for permission handling, containing cwd, UI availability, and UI reference.
 */
type PermissionContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;

export type PermissionPrompt = {
  toolName: string;
  inputDescription: string;
};

/**
 * Set of tool names considered read-only (safe without permission).
 */
const READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Type guard checking whether an error is a file-not-found error.
 * @param error - The error to check.
 * @returns True if the error is an ENOENT error.
 */
const isNotFoundError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Resolves an existing path by walking up the directory tree until a real path is found.
 * @param targetPath - The path to resolve.
 * @returns The resolved real path.
 * @throws If no parent directory exists.
 */
const resolveExistingPath = async (targetPath: string): Promise<string> => {
  try {
    return await realpath(targetPath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    const parentPath = dirname(targetPath);
    if (parentPath === targetPath) {
      throw error;
    }

    return resolve(await resolveExistingPath(parentPath), basename(targetPath));
  }
};

/**
 * Checks whether childPath is inside (or equal to) parentPath.
 * @param parentPath - The parent directory path.
 * @param childPath - The child path to check.
 * @returns True if child is inside parent.
 */
const isInsidePath = (parentPath: string, childPath: string): boolean => {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
};

/**
 * Checks whether a target path resolves within the current working directory.
 * @param targetPath - Tool-provided path, relative to cwd or absolute.
 * @param cwd - Current working directory.
 * @returns True when the resolved target stays inside cwd.
 */
export const isPathWithinCwd = async (targetPath: string, cwd: string): Promise<boolean> => {
  const cwdRealPath = await realpath(cwd);
  const targetAbsolutePath = resolve(cwdRealPath, targetPath);
  const targetResolvedPath = await resolveExistingPath(targetAbsolutePath);
  return isInsidePath(cwdRealPath, targetResolvedPath);
};

/**
 * Extracts a string property from an object, returning undefined if absent or non-string.
 * @param input - The object to read from.
 * @param key - The property key.
 * @returns The string value, or undefined.
 */
const getStringProperty = (input: object, key: string): string | undefined => {
  if (!(key in input)) {
    return undefined;
  }

  const value = input[key as keyof typeof input];
  return typeof value === "string" ? value : undefined;
};

/**
 * Formats a tool call input into a human-readable description.
 * @param toolName - The name of the tool.
 * @param input - The tool input object.
 * @returns A formatted description string.
 */
const formatToolInput = (toolName: string, input: object): string => {
  switch (toolName) {
    case "edit":
    case "write": {
      const path = getStringProperty(input, "path");
      return path ? `path: ${path}` : "no path";
    }
    case "bash": {
      const command = getStringProperty(input, "command");
      return command ? truncateToWidth(command, 60) || "(empty command)" : "(no command)";
    }
    case "read": {
      const path = getStringProperty(input, "path");
      return path ? `path: ${path}` : "no path";
    }
    case "grep": {
      const pattern = getStringProperty(input, "pattern");
      const path = getStringProperty(input, "path");
      return `${pattern || "(no pattern)"}${path ? ` in ${path}` : ""}`;
    }
    case "find": {
      const path = getStringProperty(input, "path");
      return path ? `path: ${path}` : "no path";
    }
    case "ls": {
      const path = getStringProperty(input, "path");
      return path ? `path: ${path}` : "(current dir)";
    }
    default:
      return JSON.stringify(input);
  }
};

/**
 * Determines whether a tool call needs manual permission in non-automode mode.
 * @param event - The tool call event.
 * @param ctx - Extension context.
 * @returns Permission prompt metadata, or undefined when the tool call can run.
 */
export const getPermissionPrompt = async (
  event: ToolCallEvent,
  ctx: Pick<PermissionContext, "cwd">,
): Promise<PermissionPrompt | undefined> => {
  if (READONLY_TOOLS.has(event.toolName)) {
    return undefined;
  }

  if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
    if (await isPathWithinCwd(event.input.path, ctx.cwd)) {
      return undefined;
    }

    return {
      toolName: event.toolName,
      inputDescription: `Writing outside of cwd: ${formatToolInput(event.toolName, event.input)}`,
    };
  }

  if (isToolCallEventType("bash", event)) {
    if ((await classifyKnownCommand(event.input.command)) === "allow") {
      return undefined;
    }

    return {
      toolName: event.toolName,
      inputDescription: `Bash command requires approval:\n   ${formatToolInput(
        event.toolName,
        event.input,
      )}`,
    };
  }

  return undefined;
};

/**
 * Prompts the user for permission via a custom TUI dialog.
 * Blocks if no UI is available.
 * @param prompt - The permission prompt metadata.
 * @param ctx - Extension context.
 * @returns A promise resolving to the tool call result.
 */
const promptForPermission = async (
  prompt: PermissionPrompt,
  ctx: PermissionContext,
): Promise<ToolCallEventResult> => {
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: "This tool requires a user interface, but the current context does not have one.",
    };
  }

  return ctx.ui.custom<ToolCallEventResult>(
    (tui, theme, _keybindings, done) => {
      const dialog = new PermissionDialog(prompt.toolName, prompt.inputDescription, {
        fg: (color, text) => theme.fg(color, text),
        bg: (color, text) => theme.bg(color, text),
        bold: (text) => theme.bold(text),
      });

      dialog.onDone = (toolResult: ToolCallEventResult) => {
        done(toolResult);
      };

      return {
        render: (width: number) => dialog.render(width),
        invalidate: () => dialog.invalidate(),
        handleInput: (data: string) => dialog.handleInput(data, tui),
      };
    },
    { overlay: false, overlayOptions: { anchor: "bottom-center" } },
  );
};

/**
 * Handles tool permissions when automode is disabled.
 * @param event - The tool call event.
 * @param ctx - Extension context.
 * @returns Tool call allow/block decision.
 */
export const handlePermissionToolCall = async (
  event: ToolCallEvent,
  ctx: PermissionContext,
): Promise<ToolCallEventResult> => {
  const prompt = await getPermissionPrompt(event, ctx);
  if (!prompt) {
    return { block: false };
  }

  return promptForPermission(prompt, ctx);
};
