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
import type { SessionSettings, TelegramMessage, TelegramUpdate } from "../types.js";

export function sessionKeyForMessage(message: TelegramMessage): string {
  return message.message_thread_id ? `${message.chat.id}:${message.message_thread_id}` : String(message.chat.id);
}

export async function handleUpdate(context: AppContext, update: TelegramUpdate): Promise<void> {
  try {
    if (update.callback_query) { await handleCallback(context, update.callback_query); return; }
    const message = update.message;
    if (!message || !authorizedMessage(context.config, message)) return;

    const sessionKey = sessionKeyForMessage(message);

    let imagePath: string | undefined;
    let documentPath: string | undefined;
    let documentName: string | undefined;
    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let fileId: string | undefined;
    let fileExt = ".jpg";
    let isDoc = false;
    let isImage = false;
    let isVoice = false;
    let isAudio = false;
    let isVideo = false;
    let isVideoNote = false;
    let isAnimation = false;
    let attachmentMeta: string | undefined;

    if (message.photo && message.photo.length > 0) {
      fileId = message.photo[message.photo.length - 1].file_id;
      fileExt = ".jpg";
      isImage = true;
    } else if (message.voice) {
      fileId = message.voice.file_id;
      fileExt = ".ogg";
      isVoice = true;
      mediaType = "Voice message";
      const dur = message.voice.duration ? ` | Duration: ${message.voice.duration}s` : "";
      attachmentMeta = `[Voice message attached: %PATH%${dur}]`;
    } else if (message.audio) {
      fileId = message.audio.file_id;
      fileExt = path.extname(message.audio.file_name || "") || ".mp3";
      isAudio = true;
      mediaType = "Audio";
      const parts: string[] = [];
      if (message.audio.title) parts.push(`Title: ${message.audio.title}`);
      if (message.audio.performer) parts.push(`Artist: ${message.audio.performer}`);
      if (message.audio.duration) parts.push(`Duration: ${message.audio.duration}s`);
      const meta = parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
      attachmentMeta = `[Audio attached: %PATH%${meta}]`;
    } else if (message.video) {
      fileId = message.video.file_id;
      fileExt = path.extname(message.video.file_name || "") || ".mp4";
      isVideo = true;
      mediaType = "Video";
      const parts: string[] = [];
      if (message.video.width && message.video.height) parts.push(`Resolution: ${message.video.width}x${message.video.height}`);
      if (message.video.duration) parts.push(`Duration: ${message.video.duration}s`);
      const meta = parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
      attachmentMeta = `[Video attached: %PATH%${meta}]`;
    } else if (message.video_note) {
      fileId = message.video_note.file_id;
      fileExt = ".mp4";
      isVideoNote = true;
      mediaType = "Video note";
      const dur = message.video_note.duration ? ` | Duration: ${message.video_note.duration}s` : "";
      attachmentMeta = `[Video note attached: %PATH%${dur}]`;
    } else if (message.animation) {
      fileId = message.animation.file_id;
      fileExt = path.extname(message.animation.file_name || "") || ".mp4";
      isAnimation = true;
      mediaType = "Animation";
      const parts: string[] = [];
      if (message.animation.width && message.animation.height) parts.push(`Resolution: ${message.animation.width}x${message.animation.height}`);
      if (message.animation.duration) parts.push(`Duration: ${message.animation.duration}s`);
      const meta = parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
      attachmentMeta = `[Animation attached: %PATH%${meta}]`;
    } else if (message.document) {
      fileId = message.document.file_id;
      if (message.document.mime_type?.startsWith("image/")) {
        isImage = true;
        if (message.document.file_name && path.extname(message.document.file_name)) {
          fileExt = path.extname(message.document.file_name);
        }
      } else {
        isDoc = true;
      }
    }

    if (fileId) {
      try {
        await context.telegram.sendChatAction(sessionKey, "typing");
        const fileInfo = await context.telegram.getFile(fileId);
        if (fileInfo.file_path) {
          if (isImage) {
            const dest = path.join(context.config.tempDir, `photo_${Date.now()}_${fileId.slice(-8)}${fileExt}`);
            imagePath = await context.telegram.downloadFile(fileInfo.file_path, dest);
          } else if (isVoice) {
            const dest = path.join(context.config.tempDir, `voice_${Date.now()}_${fileId.slice(-8)}${fileExt}`);
            mediaPath = await context.telegram.downloadFile(fileInfo.file_path, dest);
          } else if (isVideoNote) {
            const dest = path.join(context.config.tempDir, `vnote_${Date.now()}_${fileId.slice(-8)}${fileExt}`);
            mediaPath = await context.telegram.downloadFile(fileInfo.file_path, dest);
          } else if (isAnimation) {
            const dest = path.join(context.config.tempDir, `anim_${Date.now()}_${fileId.slice(-8)}${fileExt}`);
            mediaPath = await context.telegram.downloadFile(fileInfo.file_path, dest);
          } else if (isAudio) {
            const rawName = message.audio?.file_name || `audio_${Date.now()}_${fileId.slice(-8)}${fileExt}`;
            const cleanName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const uploadsDir = path.join(context.config.agy.workspace, "uploads");
            const dest = path.join(uploadsDir, cleanName);
            mediaPath = await context.telegram.downloadFile(fileInfo.file_path, dest);
            documentName = cleanName;
          } else if (isVideo) {
            const rawName = message.video?.file_name || `video_${Date.now()}_${fileId.slice(-8)}${fileExt}`;
            const cleanName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const uploadsDir = path.join(context.config.agy.workspace, "uploads");
            const dest = path.join(uploadsDir, cleanName);
            mediaPath = await context.telegram.downloadFile(fileInfo.file_path, dest);
            documentName = cleanName;
          } else if (isDoc && message.document) {
            const rawName = message.document.file_name || `doc_${Date.now()}.bin`;
            const cleanName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const uploadsDir = path.join(context.config.agy.workspace, "uploads");
            const dest = path.join(uploadsDir, cleanName);
            documentPath = await context.telegram.downloadFile(fileInfo.file_path, dest);
            documentName = cleanName;
          }
        }
      } catch (err) {
        await reply(context, sessionKey, `Failed to download attachment: ${(err as Error).message}`, createMainKeyboard(settingsFor(context, sessionKey)));
        return;
      }
    }

    let extraContext: string | undefined;

    if (message.venue) {
      const v = message.venue;
      const title = v.title ? `"${v.title}"` : "";
      const addr = v.address ? `, ${v.address}` : "";
      extraContext = `[Location shared: ${title}${addr} (Coordinates: ${v.location.latitude}, ${v.location.longitude})]`;
    } else if (message.location) {
      const loc = message.location;
      const acc = loc.horizontal_accuracy ? ` | Accuracy: ${loc.horizontal_accuracy}m` : "";
      extraContext = `[Location shared: Coordinates ${loc.latitude}, ${loc.longitude}${acc}]`;
    } else if (message.contact) {
      const c = message.contact;
      const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ");
      let vcardInfo = "";
      if (c.vcard) {
        try {
          const vcardName = `contact_${Date.now()}_${c.first_name.replace(/[^a-zA-Z0-9]/g, "_")}.vcf`;
          const vcardPath = path.join(context.config.tempDir, vcardName);
          await fs.writeFile(vcardPath, c.vcard, "utf-8");
          vcardInfo = ` | vCard saved: ${vcardPath}`;
        } catch {
          // ignore vcard write failure
        }
      }
      extraContext = `[Contact shared: ${fullName} (${c.phone_number})${vcardInfo}]`;
    }

    const rawText = (message.text || message.caption || "").trim();
    let promptPrefix = "";
    if (attachmentMeta && mediaPath) {
      promptPrefix = attachmentMeta.replace("%PATH%", mediaPath);
    }
    if (extraContext) {
      promptPrefix = promptPrefix ? `${promptPrefix}\n${extraContext}` : extraContext;
    }

    let text = rawText;
    if (promptPrefix) {
      text = rawText ? `${promptPrefix}\n\n${rawText}` : promptPrefix;
    }

    if (!text && !imagePath && !documentPath && !mediaPath) return;

    const parts = text.split(/\s+/);
    const command = parts[0] ? parts[0].toLowerCase().split("@")[0].replace(/_/g, "-") : "";
    if (command === "/agy") { try { void runCustomAgy(context, sessionKey, parseCommandArgs(text.slice(parts[0].length))); } catch (error) { await reply(context, sessionKey, `Invalid /agy command: ${(error as Error).message}`, createMainKeyboard(settingsFor(context, sessionKey))); } return; }
    if (command.startsWith("/") && await handleCommand(context, message, command, parts.slice(1))) return;
    const buttonText = text;
    if (buttonText === "✨ New session" || buttonText === "✨ New") {
      await context.state.resetSession(sessionKey);
      await replyWithHtml(context, sessionKey, sessionInfoHtml(context, sessionKey), createMainKeyboard(settingsFor(context, sessionKey)));
      return;
    }
    if (buttonText === "🛑 Stop" || buttonText === "🛑 Cancel" || buttonText === "Stop" || buttonText === "Cancel") {
      context.pendingDangerousCommands.delete(String(sessionKey));
      context.controllers.get(controllerKey("prompt", sessionKey))?.abort();
      context.controllers.get(controllerKey("custom", sessionKey))?.abort();
      const result = context.queue.cancelForChat(sessionKey);
      await reply(context, sessionKey, `⛔ Cancelled: ${result.removed} queued job(s) removed, active AGY process terminated.`, createMainKeyboard(settingsFor(context, sessionKey)));
      return;
    }
    if (buttonText === "🤖 Model") { await reply(context, sessionKey, "Select a model:", modelKeyboard(context, sessionKey)); return; }
    if (buttonText === "📊 Quota" || buttonText === "📊 Usage / Quota" || buttonText === "📊 Usage") {
      enqueueJob(context, sessionKey, { kind: "usage" });
      return;
    }
    if (text.startsWith("/")) { await reply(context, sessionKey, "Unknown command. Use /menu.", createMainKeyboard(settingsFor(context, sessionKey))); return; }
    enqueueJob(context, sessionKey, { prompt: text, kind: "prompt", imagePath, documentPath, documentName, mediaPath, mediaType });
  } catch (error) {
    console.error("handleUpdate error:", error);
  }
}
