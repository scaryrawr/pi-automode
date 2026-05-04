import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import { z } from "zod";

import { type ModelIdentifier, modelIdentifierSchema } from "./types.js";

const CONFIG_FILE_NAME = "automode.json";

const automodeConfigSchema = z.looseObject({
  classifierModel: modelIdentifierSchema.optional(),
  enabled: z.boolean().optional(),
});

type AutomodeConfig = z.infer<typeof automodeConfigSchema>;

/**
 * Gets the full path to the automode configuration file.
 * @returns The absolute path to the automode.json config file.
 */
const getConfigPath = (): string => join(getAgentDir(), CONFIG_FILE_NAME);

/**
 * Reads and parses the automode configuration file.
 * Returns undefined if the file doesn't exist or fails to parse.
 * @returns The parsed automode config, or undefined if not available.
 */
const readConfig = (): AutomodeConfig | undefined => {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const result = automodeConfigSchema.safeParse(JSON.parse(readFileSync(configPath, "utf-8")));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Manages the automode configuration file.
 */
export class AutomodeConfigManager {
  private config: AutomodeConfig;

  constructor() {
    this.config = readConfig() ?? {};
  }

  /**
   * Gets whether automode is enabled.
   * @returns True when automode is enabled, otherwise false.
   */
  get enabled(): boolean {
    return this.config.enabled ?? true;
  }

  /**
   * Updates the automode enabled flag and persists it.
   * @param enabled - Whether automode should be enabled.
   */
  set enabled(enabled: boolean) {
    this.config = {
      ...this.config,
      enabled,
    };

    this.writeConfig();
  }

  /**
   * Loads the classifier model identifier from the automode configuration.
   * Falls back to the default model configured in pi settings.
   * @returns The configured classifier model identifier, or undefined if not set.
   */
  get modelIdentifier(): ModelIdentifier | undefined {
    const model = this.config.classifierModel;
    if (model) {
      return model;
    }

    const settingsManager = SettingsManager.create(process.cwd());
    const id = settingsManager.getDefaultModel();
    const provider = settingsManager.getDefaultProvider();
    if (id && provider) {
      return { id, provider };
    }

    return undefined;
  }

  /**
   * Persists the classifier model identifier to the automode configuration file.
   * @param modelIdentifier - The model identifier to persist (provider and id).
   */
  set modelIdentifier(modelIdentifier: ModelIdentifier | undefined) {
    this.config = {
      ...this.config,
      classifierModel: modelIdentifier ? { ...modelIdentifier } : undefined,
    };

    this.writeConfig();
  }

  /**
   * Writes the current automode config to disk.
   */
  private writeConfig(): void {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(this.config, null, 2), "utf-8");
  }
}
