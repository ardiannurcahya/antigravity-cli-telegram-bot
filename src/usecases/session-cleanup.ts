import fs from "node:fs/promises";
import path from "node:path";
import type { ChatId } from "../types.js";

/**
 * Removes temporary files and images associated with a specific Telegram session.
 */
export async function cleanupSessionTempFiles(tempDir: string, chatId: ChatId): Promise<void> {
  const sessionDir = path.join(tempDir, `chat_${chatId}`);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch {
    // Non-existent directory ignored
  }

  // Clean up residual files in tempDir root
  try {
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.includes(`_${chatId}_`) || entry.name.startsWith(`photo_${chatId}_`))) {
        await fs.unlink(path.join(tempDir, entry.name)).catch(() => undefined);
      }
    }
  } catch {
    // Non-existent temp directory ignored
  }
}

/**
 * Removes orphan or expired temporary files and directories (older than 24h).
 */
export async function cleanupStaleTempFiles(tempDir: string, maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    await fs.mkdir(tempDir, { recursive: true });
    const now = Date.now();
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(tempDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (entry.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fullPath).catch(() => undefined);
          }
        }
      } catch {
        // File already deleted
      }
    }
  } catch {
    // Inaccessible directory ignored
  }
}

