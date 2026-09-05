import { isEffort, isMode, isVerbose } from "../config.js";
import { getActiveModels } from "../models.js";
import type { AppContext } from "../context.js";
import type { ChatId, SessionSettings } from "../types.js";

export type SettingsOutputFormat = NonNullable<SessionSettings["outputFormat"]>;

export function isModelAllowed(context: Pick<AppContext, "config">, modelId: string): boolean {
  return getActiveModels().some((model) => model.id === modelId) || context.config.agy.allowedModels.includes(modelId);
}

export function settingsFor(context: AppContext, chatId: ChatId): SessionSettings {
  const config = context.config;
  const defaults: SessionSettings = {
    model: config.agy.model || null, effort: config.agy.effort, mode: config.agy.mode, sandbox: config.agy.sandbox,
    agent: config.agy.agent || null, project: config.agy.project || null, addDirs: [], continueSession: false,
    newProject: false, disableSlashCommands: false, jsonSchema: null, logFile: null, outputFormat: "stream-json",
    printTimeout: null, verbose: config.telegram.verbose || "detailed",
    workspace: null,
    sttProvider: config.stt?.provider ?? "none",
    sttWhisperModel: config.stt?.whisperModel ?? "base",
    sttAgyModel: config.stt?.agyModel ?? "gemini-3.8-flash-low",
    sttLang: config.stt?.language ?? "en",
    ttsMode: config.tts?.mode ?? "off",
    ttsVoice: config.tts?.voice ?? "en-US-AndrewMultilingualNeural",
  };
  const stored = context.state.session(chatId)?.settings || {};
  const settings: SessionSettings = {
    model: typeof stored.model === "string" && isModelAllowed(context, stored.model) ? stored.model : defaults.model,
    effort: typeof stored.effort === "string" && isEffort(stored.effort) ? stored.effort : defaults.effort,
    mode: typeof stored.mode === "string" && isMode(stored.mode) ? stored.mode : defaults.mode,
    sandbox: typeof stored.sandbox === "boolean" ? stored.sandbox : defaults.sandbox,
    agent: typeof stored.agent === "string" && stored.agent.trim() ? stored.agent.trim() : defaults.agent,
    project: typeof stored.project === "string" && stored.project.trim() ? stored.project.trim() : defaults.project,
    addDirs: Array.isArray(stored.addDirs) ? stored.addDirs.filter((value): value is string => typeof value === "string" && !!value.trim()).map((value) => value.trim()) : [],
    continueSession: stored.continueSession === true,
    newProject: stored.newProject === true,
    disableSlashCommands: stored.disableSlashCommands === true,
    jsonSchema: typeof stored.jsonSchema === "string" && stored.jsonSchema.trim() ? stored.jsonSchema : null,
    logFile: typeof stored.logFile === "string" && stored.logFile.trim() ? stored.logFile : null,
    outputFormat: stored.outputFormat === "text" || stored.outputFormat === "json" || stored.outputFormat === "stream-json" ? stored.outputFormat : defaults.outputFormat,
    printTimeout: typeof stored.printTimeout === "string" && stored.printTimeout.trim() ? stored.printTimeout.trim() : null,
    verbose: typeof stored.verbose === "string" && isVerbose(stored.verbose) ? stored.verbose : defaults.verbose,
    workspace: typeof stored.workspace === "string" && stored.workspace.trim() ? stored.workspace.trim() : defaults.workspace,
    sttProvider: stored.sttProvider === "agy" || stored.sttProvider === "whisper-local" || stored.sttProvider === "gemini" || stored.sttProvider === "none" ? stored.sttProvider : defaults.sttProvider,
    sttWhisperModel: typeof stored.sttWhisperModel === "string" && stored.sttWhisperModel.trim() ? stored.sttWhisperModel.trim() : defaults.sttWhisperModel,
    sttAgyModel: typeof stored.sttAgyModel === "string" && stored.sttAgyModel.trim() ? stored.sttAgyModel.trim() : defaults.sttAgyModel,
    sttLang: typeof stored.sttLang === "string" && stored.sttLang.trim() ? stored.sttLang.trim() : defaults.sttLang,
    ttsMode: stored.ttsMode === "off" || stored.ttsMode === "voice-only" || stored.ttsMode === "voice-and-text" || stored.ttsMode === "auto" ? stored.ttsMode : defaults.ttsMode,
    ttsVoice: typeof stored.ttsVoice === "string" && stored.ttsVoice.trim() ? stored.ttsVoice.trim() : defaults.ttsVoice,
  };
  if (config.agy.sandbox && !config.agy.allowSandboxDisable) settings.sandbox = true;
  return settings;
}

export function effectiveWorkspaceFor(context: AppContext, chatId: ChatId): string {
  const custom = settingsFor(context, chatId).workspace;
  return custom || context.config.agy.workspace;
}

export async function saveSettings(context: AppContext, chatId: ChatId, settings: SessionSettings): Promise<void> {
  await context.state.setSession(chatId, { settings, updatedAt: new Date().toISOString() });
}
