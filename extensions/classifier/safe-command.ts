/**
 * Pure utility functions to determine if a shell command has an obvious
 * classification without LLM classification.
 *
 * Commands must parse cleanly and every command node must be known-allowed before
 * a command is auto-approved. Known-block command nodes can be blocked without
 * asking the LLM when static blocking is enabled.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { Language, Parser, type Node } from "web-tree-sitter";

/**
 * Classification result for a shell command that can be evaluated without LLM classification.
 * "allow" means safe to run, "block" means dangerous, "unknown" requires LLM review.
 */
export type KnownCommandClassification = "allow" | "block" | "unknown";

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | undefined;

/**
 * Set of shell commands considered safe (read-only, benign utilities).
 */
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

/**
 * Set of destructive file commands (deletion/truncation). Under static blocking,
 * these are only auto-approved when every target lives inside the current working
 * directory; anything outside cwd is treated as suspicious and deferred/blocked.
 */
const DESTRUCTIVE_FILE_COMMANDS = new Set(["rm", "rmdir", "shred", "truncate"]);

/**
 * Set of shell commands considered dangerous (destructive, privilege escalation, etc.).
 */
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

/**
 * Set of interactive text editor commands (blocking because they hijack the terminal).
 */
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

/**
 * Set of git subcommands considered safe (read-only operations, local commits, etc.).
 */
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

/**
 * Map of package manager names to their safe (read-only) subcommands.
 */
const PACKAGE_SAFE_SUBCOMMANDS = new Map([
  ["npm", new Set(["audit", "info", "list", "ls", "outdated", "search", "show", "view"])],
  ["pip", new Set(["freeze", "inspect", "list", "show"])],
  ["yarn", new Set(["audit", "info", "list", "show", "why"])],
]);

/**
 * Resolves a destructive-file-command target against cwd and returns whether it
 * lives inside the current working directory. Quotes and glob metacharacters are
 * stripped so globs like "dist/*" collapse to their prefix ("dist"). Paths that
 * can't be guaranteed inside cwd (empty, brace/tilde expansions like "~") and any
 * path outside cwd — including absolute paths — are reported as not contained, so
 * cleanup there is treated as suspicious.
 * @param target - The raw target argument text from the command.
 * @param cwd - The current working directory to resolve relative targets against.
 * @returns True when the target resolves to a location strictly within cwd.
 */
const isTargetInsideCwd = (target: string, cwd: string): boolean => {
  const cleaned = target.replace(/['"`]/g, "");
  if (cleaned === "" || cleaned.includes("~")) {
    return false;
  }

  const withoutGlobs = cleaned.replace(/[?*[]/g, "");
  const resolved = path.resolve(
    path.isAbsolute(withoutGlobs) ? withoutGlobs : cwd,
    withoutGlobs,
  );

  const normalizedCwd = path.resolve(cwd);
  return resolved.startsWith(normalizedCwd + path.sep);
};

/**
 * Determines whether a destructive file command only targets paths inside cwd,
 * in which case it is treated as safe local cleanup. Anything outside cwd is
 * considered suspicious and left for blocking/LLM review.
 * @param name - The normalized command name.
 * @param args - The command arguments.
 * @param cwd - The current working directory to resolve targets against.
 * @returns True when the command deletes only paths within cwd.
 */
const isSafeLocalCleanup = (
  name: string,
  args: string[],
  cwd: string,
): boolean => {
  if (!DESTRUCTIVE_FILE_COMMANDS.has(name)) {
    return false;
  }

  const targets = args.filter((arg) => arg && !arg.startsWith("-"));
  // A destructive command with no resolvable targets (e.g. `rm -i`) is not treated
  // as cleanup; the caller keeps its default handling.
  if (targets.length === 0) {
    return false;
  }

  return targets.every((target) => isTargetInsideCwd(target, cwd));
};

/**
 * Set of shell interpreters (executing code via -c is dangerous).
 */
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh"]);
/**
 * Set of commands that are safe when invoked with --version/-v flags.
 */
const VERSION_COMMANDS = new Set(["git", "node", "npm", "python"]);
/**
 * Set of git options that take a value argument (skip the next arg during subcommand detection).
 */
const GIT_OPTIONS_WITH_VALUES = new Set([
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
  "-C",
  "-c",
]);

/**
 * Lazily initializes and returns a tree-sitter Parser configured for bash.
 * @returns A promise resolving to the configured bash parser.
 */
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

/**
 * Returns the lazily-initialized bash parser, caching it for reuse.
 * @returns A promise resolving to the configured bash parser.
 */
const getParser = (): Promise<Parser> => {
  parserPromise ??= createParser().catch((error: unknown) => {
    parserPromise = undefined;
    throw error;
  });

  return parserPromise;
};

/**
 * Type guard checking whether a tree-sitter Node is non-null.
 * @param node - The node to check.
 * @returns True when the node is non-null.
 */
const isNode = (node: Node | null): node is Node => node !== null;

/**
 * Normalizes a command name by trimming whitespace and extracting the basename,
 * then lowercasing it.
 * @param commandName - Raw command name from the AST.
 * @returns The normalized (lowercase, basename) command name.
 */
const normalizeCommandName = (commandName: string): string => {
  const trimmed = commandName.trim();
  const basename = trimmed.includes("/") ? path.posix.basename(trimmed) : trimmed;
  return basename.toLowerCase();
};

/**
 * Extracts the command name and arguments from a tree-sitter command node.
 * @param commandNode - The tree-sitter command node.
 * @returns An object with the normalized command name and argument strings, or undefined if no name exists.
 */
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

/**
 * Set of output redirect operators that redirect to a file path.
 */
const OUTPUT_REDIRECT_OPERATORS = new Set([">", ">>", ">|", ">&", ">&-", "&>", "&>>"]);

/**
 * Extracts the redirect operator type from a redirect node.
 * @param redirect - The tree-sitter redirect node.
 * @returns The operator type string, or undefined if no operator is found.
 */
const getRedirectOperator = (redirect: Node): string | undefined =>
  redirect.children.filter(isNode).find((child) => OUTPUT_REDIRECT_OPERATORS.has(child.type))?.type;

/**
 * Extracts a literal redirect destination (file path) from a redirect node.
 * Handles word, raw_string, and string node types.
 * @param destination - The tree-sitter destination node.
 * @returns The literal destination string, or undefined if not extractable.
 */
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

/**
 * Determines whether an output redirect is safe (redirects to /dev/null or fd-only).
 * @param redirect - The tree-sitter file redirect node.
 * @returns True if the redirect is safe.
 */
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

/**
 * Checks whether any file redirect in a command tree is unsafe.
 * @param root - The tree-sitter root node of the parsed command.
 * @returns True if any redirect is unsafe.
 */
const hasUnsafeOutputRedirect = (root: Node): boolean =>
  root
    .descendantsOfType("file_redirect")
    .filter(isNode)
    .some((redirect) => !isSafeOutputRedirect(redirect));

/**
 * Extracts the git subcommand from an argument list, skipping options with values.
 * @param args - The command arguments.
 * @returns The git subcommand (lowercase), or undefined if none found.
 */
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

/**
 * Classifies a git command based on its subcommand and arguments.
 * @param args - The git command arguments.
 * @returns The classification result.
 */
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

/**
 * Classifies a package manager command based on its subcommand.
 * @param name - The package manager name (npm, pip, yarn).
 * @param args - The command arguments.
 * @returns The classification result, or undefined if not a known package manager.
 */
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

/**
 * Classifies a single command node (one command in a pipeline/chain).
 * Handles destructive commands (local cleanup is allowed only inside cwd),
 * interactive editors, shells, systemctl, service, git, package managers, sed,
 * find, awk, and version flags.
 * @param commandNode - The tree-sitter command node.
 * @param blockDangerousCommands - Whether commands in DANGEROUS_COMMANDS should
 * be statically blocked instead of sent to the LLM.
 * @param cwd - The current working directory; destructive commands targeting
 * paths outside cwd are treated as suspicious.
 * @returns The classification result.
 */
const classifyCommandNode = (
  commandNode: Node,
  blockDangerousCommands: boolean,
  cwd: string,
): KnownCommandClassification => {
  const parts = getCommandParts(commandNode);
  if (!parts) {
    return "unknown";
  }

  const { name, args } = parts;
  if (DANGEROUS_COMMANDS.has(name)) {
    // Cleanup is safe only when every target stays inside cwd; paths outside the
    // working directory are treated as suspicious and blocked/deferred as before.
    if (blockDangerousCommands && isSafeLocalCleanup(name, args, cwd)) {
      return "allow";
    }

    return blockDangerousCommands ? "block" : "unknown";
  }

  if (INTERACTIVE_EDITORS.has(name)) {
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
 * @param options - Classification options.
 * @param options.blockDangerousCommands - Statically block DANGEROUS_COMMANDS.
 * Defaults to true for the static safety filter; the LLM-backed auto mode sets
 * this to false so the model can consider the command and user intent.
 * @param options.cwd - The current working directory used to decide whether a
 * destructive command targets paths inside the project. Defaults to process.cwd().
 * @returns The known classification, or `"unknown"` if the command should be sent to the LLM.
 */
export async function classifyKnownCommand(
  command: string,
  options: { blockDangerousCommands?: boolean; cwd?: string } = {},
): Promise<KnownCommandClassification> {
  const blockDangerousCommands = options.blockDangerousCommands ?? true;
  const cwd = options.cwd ?? process.cwd();
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
      const classification = classifyCommandNode(commandNode, blockDangerousCommands, cwd);
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
