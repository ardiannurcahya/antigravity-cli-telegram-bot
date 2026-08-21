import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConversationDatabase, formatRelativeTime, isUuid, type ConversationPage } from "./db.js";
import { parseUsageQuota, parseCredits, parseContext, runPtyCommand } from "./pty-runner.js";
import { formatStepUpdate, parseCommandArgs, runAgy, runAgyCommand, validateCustomArgs } from "./agy-runner.js";
import { loadConfig, isEffort, isMode, isVerbose } from "./config.js";
import { getActiveModels, getModelMaxContext, modelLabel, parseAgyModelsOutput, renderContextProgressBar, setActiveModels } from "./models.js";
import { createMainKeyboard } from "./keyboards.js";
import { JobQueue, type QueueJob } from "./queue.js";
import { StateStore } from "./state.js";
import { escapeHtml, findReferencedMediaFiles, formatTelegramHtmlChunks, splitMessage, splitPreformattedHtml, TelegramClient } from "./telegram.js";
import type { AgyResult, AppConfig, ChatId, ConversationSummary, InlineButton, InlineKeyboardMarkup, ReplyMarkup, SessionSettings, StreamEvent, TelegramCallbackQuery, TelegramMessage, TelegramUpdate, Usage } from "./types.js";

const execFileAsync = promisify(execFile);
const BOT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const config = loadConfig();
const state = new StateStore(config.stateFile);
await state.load();
const convDb = new ConversationDatabase(config.agy.dbPath);
const telegram = new TelegramClient(config.telegram.token);
const controllers = new Map<string, AbortController>();
const pendingDangerousCommands = new Map<string, string[]>();

export function isModelAllowed(modelId: string): boolean {
  return getActiveModels().some((model) => model.id === modelId) || config.agy.allowedModels.includes(modelId);
}

export async function refreshModels(): Promise<void> {
  try {
    const output = await runAgyCommand(config.agy, ["models"], 15_000);
    const parsed = parseAgyModelsOutput(output);
    if (parsed.length > 0) {
      setActiveModels(parsed);
    }
  } catch {
    // Keep fallback models if agy models is unavailable
  }
}

function authorizedMessage(message: TelegramMessage | undefined): boolean {
  if (!message) return false;
  return authorizedUser(message.from?.id, message.chat.id, message.chat.type);
}

function authorizedCallback(callback: TelegramCallbackQuery): boolean {
  return authorizedUser(callback.from?.id, callback.message?.chat.id, callback.message?.chat.type);
}

function authorizedUser(userId: number | undefined, chatId: number | string | undefined, chatType: string | undefined): boolean {
  if (config.telegram.privateOnly && chatType !== "private") return false;
  if (!userId || !config.telegram.allowedUserIds.includes(String(userId))) return false;
  if (config.telegram.allowedChatIds?.length && (!chatId || !config.telegram.allowedChatIds.includes(String(chatId)))) return false;
  return true;
}

async function reply(chatId: ChatId, text: string, replyMarkup?: ReplyMarkup): Promise<void> {
  const chunks = splitMessage(text, config.telegram.maxMessageChars);
  for (let index = 0; index < chunks.length; index += 1) {
    await telegram.sendMessage(chatId, chunks[index], index === chunks.length - 1 ? replyMarkup : undefined);
  }
}

async function replyWithFormattedResponse(chatId: ChatId, text: string, replyMarkup?: ReplyMarkup): Promise<void> {
  const chunks = formatTelegramHtmlChunks(text, config.telegram.maxMessageChars);
  if (!chunks.length) {
    await reply(chatId, text, replyMarkup);
    return;
  }
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      await telegram.sendMessage(chatId, chunks[index], index === chunks.length - 1 ? replyMarkup : undefined, "HTML");
    }
  } catch {
    await reply(chatId, text, replyMarkup);
  }
}

async function replyWithHtml(chatId: ChatId, html: string, replyMarkup?: ReplyMarkup): Promise<void> {
  const chunks = splitPreformattedHtml(html, config.telegram.maxMessageChars);
  for (let index = 0; index < chunks.length; index += 1) {
    const isLast = index === chunks.length - 1;
    try {
      await telegram.sendMessage(chatId, chunks[index], isLast ? replyMarkup : undefined, "HTML");
    } catch {
      await telegram.sendMessage(chatId, chunks[index].replace(/<[^>]+>/g, ""), isLast ? replyMarkup : undefined);
    }
  }
}

function button(text: string, callback_data: string): { text: string; callback_data: string } { return { text, callback_data }; }

function backKeyboard(): InlineKeyboardMarkup { return { inline_keyboard: [[button("‹ Back", "menu:main")]] }; }

function settingsFor(chatId: ChatId): SessionSettings {
  const defaults: SessionSettings = {
    model: config.agy.model || null, effort: config.agy.effort, mode: config.agy.mode, sandbox: config.agy.sandbox,
    agent: config.agy.agent || null, project: config.agy.project || null, addDirs: [], continueSession: false,
    newProject: false, disableSlashCommands: false, jsonSchema: null, logFile: null, outputFormat: "stream-json",
    printTimeout: null, verbose: config.telegram.verbose || "detailed",
  };
  const stored = state.session(chatId)?.settings || {};
  const settings: SessionSettings = {
    model: typeof stored.model === "string" && isModelAllowed(stored.model) ? stored.model : defaults.model,
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
    dangerouslySkipPermissions: false,
    verbose: typeof stored.verbose === "string" && isVerbose(stored.verbose) ? stored.verbose : defaults.verbose,
  };
  if (config.agy.sandbox && !config.agy.allowSandboxDisable) settings.sandbox = true;
  return settings;
}

function settingsText(settings: SessionSettings): string {
  return [
    `Model: ${modelLabel(settings.model)}`, `Effort: ${settings.effort}`, `Mode: ${settings.mode}`,
    `Verbose: ${settings.verbose || "detailed"}`, `Agent: ${settings.agent || "default"}`, `Project: ${settings.project || "default"}`,
    `Sandbox: ${settings.sandbox ? "enabled" : "disabled"}`, `Output: ${settings.outputFormat}`,
    `Add dirs: ${settings.addDirs?.length || 0}`, `Slash commands: ${settings.disableSlashCommands ? "disabled" : "enabled"}`,
  ].join("\n");
}

function sessionInfoHtml(chatId: ChatId): string {
  const settings = settingsFor(chatId);
  const maxContext = getModelMaxContext(settings.model);
  const contextStr = maxContext ? `${maxContext.toLocaleString()} tokens` : "Default";
  const modeStr = settings.mode === "accept-edits" ? "edit (accept-edits)" : (settings.mode || "accept-edits");

  return [
    "✨ <b>New AGY conversation started.</b>\n",
    `• <b>Model:</b> <code>${escapeHtml(modelLabel(settings.model))}</code>`,
    `• <b>Effort:</b> <code>${escapeHtml(settings.effort || "high")}</code>`,
    `• <b>Mode:</b> <code>${escapeHtml(modeStr)}</code>`,
    `• <b>Verbose:</b> <code>${escapeHtml(settings.verbose || "detailed")}</code>`,
    `• <b>Context Limit:</b> <code>${escapeHtml(contextStr)}</code>`,
    `• <b>Sandbox:</b> <code>${settings.sandbox ? "Enabled" : "Disabled"}</code>`,
    config.agy.project ? `• <b>Project:</b> <code>${escapeHtml(config.agy.project)}</code>` : null,
  ].filter(Boolean).join("\n");
}

async function saveSettings(chatId: ChatId, settings: SessionSettings): Promise<void> {
  await state.setSession(chatId, { settings, updatedAt: new Date().toISOString() });
}

async function persistDefaultSettings(chatId: ChatId, messageId?: number): Promise<void> {
  const settings = settingsFor(chatId);
  const envPath = path.join(os.homedir(), ".config/agy-telegram/.env");
  try {
    let content = "";
    try {
      content = await fs.readFile(envPath, "utf8");
    } catch {
      // file might not exist yet
    }
    const lines = content.split("\n");
    const newVars: Record<string, string> = {
      AGY_MODEL: settings.model || "",
      AGY_EFFORT: settings.effort || "high",
      AGY_MODE: settings.mode || "accept-edits",
      AGY_SANDBOX: settings.sandbox ? "1" : "0",
    };
    const updatedLines = [...lines];
    for (const [key, val] of Object.entries(newVars)) {
      const idx = updatedLines.findIndex((l) => l.startsWith(`${key}=`));
      if (idx >= 0) {
        updatedLines[idx] = `${key}=${val}`;
      } else {
        updatedLines.push(`${key}=${val}`);
      }
    }
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    const tempFile = `${envPath}.tmp.${Date.now()}`;
    await fs.writeFile(tempFile, updatedLines.join("\n"), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempFile, envPath);

    config.agy.model = settings.model || "";
    config.agy.effort = settings.effort;
    config.agy.mode = settings.mode;
    config.agy.sandbox = settings.sandbox;
    const text = `💾 <b>Settings saved as permanent defaults:</b>\n\n• <b>Model:</b> ${escapeHtml(modelLabel(settings.model))}\n• <b>Effort:</b> ${settings.effort}\n• <b>Mode:</b> ${settings.mode === "accept-edits" ? "edit" : "plan"}\n• <b>Sandbox:</b> ${settings.sandbox ? "On" : "Off"}\n\n<i>These defaults will now apply to all new sessions and service restarts.</i>`;
    if (messageId) {
      await telegram.editMessageText(chatId, messageId, text, { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] }, "HTML");
    } else {
      await replyWithHtml(chatId, text, createMainKeyboard(settings));
    }
  } catch (error) {
    const errorText = `Could not save defaults: ${(error as Error).message}`;
    if (messageId) {
      await telegram.editMessageText(chatId, messageId, errorText, backKeyboard());
    } else {
      await reply(chatId, errorText, createMainKeyboard(settings));
    }
  }
}

async function updateBot(chatId: ChatId, messageId?: number): Promise<void> {
  const notify = async (text: string, isHtml = false): Promise<void> => {
    if (messageId) {
      if (isHtml) {
        await telegram.editMessageText(chatId, messageId, text, { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] }, "HTML").catch(() => undefined);
      } else {
        await telegram.editMessageText(chatId, messageId, text, backKeyboard()).catch(() => undefined);
      }
    } else {
      if (isHtml) {
        await replyWithHtml(chatId, text, createMainKeyboard(settingsFor(chatId)));
      } else {
        await reply(chatId, text, createMainKeyboard(settingsFor(chatId)));
      }
    }
  };

  if (!config.telegram.allowBotUpdate) {
    await notify("⚠️ <b>Bot updates via Telegram are disabled.</b>\n\nTo enable remote updates, set <code>ALLOW_BOT_UPDATE=true</code> in your environment.", true);
    return;
  }

  try {
    if (messageId) {
      await telegram.editMessageText(chatId, messageId, "🔍 Checking for updates from GitHub...").catch(() => undefined);
    } else {
      await reply(chatId, "🔍 Checking for updates from GitHub...");
    }

    const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: BOT_ROOT_DIR });
    const currentBranch = branchOut.trim();

    await execFileAsync("git", ["fetch", "origin", currentBranch], { cwd: BOT_ROOT_DIR });

    const { stdout: localHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: BOT_ROOT_DIR });
    const { stdout: remoteHead } = await execFileAsync("git", ["rev-parse", `origin/${currentBranch}`], { cwd: BOT_ROOT_DIR });

    const localHash = localHead.trim();
    const remoteHash = remoteHead.trim();

    if (localHash === remoteHash) {
      const { stdout: logMsg } = await execFileAsync("git", ["log", "-1", "--pretty=format:%h - %s"], { cwd: BOT_ROOT_DIR });
      await notify(`✅ <b>Bot is up to date!</b>\n\nBranch: <code>${escapeHtml(currentBranch)}</code>\nCurrent commit: <code>${escapeHtml(logMsg.trim())}</code>`, true);
      return;
    }

    if (messageId) {
      await telegram.editMessageText(chatId, messageId, "⬇️ Pulling latest changes from GitHub...").catch(() => undefined);
    } else {
      await reply(chatId, "⬇️ Pulling latest changes from GitHub...");
    }

    await execFileAsync("git", ["pull", "--ff-only", "origin", currentBranch], { cwd: BOT_ROOT_DIR });

    if (messageId) {
      await telegram.editMessageText(chatId, messageId, "🔨 Building project with TypeScript...").catch(() => undefined);
    } else {
      await reply(chatId, "🔨 Building project with TypeScript...");
    }

    await execFileAsync("npm", ["run", "build"], { cwd: BOT_ROOT_DIR });

    const { stdout: newLogMsg } = await execFileAsync("git", ["log", "-1", "--pretty=format:%h - %s"], { cwd: BOT_ROOT_DIR });

    const noticePath = path.join(path.dirname(config.stateFile), "pending_restart_notice.json");
    await fs.writeFile(noticePath, JSON.stringify({
      chatId: String(chatId),
      reason: "update",
      commit: newLogMsg.trim(),
      timestamp: Date.now()
    })).catch(() => undefined);

    await notify(`🚀 <b>Update complete!</b>\n\nBranch: <code>${escapeHtml(currentBranch)}</code>\nUpdated to: <code>${escapeHtml(newLogMsg.trim())}</code>\n\n<i>Restarting bot service...</i>`, true);

    if (process.platform === "linux") {
      setTimeout(() => {
        spawn("systemctl", ["--user", "restart", "agy-telegram.service"], { detached: true, stdio: "ignore" }).unref();
      }, 1500);
    }
  } catch (error) {
    await notify(`❌ <b>Update failed:</b>\n<code>${escapeHtml((error as Error).message)}</code>`, true);
  }
}

function usageText(usage: Usage | null | undefined, modelId: string | null = null, isAccumulated = false): string {
  if (!usage) return "Usage data was not provided by AGY.";
  const activeInputContext = (usage.input_tokens || 0) + (usage.cache_read_tokens || 0);
  const maxContext = getModelMaxContext(modelId);
  const lines: string[] = [];
  if (!isAccumulated && activeInputContext > 0) {
    if (activeInputContext <= maxContext) {
      lines.push(`Active Context: ${renderContextProgressBar(activeInputContext, maxContext)}`);
    } else {
      lines.push(`Context reported by AGY: ${activeInputContext.toLocaleString()} tokens (Session Total; active context unavailable)`);
    }
  }
  const labels: Array<[keyof Usage, string]> = [["input_tokens", "Input (New)"], ["output_tokens", "Output"], ["thinking_tokens", "Thinking"], ["cache_read_tokens", "Cache-read"], ["total_tokens", "Total Billed"]];
  for (const [key, label] of labels) {
    if (usage[key] !== undefined) {
      lines.push(`${label}: ${usage[key]!.toLocaleString()}`);
    }
  }
  return lines.join("\n") || "Usage data was not provided by AGY.";
}

function sessionText(chatId: ChatId): string {
  const session = state.session(chatId);
  const status = queue.statusForChat(chatId);
  const title = session?.conversationTitle || (session?.conversationId ? "Untitled session" : "new");
  const lines = [
    "Session\n",
    `Active: ${title}`,
    `Conversation: ${session?.conversationId || "new"}`,
  ];
  if (session?.conversationStepCount) {
    const relative = formatRelativeTime(session.conversationLastModifiedAt || session.updatedAt);
    lines.push(`Steps: ${session.conversationStepCount} · Last active: ${relative}`);
  }
  lines.push(`Workspace: ${config.agy.workspace}`);
  lines.push(settingsText(settingsFor(chatId)));
  lines.push(`Status: ${status.active ? "running" : "idle"}`);
  return lines.join("\n");
}

function resumeKeyboard(page = 0, totalPages = 1, items: ConversationSummary[] = []): InlineKeyboardMarkup {
  const rows: InlineButton[][] = items.map((item) => [
    button(
      item.display_title.length > 40 ? `${item.display_title.slice(0, 37)}...` : item.display_title,
      `resume:use:${item.conversation_id}`
    ),
  ]);
  const navigation: InlineButton[] = [];
  if (page > 0) navigation.push(button("‹ Previous", `resume:page:${page - 1}`));
  navigation.push(button(`Page ${page + 1}/${totalPages}`, "noop"));
  if (page < totalPages - 1) navigation.push(button("Next ›", `resume:page:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([button("‹ Back", "menu:main")]);
  return { inline_keyboard: rows };
}

function resumeMessageText(pageData: ConversationPage): string {
  if (pageData.total === 0 || pageData.items.length === 0) {
    return "<b>AGY Sessions</b>\n\nNo saved conversations found in AGY database.";
  }
  const list = pageData.items
    .map((item) => {
      const time = formatRelativeTime(item.last_modified_time);
      return `<b>${escapeHtml(item.display_title)}</b>\n${item.step_count} steps · ${time}`;
    })
    .join("\n\n");
  return `<b>AGY Sessions</b>\nPage ${pageData.page + 1}/${pageData.totalPages}\n\n${list}`;
}

async function showResumeMenu(chatId: ChatId, page = 0, messageId?: number): Promise<void> {
  const pageData = convDb.getConversations(page, 10);
  const text = resumeMessageText(pageData);
  const keyboard = resumeKeyboard(pageData.page, pageData.totalPages, pageData.items);
  if (messageId) {
    try {
      await telegram.editMessageText(chatId, messageId, text, keyboard, "HTML");
    } catch {
      await telegram.editMessageText(chatId, messageId, text.replace(/<[^>]+>/g, ""), keyboard).catch(() => undefined);
    }
  } else {
    await replyWithHtml(chatId, text, keyboard);
  }
}

function usageReport(chatId: ChatId): string {
  const session = state.session(chatId);
  const last = session?.lastRun;
  const modelId = last?.model || settingsFor(chatId).model;
  const lastText = last ? [`Last run: ${last.status}`, last.model ? `Model: ${modelLabel(last.model)}` : null, last.durationMs ? `Duration: ${(last.durationMs / 1000).toFixed(1)}s` : null, last.numTurns !== null ? `Turns: ${last.numTurns}` : null, last.toolCalls ? `Tool calls: ${last.toolCalls}` : null, usageText(last.usage, modelId)].filter(Boolean).join("\n") : "Last run: no completed run yet.";
  return `Usage / Quota\n\n${lastText}\n\nAccumulated usage:\n${usageText(session?.usageTotals, modelId, true)}\n\nSubscription quota is not exposed by AGY stream-json.`;
}

function isOutputFormat(value: string): value is NonNullable<SessionSettings["outputFormat"]> {
  return value === "text" || value === "json" || value === "stream-json";
}

function sessionOptionUsage(option: string): string {
  return [
    `/project ID|clear`, `/add-dir PATH|clear`, `/output-format text|json|stream-json`,
    `/json-schema JSON_OR_PATH|clear`, `/log-file PATH|clear`, `/print-timeout DURATION|clear`,
    `/continue on|off`, `/new-project on|off`, `/disable-slash-commands on|off`,
  ].find((line) => line.startsWith(`/${option} `)) || `Usage: /${option} VALUE`;
}

function modelKeyboard(chatId: ChatId, page = 0): InlineKeyboardMarkup {
  const pageSize = 5;
  const models = getActiveModels();
  const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
  const normalizedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const selected = settingsFor(chatId).model;
  const rows = models.slice(normalizedPage * pageSize, normalizedPage * pageSize + pageSize).map((model) => [button(`${model.id === selected ? "✅ " : ""}${model.label}`, `set:model:${model.id}`)]);
  const navigation = [];
  if (normalizedPage > 0) navigation.push(button("‹", `menu:models:${normalizedPage - 1}`));
  navigation.push(button(`${normalizedPage + 1}/${totalPages}`, "noop"));
  if (normalizedPage < totalPages - 1) navigation.push(button("›", `menu:models:${normalizedPage + 1}`));
  rows.push(navigation);
  rows.push([button("‹ Back", "menu:main")]);
  return { inline_keyboard: rows };
}

function effortKeyboard(chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(chatId).effort;
  const choices = ["low", "medium", "high"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:effort:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

function modeKeyboard(chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(chatId).mode;
  const choices = ["plan", "accept-edits"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:mode:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

function sandboxKeyboard(chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(chatId).sandbox;
  const disableAllowed = config.agy.allowSandboxDisable || !config.agy.sandbox;
  return { inline_keyboard: [[button(`${selected ? "✅ " : ""}On`, "set:sandbox:on"), button(`${!selected ? "✅ " : ""}Off${disableAllowed ? "" : " (locked)"}`, disableAllowed ? "set:sandbox:off" : "noop")], [button("‹ Back", "menu:main")]] };
}

function verboseKeyboard(chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(chatId).verbose || "detailed";
  const choices = ["detailed", "compact", "silent"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:verbose:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

function mainInlineKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("Models", "menu:models"), button("Effort", "menu:effort")],
      [button("Mode", "menu:mode"), button("Sandbox", "menu:sandbox")],
      [button("Verbose", "menu:verbose"), button("Resume session", "menu:resume")],
      [button("Usage / Quota", "action:usage"), button("Active Context", "action:context")],
      [button("Session", "menu:session"), button("CLI options", "menu:cli")],
      [button("AGY models", "cli:models"), button("AGY agents", "cli:agents")],
      [button("Changelog", "cli:changelog"), button("Plugins", "cli:plugins")],
      [button("CLI help", "cli:help"), button("CLI version", "cli:version")],
      [button("Custom /agy", "menu:custom"), button("Plugin actions", "menu:plugins")],
      [button("💾 Set as Default", "action:setdefault"), button("New session", "action:new")],
      [button("🔄 Update Bot", "action:update_bot"), button("Update CLI", "cli:update")],
      [button("Cancel", "action:cancel")],
    ],
  };
}

type CliCommand = "models" | "agents" | "changelog" | "plugins" | "help" | "version";

function cliCommandArgs(command: CliCommand): string[] {
  if (command === "models") return ["models"];
  if (command === "agents") return ["agents"];
  if (command === "changelog") return ["changelog"];
  if (command === "plugins") return ["plugins", "list"];
  if (command === "version") return ["--version"];
  return ["--help"];
}

async function cliOutput(chatId: ChatId, messageId: number, command: CliCommand): Promise<void> {
  await telegram.editMessageText(chatId, messageId, `Running agy ${cliCommandArgs(command).join(" ")}...`);
  try {
    const output = await runAgyCommand(config.agy, cliCommandArgs(command));
    const title = command === "help" ? "AGY CLI help" : `AGY ${command}`;
    await reply(chatId, `${title}\n\n${output}`, createMainKeyboard(settingsFor(chatId)));
  } catch (error) {
    await reply(chatId, `Could not read AGY ${command}: ${(error as Error).message}`, createMainKeyboard(settingsFor(chatId)));
  }
}

async function showMain(chatId: ChatId, messageId?: number): Promise<void> {
  const settings = settingsFor(chatId);
  const text = `AGY Telegram\n\n${settingsText(settings)}\n\nUse the two controls beside the input for Model and Mode. Use /menu for the full control panel.`;
  if (messageId) {
    await telegram.editMessageText(chatId, messageId, text, mainInlineKeyboard());
    await telegram.sendMessage(chatId, "Controls updated.", createMainKeyboard(settings));
  } else {
    await reply(chatId, text, mainInlineKeyboard());
    await telegram.sendMessage(chatId, "Model and mode controls are ready.", createMainKeyboard(settings));
  }
}

async function showMenu(chatId: ChatId, messageId: number, kind: string, page = 0): Promise<void> {
  if (kind === "main") return showMain(chatId, messageId);
  if (kind === "model" || kind === "models") return telegram.editMessageText(chatId, messageId, "Select a model:", modelKeyboard(chatId, page));
  if (kind === "effort") return telegram.editMessageText(chatId, messageId, "Select reasoning effort:", effortKeyboard(chatId));
  if (kind === "mode") return telegram.editMessageText(chatId, messageId, "Select execution mode:", modeKeyboard(chatId));
  if (kind === "sandbox") return telegram.editMessageText(chatId, messageId, `Sandbox is ${settingsFor(chatId).sandbox ? "enabled" : "disabled"}.`, sandboxKeyboard(chatId));
  if (kind === "verbose") return telegram.editMessageText(chatId, messageId, "Select progress verbosity during execution:", verboseKeyboard(chatId));
  if (kind === "session") return telegram.editMessageText(chatId, messageId, sessionText(chatId), backKeyboard());
  if (kind === "resume") return showResumeMenu(chatId, page, messageId);
  if (kind === "usage") { enqueueJob(chatId, { kind: "usage" }); return; }
  if (kind === "credits") { enqueueJob(chatId, { kind: "credits" }); return; }
  if (kind === "cli") return telegram.editMessageText(chatId, messageId, "All AGY CLI flags are available with /agy. Common session flags can be set here; options that need a path or value have a command example.", cliOptionsKeyboard(chatId));
  if (kind === "output") return telegram.editMessageText(chatId, messageId, "Select the output format used by future normal prompts:", outputFormatKeyboard(chatId));
  if (kind === "custom") return telegram.editMessageText(chatId, messageId, "Custom AGY command\n\nUse /agy followed by any non-interactive AGY arguments. Example:\n/agy --print \"Explain this project\" --output-format text\n\nInteractive TTY mode is unavailable through Telegram.", backKeyboard());
  if (kind === "plugins") return telegram.editMessageText(chatId, messageId, "Plugin commands\n\nRead-only:\n/agy plugin list\n\nMutating commands require /agy-confirm after the bot asks for confirmation:\n/agy plugin install NAME\n/agy plugin uninstall NAME\n/agy plugin enable NAME\n/agy plugin disable NAME\n/agy update", backKeyboard());
}

function cliOptionsKeyboard(chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(chatId);
  return {
    inline_keyboard: [
      [button("Project", "cli:project"), button("Agent", "cli:agent")],
      [button(`Continue: ${settings.continueSession ? "on" : "off"}`, "toggle:continue"), button(`New project: ${settings.newProject ? "on" : "off"}`, "toggle:new-project")],
      [button(`Output: ${settings.outputFormat}`, "menu:output"), button(`Slash cmds: ${settings.disableSlashCommands ? "off" : "on"}`, "toggle:disable-slash")],
      [button("Add directory", "cli:add-dir"), button("JSON schema", "cli:json-schema")],
      [button("Log file", "cli:log-file"), button("Print timeout", "cli:print-timeout")],
      [button("Conversation ID", "cli:conversation"), button("Prompt flags", "cli:prompt")],
      [button("‹ Back", "menu:main")],
    ],
  };
}

function outputFormatKeyboard(chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(chatId).outputFormat;
  return {
    inline_keyboard: [
      ["text", "json", "stream-json"].map((value) => button(`${selected === value ? "✅ " : ""}${value}`, `set:output:${value}`)),
      [button("‹ Back", "menu:cli")],
    ],
  };
}

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  if (!authorizedCallback(callback) || !callback.message || !callback.data) return;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const data = callback.data;
  await telegram.answerCallbackQuery(callback.id).catch(() => undefined);
  if (data === "noop") return;
  if (data.startsWith("menu:")) {
    const parts = data.split(":");
    await showMenu(chatId, messageId, parts[1], parts[2] ? Number(parts[2]) : 0);
    return;
  }
  if (data.startsWith("resume:page:")) {
    const page = Number(data.slice(12)) || 0;
    await showResumeMenu(chatId, page, messageId);
    return;
  }
  if (data.startsWith("resume:use:")) {
    const convId = data.slice(11).trim();
    if (!isUuid(convId)) {
      await telegram.editMessageText(chatId, messageId, "Selected conversation ID is not a valid UUID.", backKeyboard());
      return;
    }
    const summary = convDb.getConversationById(convId);
    if (!summary) {
      await telegram.editMessageText(chatId, messageId, "Selected conversation was not found or is invalid.", backKeyboard());
      return;
    }
    const currentSession = state.session(chatId) || {};
    const settings = settingsFor(chatId);
    settings.continueSession = false;
    await state.setSession(chatId, {
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
      await telegram.editMessageText(
        chatId,
        messageId,
        `Session switched.\n\n<b>${escapeHtml(summary.display_title)}</b>\n${summary.step_count} steps · last used ${relativeTime}\n\nFuture prompts will continue this conversation.`,
        { inline_keyboard: [] },
        "HTML"
      );
    } catch {
      await telegram.editMessageText(
        chatId,
        messageId,
        `Session switched.\n\n${summary.display_title}\n${summary.step_count} steps · last used ${relativeTime}\n\nFuture prompts will continue this conversation.`,
        { inline_keyboard: [] }
      ).catch(() => undefined);
    }
    await telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settings));
    return;
  }
  if (data === "action:usage") {
    enqueueJob(chatId, { kind: "usage" });
    return;
  }
  if (data === "action:credits") {
    enqueueJob(chatId, { kind: "credits" });
    return;
  }
  if (data === "action:context") {
    enqueueJob(chatId, { kind: "context" });
    return;
  }
  if (data.startsWith("cli:")) {
    const command = data.slice(4);
    if (["models", "agents", "changelog", "plugins", "help", "version"].includes(command)) await cliOutput(chatId, messageId, command as CliCommand);
    else if (command === "update") await runCustomAgy(chatId, ["update"]);
    else await showCliOption(chatId, messageId, command);
    return;
  }
  if (data.startsWith("toggle:")) {
    const option = data.slice(7);
    const settings = settingsFor(chatId);
    if (option === "continue") settings.continueSession = !settings.continueSession;
    if (option === "new-project") settings.newProject = !settings.newProject;
    if (option === "disable-slash") settings.disableSlashCommands = !settings.disableSlashCommands;
    await saveSettings(chatId, settings);
    await telegram.editMessageText(chatId, messageId, "CLI options updated.", cliOptionsKeyboard(chatId));
    return;
  }
  if (data === "action:setdefault") {
    await persistDefaultSettings(chatId, messageId);
    return;
  }
  if (data === "action:update_bot") {
    await updateBot(chatId, messageId);
    return;
  }
  if (data === "action:new") {
    await state.resetSession(chatId);
    await telegram.editMessageText(chatId, messageId, sessionInfoHtml(chatId), { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] }, "HTML");
    await telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settingsFor(chatId)));
    return;
  }
  if (data === "action:cancel") {
    const result = queue.cancelForChat(chatId);
    await telegram.editMessageText(chatId, messageId, `Cancelled: ${result.removed} queued, active=${result.activeCancelled ? "yes" : "no"}.`, { inline_keyboard: [] });
    await telegram.sendMessage(chatId, "Controls ready.", createMainKeyboard(settingsFor(chatId)));
    return;
  }
  if (data.startsWith("set:")) {
    const [, key, value] = data.split(":");
    const settings = settingsFor(chatId);
    if (key === "model" && isModelAllowed(value)) {
      settings.model = value;
      const match = value.match(/-(low|medium|high)$/i);
      if (match) {
        const eff = match[1].toLowerCase();
        if (isEffort(eff)) settings.effort = eff;
      }
      await saveSettings(chatId, settings);
      const text = `Model set to <b>${escapeHtml(modelLabel(value))}</b>.\n\nWould you like to set this as your permanent default?`;
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [button("⭐ Yes, set as Default", "action:setdefault"), button("👌 Only this session", "menu:main")]
        ]
      };
      await telegram.editMessageText(chatId, messageId, text, keyboard, "HTML");
      await telegram.sendMessage(chatId, "Controls updated.", createMainKeyboard(settings));
      return;
    }
    if (key === "effort" && isEffort(value)) settings.effort = value;
    if (key === "mode" && isMode(value)) settings.mode = value;
    if (key === "sandbox" && ["on", "off"].includes(value) && (value === "on" || config.agy.allowSandboxDisable || !config.agy.sandbox)) settings.sandbox = value === "on";
    if (key === "output" && isOutputFormat(value)) settings.outputFormat = value;
    if (key === "verbose" && isVerbose(value)) settings.verbose = value;
    await saveSettings(chatId, settings);
    if (key === "output") await telegram.editMessageText(chatId, messageId, "Output format updated.", cliOptionsKeyboard(chatId));
    else if (key === "verbose") await telegram.editMessageText(chatId, messageId, `Verbose level set to ${value}.`, verboseKeyboard(chatId));
    else await showMain(chatId, messageId);
  }
}

async function showCliOption(chatId: ChatId, messageId: number, option: string): Promise<void> {
  const examples: Record<string, string> = {
    project: "/agy --project PROJECT --print \"prompt\"",
    agent: "/agy --agent NAME --print \"prompt\"",
    continue: "/agy --continue --print \"prompt\"",
    "new-project": "/agy --new-project --print \"prompt\"",
    "output-format": "/agy --output-format text --print \"prompt\"",
    "disable-slash": "/agy --disable-slash-commands --print \"prompt\"",
    "add-dir": "/agy --add-dir /path --print \"prompt\"",
    "json-schema": "/agy --json-schema '{\"type\":\"object\"}' --print \"prompt\"",
    "log-file": "/agy --log-file /path/log --print \"prompt\"",
    "print-timeout": "/agy --print-timeout 10m --print \"prompt\"",
    conversation: "/agy --conversation CONVERSATION_ID --print \"prompt\"",
    prompt: "/agy --print \"prompt\" --output-format stream-json",
  };
  await telegram.editMessageText(chatId, messageId, `Use this custom command:\n\n${examples[option] || "/agy --help"}`, backKeyboard());
}

function isDangerousCustomCommand(args: string[]): boolean {
  const subcommand = args[0];
  const pluginAction = ["install", "uninstall", "enable", "disable", "import", "link"].includes(args[1] || "");
  return args.includes("--dangerously-skip-permissions") || subcommand === "update" || subcommand === "install" ||
    ((subcommand === "plugin" || subcommand === "plugins") && pluginAction);
}

function customArgsForExecution(args: string[]): string[] {
  const isPrintCommand = args.includes("--print") || args.includes("-p") || args.includes("--prompt");
  const executionArgs = [...args];
  if (isPrintCommand && config.agy.sandbox && !config.agy.allowSandboxDisable && !executionArgs.includes("--sandbox")) executionArgs.push("--sandbox");
  if (isPrintCommand && config.agy.allowDangerouslySkipPermissions && !executionArgs.includes("--dangerously-skip-permissions")) executionArgs.push("--dangerously-skip-permissions");
  return executionArgs;
}

async function runCustomAgy(chatId: ChatId, args: string[], confirmed = false): Promise<void> {
  const validation = validateCustomArgs(args);
  if (validation) { await reply(chatId, validation, createMainKeyboard(settingsFor(chatId))); return; }
  if (args.includes("--dangerously-skip-permissions") && !config.agy.allowDangerouslySkipPermissions) {
    await reply(chatId, "--dangerously-skip-permissions is disabled by server policy.", createMainKeyboard(settingsFor(chatId))); return;
  }
  if (isDangerousCustomCommand(args) && !confirmed) {
    pendingDangerousCommands.set(String(chatId), args);
    await reply(chatId, `This command can change the AGY installation, plugins, or permission policy:\n\nagy ${args.join(" ")}\n\nSend /agy-confirm to execute it, or /cancel to discard it.`, createMainKeyboard(settingsFor(chatId)));
    return;
  }
  const executionArgs = customArgsForExecution(args);
  pendingDangerousCommands.delete(String(chatId));
  await reply(chatId, `Running agy ${executionArgs.join(" ")}...`, createMainKeyboard(settingsFor(chatId)));
  const controller = new AbortController();
  controllers.set(`custom:${chatId}`, controller);
  try {
    const output = await runAgyCommand(config.agy, executionArgs, config.agy.timeoutMs, controller.signal);
    await reply(chatId, `AGY command result\n\n${output}`, createMainKeyboard(settingsFor(chatId)));
  } catch (error) {
    if (!controller.signal.aborted) await reply(chatId, `AGY command failed: ${(error as Error).message}`, createMainKeyboard(settingsFor(chatId)));
  } finally {
    if (controllers.get(`custom:${chatId}`) === controller) controllers.delete(`custom:${chatId}`);
  }
}

function enqueueJob(chatId: ChatId, job: Partial<QueueJob>): void {
  const status = queue.statusForChat(chatId);
  let effectivePrompt = job.prompt;
  if (config.telegram.autoInterrupt) {
    if (status.active && status.active.prompt && (job.kind === "prompt" || !job.kind) && job.prompt) {
      effectivePrompt = `${status.active.prompt}\n\n[Update / Follow-up]: ${job.prompt}`;
    }
    if (status.active || status.queued > 0) {
      queue.cancelForChat(chatId);
    }
  }
  const result = queue.enqueue({
    chatId,
    kind: job.kind || "prompt",
    prompt: effectivePrompt,
    imagePath: job.imagePath || status.active?.imagePath,
    documentPath: job.documentPath || status.active?.documentPath,
    documentName: job.documentName || status.active?.documentName,
  });
  if (!result.accepted) {
    void reply(chatId, "Queue is full. Try again shortly.", createMainKeyboard(settingsFor(chatId)));
  } else if (result.position !== undefined && result.position > 1) {
    void reply(chatId, `⏳ Queued at position #${result.position}.`, createMainKeyboard(settingsFor(chatId)));
  }
}

async function handleCommand(message: TelegramMessage, command: string, args: string[]): Promise<boolean> {
  const chatId = message.chat.id;
  if (["/start", "/menu"].includes(command)) { await showMain(chatId); return true; }
  if (command === "/help") { await showMain(chatId); await cliOutput(chatId, await telegram.sendMessage(chatId, "Loading AGY CLI help...") .then((result) => result.message_id), "help"); return true; }
  if (command === "/new") {
    await state.resetSession(chatId);
    await replyWithHtml(chatId, sessionInfoHtml(chatId), createMainKeyboard(settingsFor(chatId)));
    return true;
  }
  if (["/setdefault", "/savedefault", "/save_default", "/save"].includes(command)) {
    await persistDefaultSettings(chatId);
    return true;
  }
  if (["/update", "/update_bot", "/update-bot", "/upgrade"].includes(command)) {
    await updateBot(chatId);
    return true;
  }
  if (["/restart", "/restart_bot", "/restart-bot", "/reboot"].includes(command)) {
    if (!config.telegram.allowBotUpdate) {
      await reply(chatId, "⚠️ Bot restart via Telegram is disabled.\n\nTo enable, set ALLOW_BOT_UPDATE=true in your environment.", createMainKeyboard(settingsFor(chatId)));
      return true;
    }
    const noticePath = path.join(path.dirname(config.stateFile), "pending_restart_notice.json");
    await fs.writeFile(noticePath, JSON.stringify({
      chatId: String(chatId),
      reason: "restart",
      timestamp: Date.now()
    })).catch(() => undefined);
    await reply(chatId, "🔄 Restarting AGY Telegram service...");
    if (process.platform === "linux") {
      setTimeout(() => {
        spawn("systemctl", ["--user", "restart", "agy-telegram.service"], { detached: true, stdio: "ignore" }).unref();
      }, 1000);
    }
    return true;
  }
  if (command === "/models" || command === "/model") {
    if (!args[0] || args[0].toLowerCase() === "list") {
      void refreshModels();
      await reply(chatId, "Select a model:", modelKeyboard(chatId, 0));
      return true;
    }
    if (args[0].toLowerCase() === "refresh") {
      await reply(chatId, "Refreshing available models from AGY...");
      await refreshModels();
      await reply(chatId, `Models refreshed (${getActiveModels().length} available).`, modelKeyboard(chatId, 0));
      return true;
    }
    const targetModel = args[0].trim();
    if (isModelAllowed(targetModel)) {
      const settings = settingsFor(chatId);
      settings.model = targetModel;
      const match = targetModel.match(/-(low|medium|high)$/i);
      if (match) {
        const eff = match[1].toLowerCase();
        if (isEffort(eff)) settings.effort = eff;
      }
      await saveSettings(chatId, settings);
      const text = `Model set to <b>${escapeHtml(modelLabel(targetModel))}</b>.\n\nWould you like to set this as your permanent default?`;
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [button("⭐ Yes, set as Default", "action:setdefault"), button("👌 Only this session", "menu:main")]
        ]
      };
      await replyWithHtml(chatId, text, keyboard);
      await telegram.sendMessage(chatId, "Controls updated.", createMainKeyboard(settings));
    } else {
      await reply(chatId, `Unknown model: ${targetModel}\nAllowed: ${getActiveModels().map((m) => m.id).join(", ")}`, modelKeyboard(chatId, 0));
    }
    return true;
  }
  if (command === "/effort") {
    if (!args[0]) {
      await reply(chatId, "Select reasoning effort:", effortKeyboard(chatId));
      return true;
    }
    const targetEffort = args[0].toLowerCase().trim();
    if (isEffort(targetEffort)) {
      const settings = settingsFor(chatId);
      settings.effort = targetEffort;
      await saveSettings(chatId, settings);
      await reply(chatId, `Effort set to ${targetEffort}.`, createMainKeyboard(settings));
    } else {
      await reply(chatId, `Invalid effort: ${targetEffort}. Choose: low, medium, high.`, effortKeyboard(chatId));
    }
    return true;
  }
  if (command === "/mode") {
    if (!args[0]) {
      await reply(chatId, "Select execution mode:", modeKeyboard(chatId));
      return true;
    }
    const targetMode = args[0].toLowerCase().trim();
    if (isMode(targetMode)) {
      const settings = settingsFor(chatId);
      settings.mode = targetMode;
      await saveSettings(chatId, settings);
      await reply(chatId, `Mode set to ${targetMode}.`, createMainKeyboard(settings));
    } else {
      await reply(chatId, `Invalid mode: ${targetMode}. Choose: plan, accept-edits.`, modeKeyboard(chatId));
    }
    return true;
  }
  if (command === "/sandbox") {
    if (!args[0]) {
      await reply(chatId, `Sandbox is ${settingsFor(chatId).sandbox ? "enabled" : "disabled"}.`, sandboxKeyboard(chatId));
      return true;
    }
    const val = args[0].toLowerCase().trim();
    if (["on", "off"].includes(val)) {
      const enable = val === "on";
      if (!enable && !config.agy.allowSandboxDisable && config.agy.sandbox) {
        await reply(chatId, "Sandbox disabling is locked by server configuration.", createMainKeyboard(settingsFor(chatId)));
        return true;
      }
      const settings = settingsFor(chatId);
      settings.sandbox = enable;
      await saveSettings(chatId, settings);
      await reply(chatId, `Sandbox ${enable ? "enabled" : "disabled"}.`, createMainKeyboard(settings));
    } else {
      await reply(chatId, "Use /sandbox on|off.", sandboxKeyboard(chatId));
    }
    return true;
  }
  if (command === "/verbose") {
    if (!args[0]) {
      await reply(chatId, "Select progress verbosity:", verboseKeyboard(chatId));
      return true;
    }
    const target = args[0].toLowerCase().trim();
    if (isVerbose(target)) {
      const settings = settingsFor(chatId);
      settings.verbose = target;
      await saveSettings(chatId, settings);
      await reply(chatId, `Verbose level set to ${target}.`, createMainKeyboard(settings));
    } else {
      await reply(chatId, `Invalid verbose level: ${target}. Choose: detailed, compact, silent.`, verboseKeyboard(chatId));
    }
    return true;
  }
  if (command === "/agent") {
    const settings = settingsFor(chatId);
    if (!args[0]) {
      await reply(chatId, `Current agent: ${settings.agent || "default"}\n\nUse: /agent NAME or /agent clear\nList agents: /agents`, createMainKeyboard(settings));
      return true;
    }
    const target = args.join(" ").trim();
    settings.agent = target.toLowerCase() === "clear" || target.toLowerCase() === "default" ? null : target;
    await saveSettings(chatId, settings);
    await reply(chatId, `Agent set to: ${settings.agent || "default"}.`, createMainKeyboard(settings));
    return true;
  }
  if (command === "/project") {
    const settings = settingsFor(chatId);
    if (!args[0]) {
      await reply(chatId, `Current project: ${settings.project || "default"}\n\nUse: /project ID or /project clear`, createMainKeyboard(settings));
      return true;
    }
    const target = args.join(" ").trim();
    settings.project = target.toLowerCase() === "clear" || target.toLowerCase() === "default" ? null : target;
    await saveSettings(chatId, settings);
    await reply(chatId, `Project set to: ${settings.project || "default"}.`, createMainKeyboard(settings));
    return true;
  }
  if (command === "/add-dir") {
    const settings = settingsFor(chatId);
    if (!args[0]) {
      const dirs = settings.addDirs?.length ? settings.addDirs.join("\n") : "(none)";
      await reply(chatId, `Additional workspace directories:\n${dirs}\n\nUse: /add_dir PATH or /add_dir clear`, createMainKeyboard(settings));
      return true;
    }
    const target = args.join(" ").trim();
    if (target.toLowerCase() === "clear") {
      settings.addDirs = [];
      await saveSettings(chatId, settings);
      await reply(chatId, "Additional directories cleared.", createMainKeyboard(settings));
      return true;
    }
    settings.addDirs = Array.from(new Set([...(settings.addDirs || []), target]));
    await saveSettings(chatId, settings);
    await reply(chatId, `Added directory: ${target}\nTotal dirs: ${settings.addDirs.length}`, createMainKeyboard(settings));
    return true;
  }
  if (command === "/output-format") {
    if (!args[0]) {
      await reply(chatId, "Select the output format:", outputFormatKeyboard(chatId));
      return true;
    }
    const target = args[0].toLowerCase().trim();
    if (isOutputFormat(target)) {
      const settings = settingsFor(chatId);
      settings.outputFormat = target;
      await saveSettings(chatId, settings);
      await reply(chatId, `Output format set to ${target}.`, createMainKeyboard(settings));
    } else {
      await reply(chatId, "Invalid format. Choose: text, json, stream-json.", outputFormatKeyboard(chatId));
    }
    return true;
  }
  if (command === "/json-schema") {
    const settings = settingsFor(chatId);
    if (!args[0]) {
      await reply(chatId, `Current JSON schema: ${settings.jsonSchema || "none"}\n\nUse: /json_schema JSON_OR_PATH or /json_schema clear`, createMainKeyboard(settings));
      return true;
    }
    const target = args.join(" ").trim();
    settings.jsonSchema = target.toLowerCase() === "clear" ? null : target;
    await saveSettings(chatId, settings);
    await reply(chatId, `JSON schema ${settings.jsonSchema ? "updated" : "cleared"}.`, createMainKeyboard(settings));
    return true;
  }
  if (command === "/log-file") {
    const settings = settingsFor(chatId);
    if (!args[0]) {
      await reply(chatId, `Current log file: ${settings.logFile || "none"}\n\nUse: /log_file PATH or /log_file clear`, createMainKeyboard(settings));
      return true;
    }
    const target = args.join(" ").trim();
    settings.logFile = target.toLowerCase() === "clear" ? null : target;
    await saveSettings(chatId, settings);
    await reply(chatId, `Log file ${settings.logFile ? "set to " + settings.logFile : "cleared"}.`, createMainKeyboard(settings));
    return true;
  }
  if (command === "/print-timeout") {
    const settings = settingsFor(chatId);
    if (!args[0]) {
      await reply(chatId, `Current print timeout: ${settings.printTimeout || "default"}\n\nUse: /print_timeout 10m or /print_timeout clear`, createMainKeyboard(settings));
      return true;
    }
    const target = args.join(" ").trim();
    settings.printTimeout = target.toLowerCase() === "clear" ? null : target;
    await saveSettings(chatId, settings);
    await reply(chatId, `Print timeout ${settings.printTimeout ? "set to " + settings.printTimeout : "reset to default"}.`, createMainKeyboard(settings));
    return true;
  }
  if (command === "/resume" || command === "/sessions") { await showResumeMenu(chatId, args[0] ? Math.max(0, Number(args[0]) - 1) : 0); return true; }
  if (command === "/continue") {
    if (!args[0] || args[0].toLowerCase() === "list") {
      await showResumeMenu(chatId, 0);
      return true;
    }
    if (["on", "off"].includes(args[0].toLowerCase())) {
      const settings = settingsFor(chatId);
      settings.continueSession = args[0].toLowerCase() === "on";
      await saveSettings(chatId, settings);
      await reply(chatId, `/continue ${settings.continueSession ? "enabled" : "disabled"}.`, createMainKeyboard(settings));
      return true;
    }
    await reply(chatId, `Use /continue to browse sessions, or /continue on|off to toggle continuation flag.`, createMainKeyboard(settingsFor(chatId)));
    return true;
  }
  if (["/new-project", "/disable-slash-commands"].includes(command)) { const key = command === "/new-project" ? "newProject" : "disableSlashCommands"; const settings = settingsFor(chatId); if (!args[0]) await reply(chatId, `${command}: ${settings[key] ? "on" : "off"}\n${sessionOptionUsage(command.slice(1))}`, createMainKeyboard(settings)); else if (["on", "off"].includes(args[0].toLowerCase())) { settings[key] = args[0].toLowerCase() === "on"; await saveSettings(chatId, settings); await reply(chatId, `${command} ${settings[key] ? "enabled" : "disabled"}.`, createMainKeyboard(settings)); } else await reply(chatId, `Use on or off.\n${sessionOptionUsage(command.slice(1))}`, createMainKeyboard(settings)); return true; }
  if (command === "/agents") { await reply(chatId, "Loading AGY agents...", createMainKeyboard(settingsFor(chatId))); const output = await runAgyCommand(config.agy, ["agents"]).catch((error) => `Could not read AGY agents: ${(error as Error).message}`); await reply(chatId, `AGY agents\n\n${output || "No custom agents available."}`, createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/changelog") { const output = await runAgyCommand(config.agy, ["changelog"]).catch((error) => `Could not read AGY changelog: ${(error as Error).message}`); await reply(chatId, `AGY changelog\n\n${output}`, createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/plugins") { const output = await runAgyCommand(config.agy, ["plugins", "list"]).catch((error) => `Could not read AGY plugins: ${(error as Error).message}`); await reply(chatId, `AGY plugins\n\n${output || "No imported plugins."}`, createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/cli-help") { const output = await runAgyCommand(config.agy, ["--help"]).catch((error) => `Could not read AGY help: ${(error as Error).message}`); await reply(chatId, `AGY CLI help\n\n${output}`, createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/version") { const output = await runAgyCommand(config.agy, ["--version"]).catch((error) => `Could not read AGY version: ${(error as Error).message}`); await reply(chatId, `AGY version: ${output}`, createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/session") { await reply(chatId, sessionText(chatId), createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/usage" || command === "/quota") { enqueueJob(chatId, { kind: "usage" }); return true; }
  if (command === "/credits") { enqueueJob(chatId, { kind: "credits" }); return true; }
  if (command === "/context") { enqueueJob(chatId, { kind: "context" }); return true; }
  if (command === "/tokens") { await reply(chatId, usageReport(chatId), createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/status") { const status = queue.statusForChat(chatId); await reply(chatId, `Status: ${status.active ? `running (${status.active.id})` : "idle"}\nQueued for this chat: ${status.queued}\nTotal queued: ${status.totalQueued}`, createMainKeyboard(settingsFor(chatId))); return true; }
  if (command === "/cancel" || command === "/kill") {
    pendingDangerousCommands.delete(String(chatId));
    controllers.get(`prompt:${chatId}`)?.abort();
    controllers.get(`custom:${chatId}`)?.abort();
    const result = queue.cancelForChat(chatId);
    await reply(chatId, `⛔ Cancelled: ${result.removed} queued job(s) removed, active AGY process terminated.`, createMainKeyboard(settingsFor(chatId)));
    return true;
  }
  if (command === "/learn") {
    const promptText = args.length > 0
      ? `/learn ${args.join(" ")}`
      : "Please analyze our recent conversation and derive persistent rules or skills using /learn.";
    enqueueJob(chatId, { prompt: promptText, kind: "prompt" });
    return true;
  }
  if (command === "/compact") {
    const promptText = args.length > 0
      ? `Please compact the conversation context: ${args.join(" ")}`
      : "Please compact our conversation context by consolidating vital state, active goals, decisions, and modified files internally, discarding temporary logs, and providing a concise token savings summary.";
    enqueueJob(chatId, { prompt: promptText, kind: "prompt" });
    return true;
  }
  if (command === "/agy-confirm") { const pending = pendingDangerousCommands.get(String(chatId)); if (!pending) await reply(chatId, "There is no pending dangerous AGY command.", createMainKeyboard(settingsFor(chatId))); else await runCustomAgy(chatId, pending, true); return true; }
  return false;
}

function addUsage(previous: Usage | null | undefined, current: Usage | null): Usage | null {
  if (!current) return previous || null;
  const total: Usage = { ...(previous || {}) };
  for (const [key, value] of Object.entries(current) as Array<[keyof Usage, number]>) total[key] = (total[key] || 0) + value;
  return total;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

const sentImagePathsByChat = new Map<string, Set<string>>();

function didExecuteImageGeneration(result: AgyResult): boolean {
  for (const event of result.events) {
    const step = event.step_update as Record<string, unknown> | undefined;
    const tool = step?.tool_info as Record<string, unknown> | undefined;
    const toolName = String(tool?.name || tool?.tool_name || tool?.tool || "").toLowerCase();
    if (toolName.includes("generate_image") || toolName.includes("image")) {
      return true;
    }
  }
  return /Generated image is saved at|!\[.*?\]\(file:\/\/\/.*?\.(?:png|jpg|jpeg|webp)\)/i.test(result.text);
}

async function detectAndSendGeneratedImages(
  chatId: ChatId,
  result: AgyResult,
  conversationId: string | null | undefined,
  jobStartedAt: number
): Promise<void> {
  // STRICT GUARD: If the AI never generated an image in this turn, do not scan or send anything!
  if (!didExecuteImageGeneration(result)) return;

  const chatKey = String(chatId);
  let sentImagePaths = sentImagePathsByChat.get(chatKey);
  if (!sentImagePaths) {
    sentImagePaths = new Set<string>();
    sentImagePathsByChat.set(chatKey, sentImagePaths);
  }

  const imagesToSend = new Set<string>();
  const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

  // 1. Extract markdown image / file links from result.text: ![caption](file:///path/to/image.png) or file:///path/to/image.png
  const fileMatches = result.text.matchAll(/(?:file:\/\/|['"])((\/[^\s'")]+)\.(png|jpg|jpeg|webp))(?:\b|['"]|\))/gi);
  for (const match of fileMatches) {
    const fullPath = `${match[2]}.${match[3]}`;
    if (!sentImagePaths.has(fullPath) && (await fileExists(fullPath))) {
      imagesToSend.add(fullPath);
    }
  }

  // 2. Scan conversation artifact directory for images created ONLY DURING THIS JOB (mtime >= jobStartedAt - 1000)
  const convId = conversationId || result.conversationId;
  if (convId) {
    const homeDir = os.homedir();
    const brainDir = path.join(homeDir, ".gemini/antigravity-cli/brain", convId);
    try {
      const entries = await fs.readdir(brainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (imageExtensions.has(ext)) {
            const filePath = path.join(brainDir, entry.name);
            if (!sentImagePaths.has(filePath)) {
              const stat = await fs.stat(filePath).catch(() => null);
              if (stat && stat.mtimeMs >= jobStartedAt - 1000) {
                imagesToSend.add(filePath);
              }
            }
          }
        }
      }
    } catch {
      // directory might not exist yet
    }
  }

  // 3. Dispatch photos to Telegram chat & mark as sent
  for (const imagePath of imagesToSend) {
    sentImagePaths.add(imagePath);
    try {
      await telegram.sendChatAction(chatId, "upload_photo");
      const basename = path.basename(imagePath);
      await telegram.sendPhoto(chatId, imagePath, `🎨 Generated Image: ${basename}`);
    } catch (error) {
      console.error(`Failed to send generated image (${imagePath}):`, error);
    }
  }
}

async function processJob(job: QueueJob, isCancelled: () => boolean): Promise<void> {
  const controller = new AbortController();
  controllers.set(`prompt:${job.chatId}`, controller);
  let progressMessage: { message_id: number } | null = null;
  let lastProgressAt = 0;
  let progressUpdate = Promise.resolve();
  let responseDraft = "";

  if (job.kind === "usage") {
    try {
      await telegram.sendChatAction(job.chatId);
      progressMessage = await telegram.sendMessage(job.chatId, "Checking AGY models & quota via PTY...");
      const output = await runPtyCommand(config.agy, "/usage", { timeoutMs: 15_000, signal: controller.signal });
      if (isCancelled()) return;
      const formatted = parseUsageQuota(output);
      if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, "Quota check complete.").catch(() => undefined);
      await replyWithHtml(job.chatId, formatted, createMainKeyboard(settingsFor(job.chatId)));
    } catch (error) {
      if (!isCancelled()) {
        const errorMsg = (error as Error).message;
        if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, `Could not read AGY quota: ${errorMsg}`).catch(() => undefined);
        await reply(job.chatId, `Could not read AGY quota: ${errorMsg}`, createMainKeyboard(settingsFor(job.chatId)));
      }
    } finally {
      controllers.delete(`prompt:${job.chatId}`);
    }
    return;
  }

  if (job.kind === "credits") {
    try {
      await telegram.sendChatAction(job.chatId);
      progressMessage = await telegram.sendMessage(job.chatId, "Checking AGY credits via PTY...");
      const output = await runPtyCommand(config.agy, "/credits", { timeoutMs: 15_000, signal: controller.signal });
      if (isCancelled()) return;
      const formatted = parseCredits(output);
      if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, "Credits check complete.").catch(() => undefined);
      await replyWithHtml(job.chatId, formatted, createMainKeyboard(settingsFor(job.chatId)));
    } catch (error) {
      if (!isCancelled()) {
        const errorMsg = (error as Error).message;
        if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, `Could not read AGY credits: ${errorMsg}`).catch(() => undefined);
        await reply(job.chatId, `Could not read AGY credits: ${errorMsg}`, createMainKeyboard(settingsFor(job.chatId)));
      }
    } finally {
      controllers.delete(`prompt:${job.chatId}`);
    }
    return;
  }

  if (job.kind === "context") {
    try {
      const session = state.session(job.chatId);
      if (!session?.conversationId) {
        await reply(job.chatId, "No active AGY conversation. Resume or start a conversation first.", createMainKeyboard(settingsFor(job.chatId)));
        return;
      }
      await telegram.sendChatAction(job.chatId);
      progressMessage = await telegram.sendMessage(job.chatId, "Reading Active Context from the current AGY conversation via PTY...");
      const output = await runPtyCommand(config.agy, "/context", { conversationId: session.conversationId, timeoutMs: 15_000, signal: controller.signal });
      if (isCancelled()) return;
      const formatted = parseContext(output);
      if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, "Active Context check complete.").catch(() => undefined);
      await replyWithHtml(job.chatId, formatted, createMainKeyboard(settingsFor(job.chatId)));
    } catch (error) {
      if (!isCancelled()) {
        const errorMsg = (error as Error).message;
        if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, `Could not read Active Context: ${errorMsg}`).catch(() => undefined);
        await reply(job.chatId, `Could not read Active Context: ${errorMsg}`, createMainKeyboard(settingsFor(job.chatId)));
      }
    } finally {
      controllers.delete(`prompt:${job.chatId}`);
    }
    return;
  }

  let heartbeatTimer: NodeJS.Timeout | undefined;
  let typingInterval: NodeJS.Timeout | null = null;
  try {
    await telegram.sendChatAction(job.chatId);
    typingInterval = setInterval(() => {
      telegram.sendChatAction(job.chatId).catch(() => undefined);
    }, 4000);
    const session = state.session(job.chatId);
    const settings = settingsFor(job.chatId);
    progressMessage = await telegram.sendMessage(job.chatId, `⏳ AGY is starting... (${modelLabel(settings.model)})`);
    const startedAt = Date.now();
    const recentSteps: string[] = [];
    const updateProgress = (stepDesc: string | null): void => {
      if (!progressMessage) return;
      if (stepDesc && !recentSteps.includes(stepDesc)) {
        recentSteps.push(stepDesc);
        if (recentSteps.length > 4) recentSteps.shift();
      }

      if (Date.now() - lastProgressAt < 1200) return;
      lastProgressAt = Date.now();

      const verbose = settings.verbose || "detailed";
      if (verbose === "silent") return;

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

      if (responseDraft.trim()) {
        const draft = responseDraft.length > 2500 ? `...${responseDraft.slice(-2500)}` : responseDraft;
        const stepsDisplay = recentSteps.map((s, idx) => {
          const isLatest = idx === recentSteps.length - 1;
          return `${isLatest ? "➜" : "✓"} ${s}`;
        });
        const stepsText = stepsDisplay.length ? `\n${stepsDisplay.join("\n")}\n\n` : "\n\n";
        progressUpdate = progressUpdate.then(() => telegram.editMessageText(job.chatId, progressMessage!.message_id, `⚡ ${elapsed}s · ${modelLabel(settings.model)}\n${stepsText}${draft}`)).catch(() => undefined);
      } else {
        const stepsDisplay = recentSteps.map((s, idx) => {
          const isLatest = idx === recentSteps.length - 1;
          return `${isLatest ? "➜" : "✓"} ${s}`;
        });
        const body = stepsDisplay.length ? `\n\n${stepsDisplay.join("\n")}` : "\n\nInitializing...";
        progressUpdate = progressUpdate.then(() => telegram.editMessageText(job.chatId, progressMessage!.message_id, `⏳ AGY is working... (${elapsed}s · ${modelLabel(settings.model)})${body}`)).catch(() => undefined);
      }
    };

    let lastEventReceivedAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (isCancelled() || controller.signal.aborted) return;
      const idleSec = Math.floor((Date.now() - lastEventReceivedAt) / 1000);
      if (idleSec >= 3 && !responseDraft.trim()) {
        updateProgress(null);
      }
    }, 2500);

    const progressTicker = setInterval(() => {
      updateProgress(null);
    }, 2000);

    let result;
    try {
      await state.setInFlight(job.chatId, {
        prompt: job.prompt,
        kind: job.kind,
        imagePath: job.imagePath,
        documentPath: job.documentPath,
        documentName: job.documentName,
        startedAt: Date.now(),
      });
      result = await runAgy(config.agy, job.prompt || "", session?.conversationId || null, {
        ...settings,
        signal: controller.signal,
        imagePath: job.imagePath,
        documentPath: job.documentPath,
        documentName: job.documentName,
        onEvent: (event: StreamEvent) => {
          lastEventReceivedAt = Date.now();
          const step = event.step_update as Record<string, unknown> | undefined;
          const textDelta = typeof step?.text_delta === "string" ? step.text_delta : "";
          if (textDelta) responseDraft += textDelta;
          const update = formatStepUpdate(step);
          updateProgress(update);
        },
      });
    } finally {
      clearInterval(progressTicker);
      await state.clearInFlight(job.chatId);
    }
    if (isCancelled() || controller.signal.aborted) {
      if (progressMessage) await telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      return;
    }
    const latestSession = state.session(job.chatId);
    const lastRun = { model: result.model || settings.model, usage: result.usage, durationMs: result.durationMs, numTurns: result.numTurns, toolCalls: result.toolCalls, status: result.status || "SUCCESS", completedAt: new Date().toISOString() };
    const effectiveConvId = result.conversationId || session?.conversationId;
    const initialTitle = (job.prompt ? job.prompt.replace(/\s+/g, " ").slice(0, 60).trim() : "") || "Conversation";
    const convTitle = latestSession?.conversationTitle || initialTitle;
    const stepCount = (latestSession?.conversationStepCount || 0) + (result.numTurns || 1);

    await state.setSession(job.chatId, {
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      conversationTitle: convTitle,
      conversationStepCount: stepCount,
      conversationLastModifiedAt: Date.now(),
      settings: latestSession?.settings || settings,
      lastRun,
      usageTotals: addUsage(latestSession?.usageTotals, result.usage),
      updatedAt: new Date().toISOString(),
    });

    if (effectiveConvId) {
      convDb.upsertConversation({
        conversation_id: effectiveConvId,
        preview: convTitle,
        title: convTitle,
        step_count: stepCount,
        last_modified_time: Date.now(),
        project_id: settings.project || "default-cli-project",
        workspace_uris: `["file://${config.agy.workspace}"]`,
      });
    }

    await progressUpdate;
    if (progressMessage) {
      const mode = config.telegram.progressMode || "full";
      if (mode === "delete") {
        await telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      } else if (mode === "compact") {
        const duration = ((result.durationMs || Date.now() - startedAt) / 1000).toFixed(1);
        const tokens = result.usage?.total_tokens ? ` · ${result.usage.total_tokens.toLocaleString()} tok` : "";
        await telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          `⚡ ${duration}s${tokens} · ${modelLabel(result.model || settings.model)}`
        ).catch(() => undefined);
      } else {
        await telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          `AGY completed in ${((result.durationMs || Date.now() - startedAt) / 1000).toFixed(1)}s.\nModel: ${modelLabel(result.model || settings.model)}\n${usageText(result.usage, result.model || settings.model)}`
        ).catch(() => undefined);
      }
    }
    await detectAndSendGeneratedImages(job.chatId, result, effectiveConvId, startedAt);
    const mediaFiles = await findReferencedMediaFiles(result.text, config.agy.workspace);
    for (const mediaPath of mediaFiles) {
      const ext = path.extname(mediaPath).toLowerCase();
      const isPhoto = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
      try {
        if (isPhoto) {
          await telegram.sendPhoto(job.chatId, mediaPath);
        } else {
          await telegram.sendDocumentFile(job.chatId, mediaPath);
        }
      } catch (error) {
        console.error(`Failed to send media file ${mediaPath}: ${(error as Error).message}`);
      } finally {
        if (mediaPath.startsWith(os.tmpdir()) || mediaPath.startsWith("/tmp/")) {
          await fs.unlink(mediaPath).catch(() => undefined);
        }
      }
    }

    if (result.text.length > config.telegram.maxMessageChars * 2) await telegram.sendDocument(job.chatId, `agy-${job.id}.md`, result.text);
    else await replyWithFormattedResponse(job.chatId, result.text, createMainKeyboard(settingsFor(job.chatId)));
  } catch (error) {
    if (isCancelled() || controller.signal.aborted || (error instanceof Error && error.message.includes("cancelled"))) {
      if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, "⛔ Request cancelled by user.").catch(() => undefined);
    } else {
      if (progressMessage) await telegram.editMessageText(job.chatId, progressMessage.message_id, `AGY failed: ${(error as Error).message}`).catch(() => undefined);
      await reply(job.chatId, `AGY failed: ${(error as Error).message}`, createMainKeyboard(settingsFor(job.chatId)));
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    clearInterval(heartbeatTimer);
    controllers.delete(`prompt:${job.chatId}`);
    sentImagePathsByChat.delete(String(job.chatId));
    if (job.imagePath) {
      await fs.unlink(job.imagePath).catch(() => undefined);
    }
  }
}

const queue = new JobQueue(config.queue.maxSize, processJob);
const originalCancel = queue.cancelForChat.bind(queue);
queue.cancelForChat = (chatId: ChatId) => {
  const result = originalCancel(chatId);
  controllers.get(`prompt:${chatId}`)?.abort();
  controllers.get(`custom:${chatId}`)?.abort();
  return result;
};

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  try {
    if (update.callback_query) { await handleCallback(update.callback_query); return; }
    const message = update.message;
    if (!message || !authorizedMessage(message)) return;

    let imagePath: string | undefined;
    let documentPath: string | undefined;
    let documentName: string | undefined;
    let fileId: string | undefined;
    let fileExt = ".jpg";
    let isDoc = false;

    if (message.photo && message.photo.length > 0) {
      fileId = message.photo[message.photo.length - 1].file_id;
    } else if (message.document) {
      fileId = message.document.file_id;
      isDoc = true;
      if (message.document.mime_type?.startsWith("image/")) {
        isDoc = false;
        if (message.document.file_name && path.extname(message.document.file_name)) {
          fileExt = path.extname(message.document.file_name);
        }
      }
    }

    if (fileId) {
      try {
        await telegram.sendChatAction(message.chat.id, "typing");
        const fileInfo = await telegram.getFile(fileId);
        if (fileInfo.file_path) {
          if (isDoc && message.document) {
            const rawName = message.document.file_name || `doc_${Date.now()}.bin`;
            const cleanName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const uploadsDir = path.join(config.agy.workspace, "uploads");
            const dest = path.join(uploadsDir, cleanName);
            documentPath = await telegram.downloadFile(fileInfo.file_path, dest);
            documentName = cleanName;
          } else {
            const dest = path.join(config.tempDir, `photo_${Date.now()}_${fileId.slice(-8)}${fileExt}`);
            imagePath = await telegram.downloadFile(fileInfo.file_path, dest);
          }
        }
      } catch (err) {
        await reply(message.chat.id, `Failed to download attachment: ${(err as Error).message}`, createMainKeyboard(settingsFor(message.chat.id)));
        return;
      }
    }

    const text = (message.text || message.caption || "").trim();
    if (!text && !imagePath && !documentPath) return;

    const parts = text.split(/\s+/);
    const command = parts[0] ? parts[0].toLowerCase().split("@")[0].replace(/_/g, "-") : "";
    if (command === "/agy") { try { void runCustomAgy(message.chat.id, parseCommandArgs(text.slice(parts[0].length))); } catch (error) { await reply(message.chat.id, `Invalid /agy command: ${(error as Error).message}`, createMainKeyboard(settingsFor(message.chat.id))); } return; }
    if (command.startsWith("/") && await handleCommand(message, command, parts.slice(1))) return;
    const buttonText = text;
    if (buttonText === "✨ New session" || buttonText === "✨ New") {
      await state.resetSession(message.chat.id);
      await replyWithHtml(message.chat.id, sessionInfoHtml(message.chat.id), createMainKeyboard(settingsFor(message.chat.id)));
      return;
    }
    if (buttonText === "🤖 Model") { await reply(message.chat.id, "Select a model:", modelKeyboard(message.chat.id)); return; }
    if (buttonText === "📊 Quota" || buttonText === "📊 Usage / Quota" || buttonText === "📊 Usage") {
      enqueueJob(message.chat.id, { kind: "usage" });
      return;
    }
    if (buttonText.startsWith("⚙ Mode:")) { const settings = settingsFor(message.chat.id); settings.mode = settings.mode === "plan" ? "accept-edits" : "plan"; await saveSettings(message.chat.id, settings); await reply(message.chat.id, `Mode changed to ${settings.mode}.`, createMainKeyboard(settings)); return; }
    if (buttonText.startsWith("📢 Verbose:") || buttonText.startsWith("📢 Verbose")) {
      const settings = settingsFor(message.chat.id);
      const levels: Array<SessionSettings["verbose"]> = ["detailed", "compact", "silent"];
      const nextIdx = (levels.indexOf(settings.verbose || "detailed") + 1) % levels.length;
      settings.verbose = levels[nextIdx];
      await saveSettings(message.chat.id, settings);
      await reply(message.chat.id, `Verbose level set to ${settings.verbose}.`, createMainKeyboard(settings));
      return;
    }
    if (text.startsWith("/")) { await reply(message.chat.id, "Unknown command. Use /menu.", createMainKeyboard(settingsFor(message.chat.id))); return; }
    enqueueJob(message.chat.id, { prompt: text, kind: "prompt", imagePath, documentPath, documentName });
  } catch (error) {
    console.error("handleUpdate error:", error);
  }
}

async function main(): Promise<void> {
  console.log(`agy-telegram started; workspace=${config.agy.workspace}; privateOnly=${config.telegram.privateOnly}`);
  await refreshModels().catch((error) => console.error(`refreshModels failed: ${(error as Error).message}`));
  await telegram.setMyCommands([
    { command: "menu", description: "Show the bottom control keyboard" },
    { command: "new", description: "Start a new AGY conversation" },
    { command: "resume", description: "Resume previous conversation from database" },
    { command: "usage", description: "Check live models & quota via PTY" },
    { command: "credits", description: "Check live AGY credits via PTY" },
    { command: "context", description: "Show active context for current conversation" },
    { command: "tokens", description: "Show token usage and turns" },
    { command: "quota", description: "Alias for /usage" },
    { command: "status", description: "Show current job status" },
    { command: "cancel", description: "Cancel the active or queued job" },
    { command: "model", description: "Show or choose the model" },
    { command: "effort", description: "Show or change reasoning effort" },
    { command: "mode", description: "Show or change plan/edit mode" },
    { command: "sandbox", description: "Show or change sandbox mode" },
    { command: "verbose", description: "Show or change verbose level (detailed, compact, silent)" },
    { command: "session", description: "Show session settings" },
    { command: "learn", description: "Learn reusable rules/skills from recent chat" },
    { command: "compact", description: "Compact context and create state snapshot to save tokens" },
    { command: "help", description: "Show available commands" },
    { command: "agents", description: "List available AGY agents" },
    { command: "agent", description: "Select an AGY agent" },
    { command: "project", description: "Set the AGY project" },
    { command: "add_dir", description: "Add an AGY workspace directory" },
    { command: "output_format", description: "Set AGY output format" },
    { command: "json_schema", description: "Set AGY JSON schema" },
    { command: "log_file", description: "Set AGY log file" },
    { command: "print_timeout", description: "Set AGY print timeout" },
    { command: "continue", description: "Toggle AGY conversation continuation" },
    { command: "new_project", description: "Toggle new AGY project mode" },
    { command: "disable_slash_commands", description: "Toggle AGY slash expansion" },
    { command: "changelog", description: "Show AGY changelog" },
    { command: "plugins", description: "List imported AGY plugins" },
    { command: "cli_help", description: "Show AGY CLI help" },
    { command: "version", description: "Show AGY CLI version" },
    { command: "update", description: "Update Telegram bot from GitHub & restart" },
    { command: "restart", description: "Restart the AGY Telegram service" },
    { command: "agy", description: "Run a custom non-interactive AGY command" },
    { command: "agy_confirm", description: "Confirm a pending AGY command" },
  ]).catch((error: unknown) => console.error(`setMyCommands failed: ${(error as Error).message}`));

  // 1. Process pending restart / update notices
  const noticePath = path.join(path.dirname(config.stateFile), "pending_restart_notice.json");
  try {
    const noticeRaw = await fs.readFile(noticePath, "utf8");
    const notice = JSON.parse(noticeRaw) as { chatId: string; reason: string; commit?: string };
    await fs.unlink(noticePath).catch(() => undefined);
    if (notice.chatId) {
      if (notice.reason === "update") {
        await telegram.sendMessage(
          notice.chatId,
          `🟢 <b>Bot is back online!</b>\n\nUpdate to <code>${escapeHtml(notice.commit || "latest")}</code> completed successfully.`,
          createMainKeyboard(settingsFor(notice.chatId)),
          "HTML"
        ).catch(() => undefined);
      } else {
        await telegram.sendMessage(
          notice.chatId,
          `🟢 <b>AGY Gateway online!</b>\n\nService restarted successfully and ready to use.`,
          createMainKeyboard(settingsFor(notice.chatId)),
          "HTML"
        ).catch(() => undefined);
      }
    }
  } catch {
    // No pending restart notice
  }

  // 2. Check for interrupted in-flight jobs
  const interrupted = { ...state.inFlight };
  if (Object.keys(interrupted).length > 0) {
    await state.clearAllInFlight();
    for (const [chatId, job] of Object.entries(interrupted)) {
      if (job.prompt || job.kind === "usage" || job.kind === "credits" || job.kind === "context") {
        const promptSnippet = job.prompt ? ` (Prompt: <i>"${escapeHtml(job.prompt.slice(0, 60))}${job.prompt.length > 60 ? "..." : ""}"</i>)` : "";
        await telegram.sendMessage(
          chatId,
          `⚡ <b>AGY Gateway restarted</b>\n\nYour previous request was interrupted by a restart${promptSnippet}.\n<i>Resuming execution now...</i>`,
          createMainKeyboard(settingsFor(chatId)),
          "HTML"
        ).catch(() => undefined);

        enqueueJob(chatId, {
          kind: job.kind || "prompt",
          prompt: job.prompt,
          imagePath: job.imagePath,
          documentPath: job.documentPath,
          documentName: job.documentName,
        });
      } else {
        await telegram.sendMessage(
          chatId,
          `⚡ <b>AGY Gateway restarted</b>\n\nI am back online and ready for your next command!`,
          createMainKeyboard(settingsFor(chatId)),
          "HTML"
        ).catch(() => undefined);
      }
    }
  }

  let offset = state.offset;
  while (true) {
    try { const updates = await telegram.getUpdates(offset); for (const update of updates) { await handleUpdate(update); offset = update.update_id + 1; await state.setOffset(offset); } }
    catch (error) { console.error(`polling error: ${(error as Error).message}`); await new Promise((resolve) => setTimeout(resolve, 5000)); }
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
await main();
