import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { button, backKeyboard } from "../ui/inline-keyboards.js";
import { modelLabel } from "../models.js";
import { escapeHtml } from "../telegram.js";
import { settingsFor } from "../domain/settings.js";
import { replyWithHtml, reply } from "../ui/reply.js";
import type { ChatId, SessionSettings } from "../types.js";

export async function persistDefaultSettings(context: AppContext, chatId: ChatId, messageId?: number): Promise<void> {
  const settings = settingsFor(context, chatId);
  const envPath = context.config.envFile || path.join(os.homedir(), ".config/agy-telegram/.env");
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

    context.config.agy.model = settings.model || "";
    context.config.agy.effort = settings.effort;
    context.config.agy.mode = settings.mode;
    context.config.agy.sandbox = settings.sandbox;
    const text = `💾 <b>Settings saved as permanent defaults:</b>\n\n• <b>Model:</b> ${escapeHtml(modelLabel(settings.model))}\n• <b>Effort:</b> ${settings.effort}\n• <b>Mode:</b> ${settings.mode === "accept-edits" ? "edit" : "plan"}\n• <b>Sandbox:</b> ${settings.sandbox ? "On" : "Off"}\n\n<i>These defaults will now apply to all new sessions and service restarts.</i>`;
    if (messageId) {
      await context.telegram.editMessageText(chatId, messageId, text, { inline_keyboard: [[button("‹ Back to Menu", "menu:main")]] }, "HTML");
    } else {
      await replyWithHtml(context, chatId, text, createMainKeyboard(settings));
    }
  } catch (error) {
    const errorText = `Could not save defaults: ${(error as Error).message}`;
    if (messageId) {
      await context.telegram.editMessageText(chatId, messageId, errorText, backKeyboard());
    } else {
      await reply(context, chatId, errorText, createMainKeyboard(settings));
    }
  }
}
