import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../context.js";
import { controllerKey } from "../context.js";
import { parseCommandArgs } from "../agy-runner.js";
import { createMainKeyboard } from "../keyboards.js";
import { settingsFor } from "../domain/settings.js";
import { sessionInfoHtml } from "../ui/messages.js";
import { modelKeyboard } from "../ui/inline-keyboards.js";
import { reply, replyWithHtml } from "../ui/reply.js";
import { showMain, showResumeMenu } from "../ui/screens.js";
import { enqueueJob } from "../usecases/enqueue.js";
import { runCustomAgy } from "../usecases/custom-agy.js";
import { authorizedMessage } from "./auth.js";
import { handleCallback } from "./callbacks.js";
import { handleCommand } from "./commands.js";
import type { SessionSettings, TelegramUpdate } from "../types.js";

export async function handleUpdate(context: AppContext, update: TelegramUpdate): Promise<void> {
  try {
    if (update.callback_query) { await handleCallback(context, update.callback_query); return; }
    const message = update.message;
    if (!message || !authorizedMessage(context.config, message)) return;

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
        await context.telegram.sendChatAction(message.chat.id, "typing");
        const fileInfo = await context.telegram.getFile(fileId);
        if (fileInfo.file_path) {
          if (isDoc && message.document) {
            const rawName = message.document.file_name || `doc_${Date.now()}.bin`;
            const cleanName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const uploadsDir = path.join(context.config.agy.workspace, "uploads");
            const dest = path.join(uploadsDir, cleanName);
            documentPath = await context.telegram.downloadFile(fileInfo.file_path, dest);
            documentName = cleanName;
          } else {
            const dest = path.join(context.config.tempDir, `photo_${Date.now()}_${fileId.slice(-8)}${fileExt}`);
            imagePath = await context.telegram.downloadFile(fileInfo.file_path, dest);
          }
        }
      } catch (err) {
        await reply(context, message.chat.id, `Failed to download attachment: ${(err as Error).message}`, createMainKeyboard(settingsFor(context, message.chat.id)));
        return;
      }
    }

    const text = (message.text || message.caption || "").trim();
    if (!text && !imagePath && !documentPath) return;

    const parts = text.split(/\s+/);
    const command = parts[0] ? parts[0].toLowerCase().split("@")[0].replace(/_/g, "-") : "";
    if (command === "/agy") { try { void runCustomAgy(context, message.chat.id, parseCommandArgs(text.slice(parts[0].length))); } catch (error) { await reply(context, message.chat.id, `Invalid /agy command: ${(error as Error).message}`, createMainKeyboard(settingsFor(context, message.chat.id))); } return; }
    if (command.startsWith("/") && await handleCommand(context, message, command, parts.slice(1))) return;
    const buttonText = text;
    if (buttonText === "✨ New session" || buttonText === "✨ New") {
      await context.state.resetSession(message.chat.id);
      await replyWithHtml(context, message.chat.id, sessionInfoHtml(context, message.chat.id), createMainKeyboard(settingsFor(context, message.chat.id)));
      return;
    }
    if (buttonText === "🛑 Stop" || buttonText === "🛑 Cancel" || buttonText === "Stop" || buttonText === "Cancel") {
      context.pendingDangerousCommands.delete(String(message.chat.id));
      context.controllers.get(controllerKey("prompt", message.chat.id))?.abort();
      context.controllers.get(controllerKey("custom", message.chat.id))?.abort();
      const result = context.queue.cancelForChat(message.chat.id);
      await reply(context, message.chat.id, `⛔ Cancelled: ${result.removed} queued job(s) removed, active AGY process terminated.`, createMainKeyboard(settingsFor(context, message.chat.id)));
      return;
    }
    if (buttonText === "🤖 Model") { await reply(context, message.chat.id, "Select a model:", modelKeyboard(context, message.chat.id)); return; }
    if (buttonText === "📊 Quota" || buttonText === "📊 Usage / Quota" || buttonText === "📊 Usage") {
      enqueueJob(context, message.chat.id, { kind: "usage" });
      return;
    }
    if (text.startsWith("/")) { await reply(context, message.chat.id, "Unknown command. Use /menu.", createMainKeyboard(settingsFor(context, message.chat.id))); return; }
    enqueueJob(context, message.chat.id, { prompt: text, kind: "prompt", imagePath, documentPath, documentName });
  } catch (error) {
    console.error("handleUpdate error:", error);
  }
}
