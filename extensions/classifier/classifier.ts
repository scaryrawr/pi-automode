import {
  completeSimple,
  type AssistantMessage,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  type AuthStorage,
  type ModelRegistry,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

import { classifyKnownCommand } from "./safe-command.js";

/** Result schema for the classify_shell_command tool, indicating if the command is allowed to run and the reason if not. */
export const classifyResultSchema = Type.Object(
  {
    classification: Type.Union([Type.Literal("allow"), Type.Literal("block")], {
      description: "Whether the command should be allowed or blocked",
    }),
    reason: Type.Optional(
      Type.String({
        description: "A brief reason the command should be blocked",
      }),
    ),
  },
  {
    description: "The classification result for a command — allow or block",
  },
);

export type ClassifierCallback = (result: Omit<ToolCallEventResult, "tool">) => void;

const CLASSIFY_TOOL_NAME = "classify_shell_command";
const CLASSIFICATION_TIMEOUT_MS = 20_000;
const CLASSIFIER_SYSTEM_PROMPT = `You are a shell command safety classifier. Call classify_shell_command exactly once. Do not answer in text.

Decision rule: default allow. Block only clear security/safety harm. If any chained command is blocked, block everything.

Block when the command would:
- Destroy, truncate, or irreversibly overwrite existing local files the agent did not create.
- Force-push, delete remote refs, rewrite remote history, or run destructive git cleanup/reset.
- Download/clone untrusted code and execute it, eval code, or run unsafe deserializers.
- Write to prod/shared/cloud/remote infra without explicit latest-prompt consent, skip previews/dry-runs, or disrupt other users' jobs/resources.
- Expose local services/host paths, add persistence (SSH keys, profiles, cron/systemd, git hooks), or exfiltrate secrets/data.
- Bypass this classifier or delegate a blocked action to another tool/agent.

Allow read-only commands, ordinary local project edits, dependency installs from existing manifests, fake test credentials, and normal git add/commit/status/diff/log/branch/switch/merge/rebase-without-force/tag/push-current-branch.

Use classification "allow" for allowed commands. Use "block" with a short reason for blocked commands.`;

const ClassifyResultSchema = Compile(classifyResultSchema);

type ClassifyResult = Static<typeof classifyResultSchema>;

/**
 * Builds the single-turn classifier prompt.
 * @param command - The shell command to classify.
 * @param lastUserPrompt - Latest user prompt for intent context.
 * @returns Prompt text for the classifier model.
 */
const buildPrompt = (command: string, lastUserPrompt?: string): string => {
  const userPrompt = lastUserPrompt
    ? `<last-user-prompt>\n${lastUserPrompt}\n</last-user-prompt>`
    : "<last-user-prompt>(none)</last-user-prompt>";

  return `Evaluate this shell command and call ${CLASSIFY_TOOL_NAME} once.

## Latest User Prompt
${userPrompt}

## Command
<shell-command>${command}</shell-command>`;
};

/**
 * Checks whether a response content block is the classifier tool call.
 * @param block - Assistant message content block.
 * @returns True when the block is a classify_shell_command tool call.
 */
const isClassifierToolCall = (block: AssistantMessage["content"][number]): block is ToolCall => {
  return block.type === "toolCall" && block.name === CLASSIFY_TOOL_NAME;
};

/**
 * Converts validated classifier tool arguments into a tool-call event result.
 * @param params - Validated classifier parameters.
 * @returns The block/allow result expected by pi's tool_call event.
 */
const classificationFromParams = (params: ClassifyResult): ToolCallEventResult => {
  switch (params.classification) {
    case "allow":
      return { block: false };
    default:
      return {
        block: true,
        reason: params.reason ?? "Classified unsafe to autoapprove by classifier",
      };
  }
};

/**
 * Extracts the classifier decision from a direct model response.
 * @param response - Assistant message returned by completeSimple.
 * @returns The block/allow result expected by pi's tool_call event.
 */
const classificationFromResponse = (response: AssistantMessage): ToolCallEventResult => {
  if (response.stopReason === "error") {
    return {
      block: true,
      reason: response.errorMessage ?? "Classifier request failed",
    };
  }

  const toolCall = response.content.find(isClassifierToolCall);
  if (!toolCall) {
    return {
      block: true,
      reason: "No classification result",
    };
  }

  try {
    return classificationFromParams(
      ClassifyResultSchema.Parse(toolCall.arguments) as ClassifyResult,
    );
  } catch (error) {
    return {
      block: true,
      reason:
        error instanceof Error
          ? `Invalid classification result: ${error.message}`
          : "Invalid classification result",
    };
  }
};

/**
 * Loads configured extensions and applies provider registrations to the classifier model registry.
 * @param modelRegistry - Registry to receive provider registrations discovered from extensions.
 */
const loadConfiguredProviders = async (modelRegistry: ModelRegistry): Promise<void> => {
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
  });

  await resourceLoader.reload();

  const { pendingProviderRegistrations } = resourceLoader.getExtensions().runtime;
  for (const { name, config } of pendingProviderRegistrations) {
    try {
      modelRegistry.registerProvider(name, config);
    } catch {
      // Match pi's extension runner behavior: one bad provider registration must not
      // prevent other configured providers from becoming available.
    }
  }
};

export type CreateClassifierOptions = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  modelIdentifier: {
    provider: string;
    id: string;
  };
};

export type ClassifyOptions = {
  /** Command to classify */
  command: string;
  /** Latest user-submitted prompt for intent context (optional) */
  lastUserPrompt?: string | undefined;
};

export type Classifier = {
  /**
   * Classifies the command and returns a block/allow tool call result
   * @param params - The classification inputs
   * @returns A promise resolving to the classification result with block/allow and reason
   */
  classify: (params: ClassifyOptions, signal?: AbortSignal) => Promise<ToolCallEventResult>;
};

export const createClassifier = async (options: CreateClassifierOptions): Promise<Classifier> => {
  const { modelRegistry, modelIdentifier } = options;

  await loadConfiguredProviders(modelRegistry);

  return {
    /**
     * Classifies a shell command as allow or block using a direct model completion.
     * Submits the command to the classifier model and reads the classification tool call.
     * @returns A Promise resolving to the ToolCallEventResult with block/allow decision and reason.
     */
    classify: async (
      { command, lastUserPrompt }: ClassifyOptions,
      signal?: AbortSignal,
    ): Promise<ToolCallEventResult> => {
      // Short-circuit: known commands don't need LLM classification.
      const knownClassification = await classifyKnownCommand(command);
      if (knownClassification === "allow") {
        return { block: false };
      }
      if (knownClassification === "block") {
        return {
          block: true,
          reason: "Command contains a known-block shell operation.",
        };
      }

      if (signal?.aborted) {
        return {
          block: true,
          reason: "Classification cancelled",
        };
      }

      const model = modelRegistry.find(modelIdentifier.provider, modelIdentifier.id);
      if (!model) {
        return {
          block: true,
          reason: "Model not found",
        };
      }

      const requestController = new AbortController();
      let abortReason: string | undefined;
      const abortClassification = (reason: string) => {
        if (requestController.signal.aborted) {
          return;
        }

        abortReason = reason;
        requestController.abort();
      };

      const timeoutReason = `Classifier timed out after ${CLASSIFICATION_TIMEOUT_MS / 1000}s`;
      const timeout = setTimeout(() => {
        abortClassification(timeoutReason);
      }, CLASSIFICATION_TIMEOUT_MS);
      const abortFromSignal = () => {
        abortClassification("Classification cancelled");
      };

      signal?.addEventListener("abort", abortFromSignal, { once: true });

      const abortResult = (): ToolCallEventResult => ({
        block: true,
        reason: abortReason ?? "Classification cancelled",
      });
      let removeAbortResultListener = () => {};
      const abortPromise = new Promise<ToolCallEventResult>((resolve) => {
        const resolveAbort = () => {
          resolve(abortResult());
        };

        if (requestController.signal.aborted) {
          resolveAbort();
          return;
        }

        requestController.signal.addEventListener("abort", resolveAbort, { once: true });
        removeAbortResultListener = () => {
          requestController.signal.removeEventListener("abort", resolveAbort);
        };
      });

      try {
        const auth = await Promise.race([modelRegistry.getApiKeyAndHeaders(model), abortPromise]);
        if (!("ok" in auth)) {
          return auth;
        }
        if (!auth.ok) {
          return { block: true, reason: auth.error };
        }

        const requestOptions: SimpleStreamOptions = {
          reasoning: "low",
          signal: requestController.signal,
        };
        if (auth.apiKey !== undefined) {
          requestOptions.apiKey = auth.apiKey;
        }
        if (auth.headers !== undefined) {
          requestOptions.headers = auth.headers;
        }

        const responsePromise = completeSimple(
          model,
          {
            systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: buildPrompt(command, lastUserPrompt),
                timestamp: Date.now(),
              },
            ],
            tools: [
              {
                name: CLASSIFY_TOOL_NAME,
                description: "Classify a shell tool as allow or block to run.",
                parameters: classifyResultSchema,
              },
            ],
          },
          requestOptions,
        ).then((response): ToolCallEventResult => {
          if (requestController.signal.aborted || response.stopReason === "aborted") {
            return {
              block: true,
              reason: abortReason ?? response.errorMessage ?? "Classification cancelled",
            };
          }

          return classificationFromResponse(response);
        });

        return await Promise.race([responsePromise, abortPromise]);
      } catch (error) {
        return {
          block: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortFromSignal);
        removeAbortResultListener();
      }
    },
  };
};
