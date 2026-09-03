import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../context.js";
import { isUuid } from "../db.js";
import { escapeHtml } from "../telegram.js";
import { isAllowedLocalMediaPath } from "../telegram/media-resolver.js";
import { effectiveWorkspaceFor } from "../domain/settings.js";
import type { AgyResult, ChatId } from "../types.js";

const sentImagePathsByChat = new Map<string, Set<string>>();

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function didExecuteImageGeneration(result: AgyResult): boolean {
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

export async function detectAndSendGeneratedImages(
  context: AppContext,
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

  // 1. Extract markdown image / file links from result.text
  const fileMatches = result.text.matchAll(/(?:file:\/\/|['"])((\/[^\s'")]+)\.(png|jpg|jpeg|webp))(?:\b|['"]|\))/gi);
  const effectiveWorkspace = effectiveWorkspaceFor(context, chatId);
  for (const match of fileMatches) {
    const fullPath = `${match[2]}.${match[3]}`;
    if (!sentImagePaths.has(fullPath) && isAllowedLocalMediaPath(fullPath, effectiveWorkspace) && (await fileExists(fullPath))) {
      imagesToSend.add(fullPath);
    }
  }

  // 2. Scan conversation artifact directory for images created ONLY DURING THIS JOB (mtime >= jobStartedAt - 1000)
  const convId = conversationId || result.conversationId;
  if (convId && isUuid(convId)) {
    const homeDir = os.homedir();
    const brainDir = path.join(homeDir, ".gemini/antigravity-cli/brain", convId.trim());
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
      await context.telegram.sendChatAction(chatId, "upload_photo");
      const basename = path.basename(imagePath);
      await context.telegram.sendPhoto(chatId, imagePath, `🎨 Generated Image: ${basename}`);
    } catch (error) {
      console.error(`Failed to send generated image (${imagePath}):`, error);
    }
  }
}

export function clearSentImagePaths(chatId: ChatId): void {
  sentImagePathsByChat.delete(String(chatId));
}
