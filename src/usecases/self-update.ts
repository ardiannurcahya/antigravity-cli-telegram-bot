import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AppContext } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { backKeyboard, button } from "../ui/inline-keyboards.js";
import { settingsFor } from "../domain/settings.js";
import { reply, replyWithHtml } from "../ui/reply.js";
import { escapeHtml } from "../telegram.js";
import type { ChatId, InlineKeyboardMarkup } from "../types.js";

const execFileAsync = promisify(execFile);
const BOT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function restartNoticePath(context: AppContext): string {
  return path.join(path.dirname(context.config.stateFile), "pending_restart_notice.json");
}

export async function writeRestartNotice(context: AppContext, notice: Omit<{ chatId: string; reason: "update" | "restart"; commit?: string; timestamp?: number }, "timestamp">): Promise<void> {
  await fs.writeFile(restartNoticePath(context), JSON.stringify({ ...notice, timestamp: Date.now() })).catch(() => undefined);
}

/** Returns ordered `systemctl` argument lists (primary then fallback) for restarting the bot service. */
export function restartCommandsForPlatform(isRoot = process.getuid?.() === 0): string[][] {
  return isRoot
    ? [["restart", "agy-telegram.service"], ["--user", "restart", "agy-telegram.service"]]
    : [["--user", "restart", "agy-telegram.service"], ["restart", "agy-telegram.service"]];
}

export function scheduleServiceRestart(delayMs: number): void {
  if (process.platform === "linux") {
    setTimeout(() => {
      const [primary, fallback] = restartCommandsForPlatform();
      let fallbackTriggered = false;
      const triggerFallback = (): void => {
        if (fallbackTriggered || !fallback) return;
        fallbackTriggered = true;
        spawn("systemctl", fallback, { detached: true, stdio: "ignore" }).unref();
      };
      const child = spawn("systemctl", primary, { detached: true, stdio: "ignore" });
      child.once("error", triggerFallback);
      child.once("close", (code) => {
        if (code !== 0) triggerFallback();
      });
      child.unref();
    }, delayMs);
  }
}

export async function updateBot(context: AppContext, chatId: ChatId, messageId?: number): Promise<void> {
  const notify = async (text: string, isHtml = false): Promise<void> => {
    const menuBackKeyboard: InlineKeyboardMarkup = { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] };
    if (messageId) {
      if (isHtml) {
        await context.telegram.editMessageText(chatId, messageId, text, menuBackKeyboard, "HTML").catch(() => undefined);
      } else {
        await context.telegram.editMessageText(chatId, messageId, text, backKeyboard()).catch(() => undefined);
      }
    } else {
      if (isHtml) {
        await replyWithHtml(context, chatId, text, createMainKeyboard(settingsFor(context, chatId)));
      } else {
        await reply(context, chatId, text, createMainKeyboard(settingsFor(context, chatId)));
      }
    }
  };

  if (!context.config.telegram.allowBotUpdate) {
    await notify("⚠️ <b>Bot updates via Telegram are disabled.</b>\n\nTo enable remote updates, set <code>ALLOW_BOT_UPDATE=true</code> in your environment.", true);
    return;
  }

  try {
    if (messageId) {
      await context.telegram.editMessageText(chatId, messageId, "🔍 Checking for updates from GitHub...").catch(() => undefined);
    } else {
      await reply(context, chatId, "🔍 Checking for updates from GitHub...");
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
      await context.telegram.editMessageText(chatId, messageId, "⬇️ Pulling latest changes from GitHub...").catch(() => undefined);
    } else {
      await reply(context, chatId, "⬇️ Pulling latest changes from GitHub...");
    }

    await execFileAsync("git", ["pull", "--ff-only", "origin", currentBranch], { cwd: BOT_ROOT_DIR });

    if (messageId) {
      await context.telegram.editMessageText(chatId, messageId, "🔨 Building project with TypeScript...").catch(() => undefined);
    } else {
      await reply(context, chatId, "🔨 Building project with TypeScript...");
    }

    await execFileAsync("npm", ["run", "build"], { cwd: BOT_ROOT_DIR });

    const { stdout: newLogMsg } = await execFileAsync("git", ["log", "-1", "--pretty=format:%h - %s"], { cwd: BOT_ROOT_DIR });

    await writeRestartNotice(context, { chatId: String(chatId), reason: "update", commit: newLogMsg.trim() });

    await notify(`🚀 <b>Update complete!</b>\n\nBranch: <code>${escapeHtml(currentBranch)}</code>\nUpdated to: <code>${escapeHtml(newLogMsg.trim())}</code>\n\n<i>Restarting bot service...</i>`, true);

    scheduleServiceRestart(1500);
  } catch (error) {
    await notify(`❌ <b>Update failed:</b>\n<code>${escapeHtml((error as Error).message)}</code>`, true);
  }
}
