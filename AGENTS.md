# pi-automode

## Architecture

This repo implements the **automode extension** for the pi coding agent — an AI-driven shell command classifier that evaluates `bash` tool calls before execution, returning `{ block: true/false }` with an optional reason.

**Extension structure:**

- `extensions/automode.ts` — Extension entry point. Registers the `automodel` command and subscribes to `tool_call` events, delegating bash commands to the classifier.
- `extensions/automode/config.ts` — Reads/writes `automode.json` from the agent's config directory. Uses TypeBox for schema validation.
- `extensions/automode/types.ts` — Shared type: `ModelIdentifier = { provider: string, id: string }`.
- `extensions/classifier/classifier.ts` — Core classifier: uses direct model completion with a custom `classify_shell_command` tool. The model classifies commands as `allow` or `block` and returns a `ToolCallEventResult`.
- `extensions/permissions/permissions.ts` — Manual permission fallback used when `/auto off`: read-only/safe calls pass, risky bash and writes outside cwd prompt the user.
- `extensions/ui/permission-dialog.ts` — Custom TUI approval dialog for disabled-automode permission prompts.
- `extensions/classifier/classifier.test.ts` — Integration tests against a real model (lmstudio).

**Key patterns:**

- Short-circuit known-safe shell commands before model classification. The static classifier blocks known-dangerous commands by default (used by `yolo`), except that destructive-file cleanup (`rm`/`rmdir`/`shred`/`truncate`) of targets resolving **inside `cwd`** is allowed as safe local cleanup (outside cwd = suspicious). The LLM-backed `auto` mode calls `classifyKnownCommand(..., { blockDangerousCommands: false })` so commands such as `rm` can be evaluated with user intent.
- Direct `completeSimple()` classifier calls with timeout/abort handling.
- Config stored in the shared agent directory via `getAgentDir()`, not in the repo.

## Conventions

- **TypeScript**: Strict mode, ES2024, `nodenext` modules. Use `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`.
- **Naming**: Functions use `camelCase`. Type exports use PascalCase. JSDoc `@param`/`@returns`/`@throws` for public APIs.
- **Error handling**: Always wrap in try/catch; return typed error arrays (`{ scope, error }`) rather than throwing from config helpers.
- **Imports**: Use explicit `.js` extensions for relative imports (TS/Nodenext convention).
- **TypeBox**: Use `Type.Object()` for config schemas; validate with `Compile` from `typebox/compile`.

## Build & Test

```bash
npm run build    # tsgo -p ./tsconfig.json
npm run fmt      # oxfmt
npm run fmt:check # oxfmt --check
npm run lint     # oxlint -c .oxlintrc.json --tsconfig ./tsconfig.json ./extensions/*.ts ./extensions/**/*.ts
npm run lint:fix # oxlint -c .oxlintrc.json --fix --tsconfig ./tsconfig.json ./extensions/*.ts ./extensions/**/*.ts
npm test         # vitest
```

Validation: `npm run build` must pass (zero errors). Tests: `npm test` (integration tests require a running local model).

## Safety

- In `auto` mode, the extension blocks bash commands deemed dangerous by the classifier model; potentially destructive commands are not automatically rejected before model evaluation.
- `yolo` mode uses the static dangerous-command filter without LLM classification.
- When automode is disabled, the extension prompts for permission instead of auto-approving risky bash calls; non-interactive contexts block prompt-required calls.
- The `automodel` command (`/automodel`) persists the selected model to a JSON config file in the agent's home directory — not the repo.
- Classifier sessions are in-memory only; no state is persisted between sessions except the model identifier.
