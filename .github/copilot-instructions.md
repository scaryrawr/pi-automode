# Copilot Instructions for pi-automode

## Repo Reference

Shared guidance is in [`AGENTS.md`](../AGENTS.md). See it for architecture, conventions, build/test commands, and safety rules.

## Classification Logic

When modifying `extensions/classifier/classifier.ts`, note:

- The classifier creates an **in-memory agent session** with a custom `classify_shell_command` tool.
- Commands are classified as `"safe"`, `"ask"`, or `"dangerous"` and the result is delivered via a **deferred promise** pattern.
- The `findPendingClassification` helper matches by `requestId` first, then falls back to exact `command` match (only if unique).
- The prompt sent to the model uses XML tags: `<shell-command>${command}</shell-command>`.

## Extension Entry

`extensions/automode.ts` is the extension entry point. It:

- Listens to `session_start`, `session_shutdown`, and `tool_call` events.
- Non-bash tools pass through unblocked.
- The `automodel` command uses `ctx.ui.select()` for model picker.

## Testing

Tests in `extensions/classifier/classifier.test.ts` are **integration tests** that require a real local model (lmstudio). They have 120s timeouts. Run with `npm test`.
