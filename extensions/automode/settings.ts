import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ModelIdentifier } from "./types.js";

export const DEFAULT_CLASSIFIER_MODEL_IDENTIFIER: ModelIdentifier = {
  provider: "lmstudio",
  id: "qwen3.5-4b-mxfp8",
};

const AUTOMODE_SETTINGS_KEY = "automode";
const CLASSIFIER_MODEL_SETTINGS_KEY = "classifierModel";

type AutomodeSettings = {
  classifierModel?: ModelIdentifier;
};

type SettingsWithAutomode = {
  automode?: AutomodeSettings | Record<string, unknown>;
};

type MutableSettingsManager = {
  globalSettings: SettingsWithAutomode;
  markModified(field: string, nestedKey?: string): void;
  save(): void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isModelIdentifier = (value: unknown): value is ModelIdentifier =>
  isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";

const readClassifierModelIdentifier = (settings: unknown): ModelIdentifier | undefined => {
  if (!isRecord(settings)) {
    return undefined;
  }

  const automode = settings[AUTOMODE_SETTINGS_KEY];
  if (!isRecord(automode)) {
    return undefined;
  }

  const classifierModel = automode[CLASSIFIER_MODEL_SETTINGS_KEY];
  if (!isModelIdentifier(classifierModel)) {
    return undefined;
  }

  return {
    provider: classifierModel.provider,
    id: classifierModel.id,
  };
};

export const loadClassifierModelIdentifier = (cwd: string): ModelIdentifier => {
  const settingsManager = SettingsManager.create(cwd);
  const globalModel = readClassifierModelIdentifier(settingsManager.getGlobalSettings());
  const projectModel = readClassifierModelIdentifier(settingsManager.getProjectSettings());

  return projectModel ?? globalModel ?? DEFAULT_CLASSIFIER_MODEL_IDENTIFIER;
};

export const persistClassifierModelIdentifier = async (
  cwd: string,
  modelIdentifier: ModelIdentifier,
) => {
  const settingsManager = SettingsManager.create(cwd);
  const initialErrors = settingsManager.drainErrors().filter(({ scope }) => scope === "global");
  if (initialErrors.length > 0) {
    return initialErrors;
  }

  const mutableSettingsManager = settingsManager as unknown as MutableSettingsManager;
  const globalSettings = mutableSettingsManager.globalSettings;
  const hasAutomodeSettings = isRecord(globalSettings.automode);
  const automodeSettings = hasAutomodeSettings ? globalSettings.automode : {};

  globalSettings.automode = {
    ...automodeSettings,
    [CLASSIFIER_MODEL_SETTINGS_KEY]: { ...modelIdentifier },
  };

  mutableSettingsManager.markModified(
    AUTOMODE_SETTINGS_KEY,
    hasAutomodeSettings ? CLASSIFIER_MODEL_SETTINGS_KEY : undefined,
  );
  mutableSettingsManager.save();
  await settingsManager.flush();

  return settingsManager.drainErrors();
};
