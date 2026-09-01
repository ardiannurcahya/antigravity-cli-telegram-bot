import fs from "node:fs/promises";
import path from "node:path";
import type { ChatId } from "../types.js";

/**
 * Supprime les fichiers temporaires et images associés à une session Telegram spécifique.
 */
export async function cleanupSessionTempFiles(tempDir: string, chatId: ChatId): Promise<void> {
  const sessionDir = path.join(tempDir, `chat_${chatId}`);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch {
    // Dossier inexistant ignoré
  }

  // Nettoyer également les fichiers résiduels à la racine du tempDir
  try {
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.includes(`_${chatId}_`) || entry.name.startsWith(`photo_${chatId}_`))) {
        await fs.unlink(path.join(tempDir, entry.name)).catch(() => undefined);
      }
    }
  } catch {
    // Dossier temp inexistant ignoré
  }
}

/**
 * Supprime les fichiers et dossiers temporaires orphelins ou expirés (plus de 24h).
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
        // Fichier déjà supprimé
      }
    }
  } catch {
    // Dossier inaccessible ignoré
  }
}
