import type { AppContext } from "../context.js";
import { isUuid, formatRelativeTime } from "../db.js";
import { isEffort, isMode, isVerbose } from "../config.js";
import { createMainKeyboard } from "../keyboards.js";
import { escapeHtml } from "../telegram.js";
import { settingsFor, saveSettings, type SettingsOutputFormat } from "../domain/settings.js";
import { resolveWorkspacePath } from "../domain/workspace.js";
import {
  backKeyboard,
  button,
  cliOptionsKeyboard,
  sttKeyboard,
  ttsKeyboard,
  verboseKeyboard,
} from "../ui/inline-keyboards.js";
import { cliOutput, CLI_COMMANDS, showCliOption, showMain, showMenu, showResumeMenu, type CliCommand } from "../ui/screens.js";
import { sessionInfoHtml } from "../ui/messages.js";
import { enqueueJob } from "../usecases/enqueue.js";
import { runCustomAgy } from "../usecases/custom-agy.js";
import { persistDefaultSettings } from "../usecases/default-settings.js";
import { updateBot } from "../usecases/self-update.js";
import { selectModel } from "../usecases/model-selection.js";
import { cleanupSessionTempFiles } from "../usecases/session-cleanup.js";
import type { TelegramCallbackQuery } from "../types.js";
import { isWhisperInstalled } from "../stt/stt-service.js";
import { authorizedCallback } from "./auth.js";
import { parseCallbackAction } from "./callback-parser.js";

export function sessionKeyForCallback(callback: TelegramCallbackQuery): string {
  const msg = callback.message;
  if (!msg) return String(callback.from.id);
  return msg.message_thread_id ? `${msg.chat.id}:${msg.message_thread_id}` : String(msg.chat.id);
}

export async function handleCallback(context: AppContext, callback: TelegramCallbackQuery): Promise<void> {
  if (!authorizedCallback(context.config, callback) || !callback.message || !callback.data) return;
  const action = parseCallbackAction(callback.data);
  if (!action) return;

  const chatId = sessionKeyForCallback(callback);
  const messageId = callback.message.message_id;
  await context.telegram.answerCallbackQuery(callback.id).catch(() => undefined);
  if (action.kind === "noop") return;

  switch (action.kind) {
    case "menu":
      await showMenu(context, chatId, messageId, action.menu, action.page);
      return;
    case "resume-page":
      await showResumeMenu(context, chatId, action.page, messageId);
      return;
    case "resume-use":
      await resumeConversation(context, chatId, messageId, action.conversationId);
      return;
    case "usage":
      enqueueJob(context, chatId, { kind: "usage" });
      return;
    case "credits":
      enqueueJob(context, chatId, { kind: "credits" });
      return;
    case "context":
      enqueueJob(context, chatId, { kind: "context" });
      return;
    case "cli":
      await handleCliAction(context, chatId, messageId, action.command);
      return;
    case "toggle":
      await toggleSetting(context, chatId, messageId, action.option);
      return;
    case "setdefault":
      await persistDefaultSettings(context, chatId, messageId);
      return;
    case "update-bot":
      await updateBot(context, chatId, messageId);
      return;
    case "new-session": {
      await cleanupSessionTempFiles(context.config.tempDir, chatId);
      const isTopic = Boolean(callback.message?.message_thread_id) || String(chatId).includes(":");
      await context.state.resetSession(chatId, true, isTopic);
      await context.telegram.editMessageText(chatId, messageId, sessionInfoHtml(context, chatId), { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] }, "HTML");
      await context.telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settingsFor(context, chatId)));
      return;
    }
    case "cancel": {
      const result = context.queue.cancelForChat(chatId);
      await context.telegram.editMessageText(chatId, messageId, `Cancelled: ${result.removed} queued, active=${result.activeCancelled ? "yes" : "no"}.`, { inline_keyboard: [] });
      await context.telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settingsFor(context, chatId)));
      return;
    }
    case "set":
      await applySettingChange(context, chatId, messageId, action.key, action.value);
      return;
  }
}

async function resumeConversation(context: AppContext, chatId: import("../types.js").ChatId, messageId: number, convId: string): Promise<void> {
  if (!isUuid(convId)) {
    await context.telegram.editMessageText(chatId, messageId, "Selected conversation ID is not a valid UUID.", backKeyboard());
    return;
  }
  const summary = context.convDb.getConversationById(convId);
  if (!summary) {
    await context.telegram.editMessageText(chatId, messageId, "Selected conversation was not found or is invalid.", backKeyboard());
    return;
  }
  const currentSession = context.state.session(chatId) || {};
  const settings = settingsFor(context, chatId);
  settings.continueSession = false;
  await context.state.setSession(chatId, {
    ...currentSession,
    conversationId: summary.conversation_id,
    conversationTitle: summary.display_title,
    conversationStepCount: summary.step_count,
    conversationLastModifiedAt: summary.last_modified_time,
    settings,
    updatedAt: new Date().toISOString(),
  });
  const relativeTime = formatRelativeTime(summary.last_modified_time);
  try {
    await context.telegram.editMessageText(
      chatId,
      messageId,
      `Session switched.\n\n<b>${escapeHtml(summary.display_title)}</b>\n${summary.step_count} steps · last used ${relativeTime}\n\nFuture prompts will continue this conversation.`,
      { inline_keyboard: [] },
      "HTML"
    );
  } catch {
    await context.telegram.editMessageText(
      chatId,
      messageId,
      `Session switched.\n\n${summary.display_title}\n${summary.step_count} steps · last used ${relativeTime}\n\nFuture prompts will continue this conversation.`,
      { inline_keyboard: [] }
    ).catch(() => undefined);
  }
  await context.telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settings));
}

async function handleCliAction(context: AppContext, chatId: import("../types.js").ChatId, messageId: number, command: string): Promise<void> {
  if ((CLI_COMMANDS as string[]).includes(command)) await cliOutput(context, chatId, messageId, command as CliCommand);
  else if (command === "update") await runCustomAgy(context, chatId, ["update"]);
  else await showCliOption(context, chatId, messageId, command);
}

async function toggleSetting(context: AppContext, chatId: import("../types.js").ChatId, messageId: number, option: string): Promise<void> {
  const settings = settingsFor(context, chatId);
  if (option === "continue") settings.continueSession = !settings.continueSession;
  if (option === "new-project") settings.newProject = !settings.newProject;
  if (option === "disable-slash") settings.disableSlashCommands = !settings.disableSlashCommands;
  await saveSettings(context, chatId, settings);
  await context.telegram.editMessageText(chatId, messageId, "CLI options updated.", cliOptionsKeyboard(context, chatId));
}

function isOutputFormat(value: string): value is SettingsOutputFormat {
  return value === "text" || value === "json" || value === "stream-json";
}

async function applySettingChange(context: AppContext, chatId: import("../types.js").ChatId, messageId: number, key: string, value: string): Promise<void> {
  const settings = settingsFor(context, chatId);
  if (key === "model") {
    const outcome = await selectModel(context, chatId, value);
    if (outcome) {
      await context.telegram.editMessageText(chatId, messageId, outcome.text, outcome.defaultOfferKeyboard, "HTML");
      await context.telegram.sendMessage(chatId, "Controls updated.", createMainKeyboard(outcome.settings));
      return;
    }
  }
  if (key === "effort" && isEffort(value)) settings.effort = value;
  if (key === "mode" && isMode(value)) settings.mode = value;
  if (key === "sandbox" && ["on", "off"].includes(value) && (value === "on" || context.config.agy.allowSandboxDisable || !context.config.agy.sandbox)) settings.sandbox = value === "on";
  if (key === "output" && isOutputFormat(value)) settings.outputFormat = value;
  if (key === "verbose" && isVerbose(value)) settings.verbose = value;
  if (key === "ws" || key === "workspace") {
    if (value === "clear" || value === "default" || value === "reset") {
      settings.workspace = null;
      await saveSettings(context, chatId, settings);
      await context.state.resetSession(chatId, true, false);
      await context.telegram.editMessageText(
        chatId,
        messageId,
        `🔄 <b>Workspace reset to default:</b> <code>${escapeHtml(context.config.agy.workspace)}</code>\n\nA new clean session has been started.`,
        { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] },
        "HTML"
      );
      await context.telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settings));
      return;
    }
    const resolution = resolveWorkspacePath(value, context.config.agy.projectsRoot, context.config.agy.workspace);
    if (!resolution.valid || !resolution.resolvedPath) {
      await context.telegram.editMessageText(
        chatId,
        messageId,
        `⚠️ <b>Workspace error</b>\n\n${resolution.error || "Invalid path."}`,
        { inline_keyboard: [[button("‹ Back", "menu:workspace")]] },
        "HTML"
      );
      return;
    }
    settings.workspace = resolution.resolvedPath;
    await saveSettings(context, chatId, settings);
    await context.state.resetSession(chatId, true, true);
    await context.telegram.editMessageText(
      chatId,
      messageId,
      `📁 <b>Workspace switched</b>\n\nActive project: <code>${escapeHtml(resolution.resolvedPath)}</code>\n\nA new clean session has been started in this workspace.`,
      { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] },
      "HTML"
    );
    await context.telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settings));
    return;
  }
  if (key === "stt:provider") {
    if (value === "whisper-local" || value === "gemini" || value === "agy" || value === "none") {
      settings.sttProvider = value;
      await saveSettings(context, chatId, settings);
      let text = `🎙️ STT provider set to <b>${value}</b>.`;
      if (value === "whisper-local" && !isWhisperInstalled(context.config.stt.whisperBin)) {
        text += `\n\n⚠️ <i>Hinweis: Das Binary <code>${escapeHtml(context.config.stt.whisperBin || "whisper")}</code> ist im System nicht auffindbar. Bitte Whisper installieren oder Konfiguration prüfen.</i>`;
      }
      await context.telegram.editMessageText(chatId, messageId, text, sttKeyboard(context, chatId), "HTML");
      return;
    }
  }
  if (key === "stt:whisper") {
    settings.sttWhisperModel = value;
    await saveSettings(context, chatId, settings);
    await context.telegram.editMessageText(chatId, messageId, `🧠 Whisper STT model set to <b>${escapeHtml(value)}</b>.`, sttKeyboard(context, chatId), "HTML");
    return;
  }
  if (key === "stt:lang") {
    settings.sttLang = value;
    await saveSettings(context, chatId, settings);
    await context.telegram.editMessageText(chatId, messageId, `🌐 STT language set to <b>${escapeHtml(value)}</b>.`, sttKeyboard(context, chatId), "HTML");
    return;
  }
  if (key === "tts:mode") {
    if (["off", "voice-only", "voice-and-text", "auto"].includes(value)) {
      settings.ttsMode = value as any;
      await saveSettings(context, chatId, settings);
      await context.telegram.editMessageText(chatId, messageId, `🔊 TTS mode set to <b>${value}</b>.`, ttsKeyboard(context, chatId), "HTML");
      return;
    }
  }
  if (key === "tts:voice") {
    settings.ttsVoice = value;
    await saveSettings(context, chatId, settings);
    await context.telegram.editMessageText(chatId, messageId, `🗣️ TTS voice set to <b>${escapeHtml(value)}</b>.`, ttsKeyboard(context, chatId), "HTML");
    return;
  }
  await saveSettings(context, chatId, settings);
  if (key === "output") await context.telegram.editMessageText(chatId, messageId, "Output format updated.", cliOptionsKeyboard(context, chatId));
  else if (key === "verbose") await context.telegram.editMessageText(chatId, messageId, `Verbose level set to ${value}.`, verboseKeyboard(context, chatId));
  else await showMain(context, chatId, messageId);
}
