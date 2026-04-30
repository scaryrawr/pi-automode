// stolen from https://github.com/badlogic/pi-mono/blob/156a9052bc08a5ed08b7f2b82a27796253c4760d/packages/coding-agent/examples/extensions/plan-mode/utils.ts
/**
 * Pure utility function to determine if a shell command is safe to run
 * without LLM classification.
 *
 * Commands must match at least one safe pattern AND no destructive patterns.
 * This is a conservative list — read-only commands and benign git operations.
 */

// Commands that are clearly safe — read-only, listing, or benign operations
const SAFE_PATTERNS: RegExp[] = [
  // Read-only file reading
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*bat\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,

  // Search and list
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*jq\b/,
  /^\s*sed\s+-n\b/,
  /^\s*awk\b/,
  /^\s*eza\b/,

  // Git read-only operations
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|ls-tree|tag\s+-l|fetch|describe|for-each-ref|rev-list|peek)\b/i,
  /^\s*git\s+ls-\w+/i,

  // Package manager listing (read-only)
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit|show)\b/i,
  /^\s*yarn\s+(list|info|why|audit|show)\b/i,
  /^\s*pip\s+(list|show|freeze|inspect)\b/i,

  // Version checks
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*npm\s+--version/i,
  /^\s*git\s+--version/i,
];

// Commands that are clearly dangerous — destructive, privileged, or risky
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // File deletion/modification
  /\brm\b/i,
  /\brmdir\b/i,
  /\bshred\b/i,
  /\bdd\b/i,
  /\btruncate\b/i,

  // File move/copy/creation (outside of safe git context)
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,

  // Redirection (can overwrite files)
  /(^|[^<])>(?!>)/,
  /\b>\s*\/etc\//i,
  /\b>\s*\/root\//i,
  /\b>>\s*\/etc\//i,

  // Package installation/removal
  /\bnpm\s+(install|uninstall|update|ci|link|publish|exec|run)\b/i,
  /\byarn\s+(add|remove|install|publish|run|exec)\b/i,
  /\bpnpm\s+(add|remove|install|publish|exec|run)\b/i,
  /\bpip\s+(install|uninstall|upgrade|compile)\b/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade|dist-upgrade)\b/i,
  /\bbrew\s+(install|uninstall|upgrade|update|cleanup|pin|unpin)\b/i,

  // Git destructive operations
  /\bgit\s+(reset|rebase|filter-branch|reflog\s+delete)\b/i,
  /\bgit\s+push\s+(--force|--force-with-lease)\b/i,
  /\bgit\s+push\s+--delete\b/i,
  /\bgit\s+push\s+--force-with-lease\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bgit\s+clean\s+-fdx\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+branch\s+-d\s+.*\s+-D\b/i,
  /\bgit\s+checkout\s+-b\b/i,
  /\bgit\s+switch\s+-c\b/i,

  // Privilege escalation
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bdoas\b/i,

  // Process killing / system control
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask)\b/i,
  /\bservice\s+\S+\s+(start|stop|restart|reload)\b/i,

  // Interactive editors / code
  /\b(vim?|nano|emacs|code|subl|neovim|nvim)\b/i,

  // Shell execution / eval
  /\beval\b/i,
  /\bsource\s+/i,
  /\b\.s?\s+/i,
  /\bsh\s+-c\b/i,
  /\bbash\s+-c\b/i,
  /\bzsh\s+-c\b/i,
  /\bwget\s+-O\b/i,
];

/**
 * Determines if a shell command is safe to run without LLM classification.
 * @param command - The shell command to evaluate.
 * @returns `true` if the command is clearly safe (read-only, benign); `false` otherwise.
 */
export function isSafeCommand(command: string): boolean {
  const matchesSafe = SAFE_PATTERNS.some((p) => p.test(command));
  const matchesDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  return matchesSafe && !matchesDestructive;
}
