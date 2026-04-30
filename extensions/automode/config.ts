import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import { z } from "zod";

import { type ModelIdentifier, modelIdentifierSchema } from "./types.js";

const CONFIG_FILE_NAME = "automode.json";

const automodeConfigSchema = z.looseObject({
  classifierModel: modelIdentifierSchema.optional(),
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
 * Loads the classifier model identifier from the automode configuration.
 * @returns The configured classifier model identifier, or undefined if not set.
 */
export const getClassifierModelIdentifier = (): ModelIdentifier | undefined => {
  let model = readConfig()?.classifierModel;
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
};

/**
 * Persists the classifier model identifier to the automode configuration file.
 * Creates the config directory if it doesn't exist.
 * @param modelIdentifier - The model identifier to persist (provider and id).
 * @returns An array of errors encountered during persistence, empty on success.
 */
export const persistClassifierModelIdentifier = (modelIdentifier: ModelIdentifier) => {
  const configPath = getConfigPath();
  const config = readConfig() ?? {};

  const nextConfig: AutomodeConfig = {
    ...config,
    classifierModel: { ...modelIdentifier },
  };

  writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), "utf-8");
};
