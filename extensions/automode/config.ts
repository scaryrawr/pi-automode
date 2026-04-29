import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import type { ModelIdentifier } from "./types.js";

const CONFIG_FILE_NAME = "automode.json";
const CLASSIFIER_MODEL_KEY = "classifierModel";

const modelIdentifierSchema = z.object({
  provider: z.string(),
  id: z.string(),
});

const automodeConfigSchema = z.looseObject({
  classifierModel: modelIdentifierSchema.optional(),
});

type AutomodeConfig = z.infer<typeof automodeConfigSchema>;

const getConfigDir = (): string => getAgentDir();

const getConfigPath = (): string => join(getConfigDir(), CONFIG_FILE_NAME);

const readConfig = (): AutomodeConfig | undefined => {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    const result = automodeConfigSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

export const loadClassifierModelIdentifier = (): ModelIdentifier | undefined =>
  readConfig()?.classifierModel;

export const persistClassifierModelIdentifier = (
  modelIdentifier: ModelIdentifier,
): { scope: string; error: Error }[] => {
  const errors: { scope: string; error: Error }[] = [];

  try {
    const configDir = getConfigDir();
    const configPath = getConfigPath();
    const config = readConfig() ?? {};

    const nextConfig = {
      ...config,
      [CLASSIFIER_MODEL_KEY]: { ...modelIdentifier },
    };

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), "utf-8");
  } catch (error) {
    errors.push({
      scope: "global",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  return errors;
};
