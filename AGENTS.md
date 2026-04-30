# pi-automode

## Architecture

This repo implements the **automode extension** for the pi coding agent — an AI-driven shell command classifier that evaluates `bash` tool calls before execution, returning `{ block: true/false }` with an optional reason.

**Extension structure:**

- `extensions/automode.ts` — Extension entry point. Registers the `automodel` command and subscribes to `tool_call` events, delegating bash commands to the classifier.
- `extensions/automode/config.ts` — Reads/writes `automode.json` from the agent's config directory. Uses Zod for schema validation.
- `extensions/automode/types.ts` — Shared type: `ModelIdentifier = { provider: string, id: string }`.
- `extensions/classifier/classifier.ts` — Core classifier: spins up an in-memory agent session with a custom `classify_shell_command` tool. The model classifies commands as `safe`, `ask`, or `dangerous` and resolves a deferred `ToolCallEventResult`.
- `extensions/classifier/classifier.test.ts` — Integration tests against a real model (lmstudio).

**Key patterns:**

- Lazy initialization with cache invalidation on error (`classifier` promise reset to `undefined`).
- Deferred resolution pattern for async tool-call results (`createDeferred` utility).
- `SessionManager.inMemory()` + `SettingsManager.inMemory()` for zero-persistence classifier sessions.
- Config stored in the shared agent directory via `getAgentDir()`, not in the repo.

## Conventions

- **TypeScript**: Strict mode, ES2024, `nodenext` modules. Use `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`.
- **Naming**: Functions use `camelCase`. Type exports use PascalCase. JSDoc `@param`/`@returns`/`@throws` for public APIs.
- **Error handling**: Always wrap in try/catch; return typed error arrays (`{ scope, error }`) rather than throwing from config helpers.
- **Imports**: Use explicit `.js` extensions for relative imports (TS/Nodenext convention).
- **Zod**: Use `.looseObject()` for config schemas to tolerate extra keys.

## Build & Test

```bash
npm run build    # tsgo -p ./tsconfig.json
npm test         # vitest
```

Validation: `npm run build` must pass (zero errors). Tests: `npm test` (integration tests require a running local model).

## Safety

- The extension blocks bash commands deemed dangerous by the classifier model.
- The `automodel` command (`/automodel`) persists the selected model to a JSON config file in the agent's home directory — not the repo.
- Classifier sessions are in-memory only; no state is persisted between sessions except the model identifier.
