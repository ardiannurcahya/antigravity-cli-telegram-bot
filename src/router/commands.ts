import type { AppContext } from "../context.js";
import { controllerKey } from "../context.js";
import { isEffort, isMode, isVerbose } from "../config.js";
import { getActiveModels } from "../models.js";
import { runAgyCommand } from "../agy-runner.js";
import { createMainKeyboard } from "../keyboards.js";
import { saveSettings, settingsFor, type SettingsOutputFormat } from "../domain/settings.js";
import {
  effortKeyboard,
  modeKeyboard,
  modelKeyboard,
  outputFormatKeyboard,
  sandboxKeyboard,
  verboseKeyboard,
} from "../ui/inline-keyboards.js";
import { sessionInfoHtml, sessionOptionUsage, sessionText, usageReport } from "../ui/messages.js";
import { cliOutput, showMain, showResumeMenu } from "../ui/screens.js";
import { reply, replyWithHtml } from "../ui/reply.js";
import { enqueueJob } from "../usecases/enqueue.js";
import { refreshModels, selectModel } from "../usecases/model-selection.js";
import { persistDefaultSettings } from "../usecases/default-settings.js";
import { runCustomAgy } from "../usecases/custom-agy.js";
import { cleanupSessionTempFiles } from "../usecases/session-cleanup.js";
import { scheduleServiceRestart, updateBot, writeRestartNotice } from "../usecases/self-update.js";
import type { ChatId, TelegramMessage } from "../types.js";

interface CommandInput {
  context: AppContext;
  message: TelegramMessage;
  chatId: ChatId;
  args: string[];
  command: string;
}

type CommandHandler = (input: CommandInput) => Promise<void>;

function isOutputFormat(value: string): value is SettingsOutputFormat {
  return value === "text" || value === "json" || value === "stream-json";
}

/** Registry of every supported slash command, including legacy aliases. */
const registry = new Map<string, CommandHandler>();

function command(...aliases: string[]): (handler: CommandHandler) => void {
  return (handler) => {
    for (const alias of aliases) registry.set(alias, handler);
  };
}

command("/start", "/menu")(async ({ context, chatId }) => showMain(context, chatId));

command("/help")(async ({ context, chatId }) => {
  await showMain(context, chatId);
  const loading = await context.telegram.sendMessage(chatId, "Loading AGY CLI help...");
  await cliOutput(context, chatId, loading.message_id, "help");
});

command("/new")(async ({ context, chatId }) => {
  await cleanupSessionTempFiles(context.config.tempDir, chatId);
  await context.state.resetSession(chatId);
  await replyWithHtml(context, chatId, sessionInfoHtml(context, chatId), createMainKeyboard(settingsFor(context, chatId)));
});

command("/setdefault", "/savedefault", "/save_default", "/save")(async ({ context, chatId }) => persistDefaultSettings(context, chatId));

command("/update", "/update_bot", "/update-bot", "/upgrade")(async ({ context, chatId }) => updateBot(context, chatId));

command("/restart", "/restart_bot", "/restart-bot", "/reboot")(async ({ context, chatId }) => {
  if (!context.config.telegram.allowBotUpdate) {
    await reply(context, chatId, "⚠️ Bot restart via Telegram is disabled.\n\nTo enable, set ALLOW_BOT_UPDATE=true in your environment.", createMainKeyboard(settingsFor(context, chatId)));
    return;
  }
  await writeRestartNotice(context, { chatId: String(chatId), reason: "restart" });
  await reply(context, chatId, "🔄 Restarting AGY Telegram service...");
  scheduleServiceRestart(1000);
});

command("/models", "/model")(async ({ context, chatId, args }) => {
  if (!args[0] || args[0].toLowerCase() === "list") {
    void refreshModels(context);
    await reply(context, chatId, "Select a model:", modelKeyboard(context, chatId, 0));
    return;
  }
  if (args[0].toLowerCase() === "refresh") {
    await reply(context, chatId, "Refreshing available models from AGY...");
    await refreshModels(context);
    await reply(context, chatId, `Models refreshed (${getActiveModels().length} available).`, modelKeyboard(context, chatId, 0));
    return;
  }
  const targetModel = args[0].trim();
  const outcome = await selectModel(context, chatId, targetModel);
  if (!outcome) {
    await reply(context, chatId, `Unknown model: ${targetModel}\nAllowed: ${getActiveModels().map((m) => m.id).join(", ")}`, modelKeyboard(context, chatId, 0));
    return;
  }
  await replyWithHtml(context, chatId, outcome.text, outcome.defaultOfferKeyboard);
  await context.telegram.sendMessage(chatId, "Controls updated.", createMainKeyboard(outcome.settings));
});

command("/effort")(async ({ context, chatId, args }) => {
  if (!args[0]) {
    await reply(context, chatId, "Select reasoning effort:", effortKeyboard(context, chatId));
    return;
  }
  const targetEffort = args[0].toLowerCase().trim();
  if (!isEffort(targetEffort)) {
    await reply(context, chatId, `Invalid effort: ${targetEffort}. Choose: low, medium, high.`, effortKeyboard(context, chatId));
    return;
  }
  const settings = settingsFor(context, chatId);
  settings.effort = targetEffort;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Effort set to ${targetEffort}.`, createMainKeyboard(settings));
});

command("/mode")(async ({ context, chatId, args }) => {
  if (!args[0]) {
    await reply(context, chatId, "Select execution mode:", modeKeyboard(context, chatId));
    return;
  }
  const targetMode = args[0].toLowerCase().trim();
  if (!isMode(targetMode)) {
    await reply(context, chatId, `Invalid mode: ${targetMode}. Choose: plan, accept-edits.`, modeKeyboard(context, chatId));
    return;
  }
  const settings = settingsFor(context, chatId);
  settings.mode = targetMode;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Mode set to ${targetMode}.`, createMainKeyboard(settings));
});

command("/sandbox")(async ({ context, chatId, args }) => {
  if (!args[0]) {
    await reply(context, chatId, `Sandbox is ${settingsFor(context, chatId).sandbox ? "enabled" : "disabled"}.`, sandboxKeyboard(context, chatId));
    return;
  }
  const val = args[0].toLowerCase().trim();
  if (!["on", "off"].includes(val)) {
    await reply(context, chatId, "Use /sandbox on|off.", sandboxKeyboard(context, chatId));
    return;
  }
  const enable = val === "on";
  if (!enable && !context.config.agy.allowSandboxDisable && context.config.agy.sandbox) {
    await reply(context, chatId, "Sandbox disabling is locked by server configuration.", createMainKeyboard(settingsFor(context, chatId)));
    return;
  }
  const settings = settingsFor(context, chatId);
  settings.sandbox = enable;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Sandbox ${enable ? "enabled" : "disabled"}.`, createMainKeyboard(settings));
});

command("/verbose")(async ({ context, chatId, args }) => {
  if (!args[0]) {
    await reply(context, chatId, "Select progress verbosity:", verboseKeyboard(context, chatId));
    return;
  }
  const target = args[0].toLowerCase().trim();
  if (!isVerbose(target)) {
    await reply(context, chatId, `Invalid verbose level: ${target}. Choose: detailed, compact, silent.`, verboseKeyboard(context, chatId));
    return;
  }
  const settings = settingsFor(context, chatId);
  settings.verbose = target;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Verbose level set to ${target}.`, createMainKeyboard(settings));
});

command("/agent")(async ({ context, chatId, args }) => {
  const settings = settingsFor(context, chatId);
  if (!args[0]) {
    await reply(context, chatId, `Current agent: ${settings.agent || "default"}\n\nUse: /agent NAME or /agent clear\nList agents: /agents`, createMainKeyboard(settings));
    return;
  }
  const target = args.join(" ").trim();
  settings.agent = target.toLowerCase() === "clear" || target.toLowerCase() === "default" ? null : target;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Agent set to: ${settings.agent || "default"}.`, createMainKeyboard(settings));
});

command("/project")(async ({ context, chatId, args }) => {
  const settings = settingsFor(context, chatId);
  if (!args[0]) {
    await reply(context, chatId, `Current project: ${settings.project || "default"}\n\nUse: /project ID or /project clear`, createMainKeyboard(settings));
    return;
  }
  const target = args.join(" ").trim();
  settings.project = target.toLowerCase() === "clear" || target.toLowerCase() === "default" ? null : target;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Project set to: ${settings.project || "default"}.`, createMainKeyboard(settings));
});

command("/add-dir")(async ({ context, chatId, args }) => {
  const settings = settingsFor(context, chatId);
  if (!args[0]) {
    const dirs = settings.addDirs?.length ? settings.addDirs.join("\n") : "(none)";
    await reply(context, chatId, `Additional workspace directories:\n${dirs}\n\nUse: /add_dir PATH or /add_dir clear`, createMainKeyboard(settings));
    return;
  }
  const target = args.join(" ").trim();
  if (target.toLowerCase() === "clear") {
    settings.addDirs = [];
    await saveSettings(context, chatId, settings);
    await reply(context, chatId, "Additional directories cleared.", createMainKeyboard(settings));
    return;
  }
  settings.addDirs = Array.from(new Set([...(settings.addDirs || []), target]));
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Added directory: ${target}\nTotal dirs: ${settings.addDirs.length}`, createMainKeyboard(settings));
});

command("/output-format")(async ({ context, chatId, args }) => {
  if (!args[0]) {
    await reply(context, chatId, "Select the output format:", outputFormatKeyboard(context, chatId));
    return;
  }
  const target = args[0].toLowerCase().trim();
  if (!isOutputFormat(target)) {
    await reply(context, chatId, "Invalid format. Choose: text, json, stream-json.", outputFormatKeyboard(context, chatId));
    return;
  }
  const settings = settingsFor(context, chatId);
  settings.outputFormat = target;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Output format set to ${target}.`, createMainKeyboard(settings));
});

command("/json-schema")(async ({ context, chatId, args }) => {
  const settings = settingsFor(context, chatId);
  if (!args[0]) {
    await reply(context, chatId, `Current JSON schema: ${settings.jsonSchema || "none"}\n\nUse: /json_schema JSON_OR_PATH or /json_schema clear`, createMainKeyboard(settings));
    return;
  }
  const target = args.join(" ").trim();
  settings.jsonSchema = target.toLowerCase() === "clear" ? null : target;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `JSON schema ${settings.jsonSchema ? "updated" : "cleared"}.`, createMainKeyboard(settings));
});

command("/log-file")(async ({ context, chatId, args }) => {
  const settings = settingsFor(context, chatId);
  if (!args[0]) {
    await reply(context, chatId, `Current log file: ${settings.logFile || "none"}\n\nUse: /log_file PATH or /log_file clear`, createMainKeyboard(settings));
    return;
  }
  const target = args.join(" ").trim();
  settings.logFile = target.toLowerCase() === "clear" ? null : target;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Log file ${settings.logFile ? "set to " + settings.logFile : "cleared"}.`, createMainKeyboard(settings));
});

command("/print-timeout")(async ({ context, chatId, args }) => {
  const settings = settingsFor(context, chatId);
  if (!args[0]) {
    await reply(context, chatId, `Current print timeout: ${settings.printTimeout || "default"}\n\nUse: /print_timeout 10m or /print_timeout clear`, createMainKeyboard(settings));
    return;
  }
  const target = args.join(" ").trim();
  settings.printTimeout = target.toLowerCase() === "clear" ? null : target;
  await saveSettings(context, chatId, settings);
  await reply(context, chatId, `Print timeout ${settings.printTimeout ? "set to " + settings.printTimeout : "reset to default"}.`, createMainKeyboard(settings));
});

command("/resume", "/sessions")(async ({ context, chatId, args }) => {
  await showResumeMenu(context, chatId, args[0] ? Math.max(0, Number(args[0]) - 1) : 0);
});

command("/continue")(async ({ context, chatId, args }) => {
  if (!args[0] || args[0].toLowerCase() === "list") {
    await showResumeMenu(context, chatId, 0);
    return;
  }
  if (["on", "off"].includes(args[0].toLowerCase())) {
    const settings = settingsFor(context, chatId);
    settings.continueSession = args[0].toLowerCase() === "on";
    await saveSettings(context, chatId, settings);
    await reply(context, chatId, `/continue ${settings.continueSession ? "enabled" : "disabled"}.`, createMainKeyboard(settings));
    return;
  }
  await reply(context, chatId, `Use /continue to browse sessions, or /continue on|off to toggle continuation flag.`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/new-project", "/disable-slash-commands")(async ({ context, chatId, command, args }) => {
  const key = command === "/new-project" ? "newProject" : "disableSlashCommands";
  const settings = settingsFor(context, chatId);
  if (!args[0]) {
    await reply(context, chatId, `${command}: ${settings[key] ? "on" : "off"}\n${sessionOptionUsage(command.slice(1))}`, createMainKeyboard(settings));
    return;
  }
  if (["on", "off"].includes(args[0].toLowerCase())) {
    settings[key] = args[0].toLowerCase() === "on";
    await saveSettings(context, chatId, settings);
    await reply(context, chatId, `${command} ${settings[key] ? "enabled" : "disabled"}.`, createMainKeyboard(settings));
    return;
  }
  await reply(context, chatId, `Use on or off.\n${sessionOptionUsage(command.slice(1))}`, createMainKeyboard(settings));
});

command("/agents")(async ({ context, chatId }) => {
  await reply(context, chatId, "Loading AGY agents...", createMainKeyboard(settingsFor(context, chatId)));
  const output = await runAgyCommand(context.config.agy, ["agents"]).catch((error) => `Could not read AGY agents: ${(error as Error).message}`);
  await reply(context, chatId, `AGY agents\n\n${output || "No custom agents available."}`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/changelog")(async ({ context, chatId }) => {
  const output = await runAgyCommand(context.config.agy, ["changelog"]).catch((error) => `Could not read AGY changelog: ${(error as Error).message}`);
  await reply(context, chatId, `AGY changelog\n\n${output}`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/plugins")(async ({ context, chatId }) => {
  const output = await runAgyCommand(context.config.agy, ["plugins", "list"]).catch((error) => `Could not read AGY plugins: ${(error as Error).message}`);
  await reply(context, chatId, `AGY plugins\n\n${output || "No imported plugins."}`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/cli-help")(async ({ context, chatId }) => {
  const output = await runAgyCommand(context.config.agy, ["--help"]).catch((error) => `Could not read AGY help: ${(error as Error).message}`);
  await reply(context, chatId, `AGY CLI help\n\n${output}`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/version")(async ({ context, chatId }) => {
  const output = await runAgyCommand(context.config.agy, ["--version"]).catch((error) => `Could not read AGY version: ${(error as Error).message}`);
  await reply(context, chatId, `AGY version: ${output}`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/session")(async ({ context, chatId }) => {
  await reply(context, chatId, sessionText(context, chatId), createMainKeyboard(settingsFor(context, chatId)));
});

command("/usage", "/quota")(async ({ context, chatId }) => enqueueJob(context, chatId, { kind: "usage" }));

command("/credits")(async ({ context, chatId }) => enqueueJob(context, chatId, { kind: "credits" }));

command("/context")(async ({ context, chatId }) => enqueueJob(context, chatId, { kind: "context" }));

command("/tokens")(async ({ context, chatId }) => {
  await reply(context, chatId, usageReport(context, chatId), createMainKeyboard(settingsFor(context, chatId)));
});

command("/status")(async ({ context, chatId }) => {
  const status = context.queue.statusForChat(chatId);
  await reply(context, chatId, `Status: ${status.active ? `running (${status.active.id})` : "idle"}\nQueued for this chat: ${status.queued}\nTotal queued: ${status.totalQueued}`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/cancel", "/kill", "/stop")(async ({ context, chatId }) => {
  context.pendingDangerousCommands.delete(String(chatId));
  context.controllers.get(controllerKey("prompt", chatId))?.abort();
  context.controllers.get(controllerKey("custom", chatId))?.abort();
  const result = context.queue.cancelForChat(chatId);
  await reply(context, chatId, `⛔ Cancelled: ${result.removed} queued job(s) removed, active AGY process terminated.`, createMainKeyboard(settingsFor(context, chatId)));
});

command("/learn")(async ({ context, chatId, args }) => {
  const promptText = args.length > 0
    ? `/learn ${args.join(" ")}`
    : "Please analyze our recent conversation and derive persistent rules or skills using /learn.";
  enqueueJob(context, chatId, { prompt: promptText, kind: "prompt" });
});

command("/compact")(async ({ context, chatId, args }) => {
  const promptText = args.length > 0
    ? `Please compact the conversation context: ${args.join(" ")}`
    : "Please compact our conversation context by consolidating vital state, active goals, decisions, and modified files internally, discarding temporary logs, and providing a concise token savings summary.";
  enqueueJob(context, chatId, { prompt: promptText, kind: "prompt" });
});

command("/agy-confirm")(async ({ context, chatId }) => {
  const pending = context.pendingDangerousCommands.get(String(chatId));
  if (!pending) await reply(context, chatId, "There is no pending dangerous AGY command.", createMainKeyboard(settingsFor(context, chatId)));
  else await runCustomAgy(context, chatId, pending, true);
});

export async function handleCommand(context: AppContext, message: TelegramMessage, command: string, args: string[]): Promise<boolean> {
  const handler = registry.get(command);
  if (!handler) return false;
  const sessionKey = message.message_thread_id ? `${message.chat.id}:${message.message_thread_id}` : String(message.chat.id);
  await handler({ context, message, chatId: sessionKey, args, command });
  return true;
}

/** Sorted list of every registered slash command (useful for diagnostics/tests). */
export function registeredCommands(): string[] {
  return [...registry.keys()].sort();
}
