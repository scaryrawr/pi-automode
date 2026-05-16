/**
 * Pure utility functions to determine if a shell command has an obvious
 * classification without LLM classification.
 *
 * Commands must parse cleanly and every command node must be known-allowed before
 * a command is auto-approved. Known-block command nodes can be blocked
 * without asking the LLM.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { Language, Parser, type Node } from "web-tree-sitter";

export type KnownCommandClassification = "allow" | "block" | "unknown";

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | undefined;

const SAFE_COMMANDS = new Set([
  "awk",
  "bat",
  "cal",
  "cat",
  "date",
  "df",
  "diff",
  "du",
  "echo",
  "eza",
  "fd",
  "file",
  "free",
  "grep",
  "head",
  "htop",
  "id",
  "jq",
  "less",
  "ls",
  "more",
  "printenv",
  "printf",
  "ps",
  "pwd",
  "rg",
  "sort",
  "stat",
  "tail",
  "top",
  "tree",
  "type",
  "uname",
  "uniq",
  "uptime",
  "wc",
  "whereis",
  "which",
  "whoami",
]);

const DANGEROUS_COMMANDS = new Set([
  ".",
  "dd",
  "doas",
  "eval",
  "kill",
  "killall",
  "pkill",
  "reboot",
  "rm",
  "rmdir",
  "shred",
  "shutdown",
  "source",
  "su",
  "sudo",
  "truncate",
]);

const INTERACTIVE_EDITORS = new Set([
  "code",
  "emacs",
  "nano",
  "neovim",
  "nvim",
  "subl",
  "vi",
  "vim",
]);

const GIT_SAFE_SUBCOMMANDS = new Set([
  "add",
  "branch",
  "describe",
  "commit",
  "diff",
  "fetch",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "peek",
  "rev-list",
  "show",
  "status",
]);

const PACKAGE_SAFE_SUBCOMMANDS = new Map([
  ["npm", new Set(["audit", "info", "list", "ls", "outdated", "search", "show", "view"])],
  ["pip", new Set(["freeze", "inspect", "list", "show"])],
  ["yarn", new Set(["audit", "info", "list", "show", "why"])],
]);

const SHELL_COMMANDS = new Set(["bash", "sh", "zsh"]);
const VERSION_COMMANDS = new Set(["git", "node", "npm", "python"]);
const GIT_OPTIONS_WITH_VALUES = new Set([
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
  "-C",
  "-c",
]);

const createParser = async (): Promise<Parser> => {
  await Parser.init({
    locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm"),
  });

  const bashWasmPath = path.join(
    path.dirname(require.resolve("tree-sitter-bash/package.json")),
    "tree-sitter-bash.wasm",
  );
  const bash = await Language.load(bashWasmPath);
  const parser = new Parser();
  parser.setLanguage(bash);
  return parser;
};

const getParser = (): Promise<Parser> => {
  parserPromise ??= createParser().catch((error: unknown) => {
    parserPromise = undefined;
    throw error;
  });

  return parserPromise;
};

const isNode = (node: Node | null): node is Node => node !== null;

const normalizeCommandName = (commandName: string): string => {
  const trimmed = commandName.trim();
  const basename = trimmed.includes("/") ? path.posix.basename(trimmed) : trimmed;
  return basename.toLowerCase();
};

const getCommandParts = (commandNode: Node): { name: string; args: string[] } | undefined => {
  const name = commandNode.childForFieldName("name");
  if (!name) {
    return undefined;
  }

  return {
    name: normalizeCommandName(name.text),
    args: commandNode
      .childrenForFieldName("argument")
      .filter(isNode)
      .map((arg) => arg.text),
  };
};

const OUTPUT_REDIRECT_OPERATORS = new Set([">", ">>", ">|", ">&", ">&-", "&>", "&>>"]);

const getRedirectOperator = (redirect: Node): string | undefined =>
  redirect.children.filter(isNode).find((child) => OUTPUT_REDIRECT_OPERATORS.has(child.type))?.type;

const getLiteralRedirectDestination = (destination: Node | null): string | undefined => {
  if (!destination) {
    return undefined;
  }

  if (destination.type === "word") {
    return destination.text;
  }

  if (destination.type === "raw_string" || destination.type === "string") {
    const quote = destination.text[0];
    return (quote === "'" || quote === '"') && destination.text.endsWith(quote)
      ? destination.text.slice(1, -1)
      : undefined;
  }

  return undefined;
};

const isSafeOutputRedirect = (redirect: Node): boolean => {
  const operator = getRedirectOperator(redirect);
  if (!operator) {
    return true;
  }

  if (operator === ">&-" || operator === ">&") {
    const destination = redirect.childForFieldName("destination");
    if (operator === ">&-" || destination?.type === "number") {
      return true;
    }
  }

  return getLiteralRedirectDestination(redirect.childForFieldName("destination")) === "/dev/null";
};

const hasUnsafeOutputRedirect = (root: Node): boolean =>
  root
    .descendantsOfType("file_redirect")
    .filter(isNode)
    .some((redirect) => !isSafeOutputRedirect(redirect));

const getGitSubcommand = (args: string[]): string | undefined => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (GIT_OPTIONS_WITH_VALUES.has(arg)) {
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    return arg.toLowerCase();
  }

  return undefined;
};

const classifyGitCommand = (args: string[]): KnownCommandClassification => {
  if (args.includes("--version")) {
    return "allow";
  }

  const subcommand = getGitSubcommand(args);
  if (!subcommand) {
    return "unknown";
  }

  if (subcommand === "reset" && args.includes("--hard")) {
    return "block";
  }

  if (subcommand === "push") {
    return args.some((arg) => ["--delete", "--force", "--force-with-lease"].includes(arg))
      ? "block"
      : "unknown";
  }

  if (subcommand === "clean") {
    return args.some((arg) => arg.includes("f")) ? "block" : "unknown";
  }

  if (subcommand === "branch") {
    return args.some((arg) => arg === "-D" || arg.includes("D")) ? "block" : "allow";
  }

  if (subcommand === "commit" && args.includes("--amend")) {
    return "unknown";
  }

  if (subcommand === "switch") {
    return args.some((arg) => ["-C", "-f", "--discard-changes", "--force"].includes(arg))
      ? "unknown"
      : "allow";
  }

  if (subcommand === "rebase" || subcommand === "filter-branch") {
    return "block";
  }

  if (subcommand === "reflog" && args.includes("delete")) {
    return "block";
  }

  if (subcommand === "config") {
    return args.includes("--get") ? "allow" : "unknown";
  }

  if (subcommand === "tag") {
    return args.some((arg) => arg === "-l" || arg === "--list") ? "allow" : "unknown";
  }

  if (subcommand === "remote") {
    const remoteSubcommand = args[args.indexOf(subcommand) + 1];
    return !remoteSubcommand || ["-v", "get-url", "show"].includes(remoteSubcommand)
      ? "allow"
      : "unknown";
  }

  return GIT_SAFE_SUBCOMMANDS.has(subcommand) || subcommand.startsWith("ls-") ? "allow" : "unknown";
};

const classifyPackageCommand = (
  name: string,
  args: string[],
): KnownCommandClassification | undefined => {
  const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  if (!subcommand) {
    return undefined;
  }

  if (PACKAGE_SAFE_SUBCOMMANDS.get(name)?.has(subcommand)) {
    return "allow";
  }

  return undefined;
};

const classifyCommandNode = (commandNode: Node): KnownCommandClassification => {
  const parts = getCommandParts(commandNode);
  if (!parts) {
    return "unknown";
  }

  const { name, args } = parts;
  if (DANGEROUS_COMMANDS.has(name) || INTERACTIVE_EDITORS.has(name)) {
    return "block";
  }

  if (SHELL_COMMANDS.has(name)) {
    return args.includes("-c") ? "block" : "unknown";
  }

  if (name === "systemctl") {
    return args.some((arg) =>
      ["disable", "enable", "mask", "restart", "start", "stop", "unmask"].includes(arg),
    )
      ? "block"
      : "unknown";
  }

  if (name === "service") {
    return args.some((arg) => ["reload", "restart", "start", "stop"].includes(arg))
      ? "block"
      : "unknown";
  }

  if (name === "git") {
    return classifyGitCommand(args);
  }

  const packageClassification = classifyPackageCommand(name, args);
  if (packageClassification) {
    return packageClassification;
  }

  if (VERSION_COMMANDS.has(name) && args.some((arg) => arg === "--version" || arg === "-v")) {
    return "allow";
  }

  if (name === "sed") {
    return args[0]?.startsWith("-n") === true && !args.some((arg) => arg.includes("i"))
      ? "allow"
      : "unknown";
  }

  if (name === "find") {
    if (args.includes("-delete")) {
      return "block";
    }

    return args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))
      ? "unknown"
      : "allow";
  }

  if (name === "awk") {
    return args.some((arg) => arg.includes("system(")) ? "unknown" : "allow";
  }

  return SAFE_COMMANDS.has(name) ? "allow" : "unknown";
};

/**
 * Classifies a shell command when its AST is clearly known-allowed or known-block.
 * @param command - The shell command to evaluate.
 * @returns The known classification, or `"unknown"` if the command should be sent to the LLM.
 */
export async function classifyKnownCommand(command: string): Promise<KnownCommandClassification> {
  const parser = await getParser();
  const tree = parser.parse(command);
  if (!tree) {
    return "unknown";
  }

  try {
    const root = tree.rootNode;
    if (root.hasError || hasUnsafeOutputRedirect(root)) {
      return "unknown";
    }

    const commandNodes = root.descendantsOfType("command").filter(isNode);
    if (commandNodes.length === 0) {
      return "unknown";
    }

    let sawUnknown = false;
    for (const commandNode of commandNodes) {
      const classification = classifyCommandNode(commandNode);
      if (classification === "block") {
        return "block";
      }

      if (classification === "unknown") {
        sawUnknown = true;
      }
    }

    return sawUnknown ? "unknown" : "allow";
  } finally {
    tree.delete();
  }
}

/**
 * Determines if a shell command is allowed to run without LLM classification.
 * @param command - The shell command to evaluate.
 * @returns `true` if the command is clearly allowed (read-only, benign); `false` otherwise.
 */
export async function isAllowedCommand(command: string): Promise<boolean> {
  return (await classifyKnownCommand(command)) === "allow";
}
