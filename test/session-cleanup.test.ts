import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupSessionTempFiles, cleanupStaleTempFiles } from "../src/usecases/session-cleanup.js";

test("cleanupSessionTempFiles removes chat-specific temp directory and legacy files", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-cleanup-test-"));
  try {
    const sessionDir = path.join(tmpDir, "chat_12345");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "photo_1.jpg"), "test");
    await fs.writeFile(path.join(sessionDir, "photo_2.png"), "test");

    const otherSessionDir = path.join(tmpDir, "chat_99999");
    await fs.mkdir(otherSessionDir, { recursive: true });
    await fs.writeFile(path.join(otherSessionDir, "photo_other.jpg"), "test");

    const legacyFile = path.join(tmpDir, "photo_12345_legacy.jpg");
    await fs.writeFile(legacyFile, "test");

    await cleanupSessionTempFiles(tmpDir, 12345);

    const existsSession = await fs.stat(sessionDir).catch(() => null);
    assert.equal(existsSession, null);

    const existsLegacy = await fs.stat(legacyFile).catch(() => null);
    assert.equal(existsLegacy, null);

    const existsOther = await fs.stat(otherSessionDir).catch(() => null);
    assert.ok(existsOther !== null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("cleanupStaleTempFiles removes items older than threshold and preserves recent ones", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-stale-test-"));
  try {
    const oldFile = path.join(tmpDir, "old_file.jpg");
    await fs.writeFile(oldFile, "old content");
    const pastTime = new Date(Date.now() - 3600 * 1000 * 48);
    await fs.utimes(oldFile, pastTime, pastTime);

    const recentFile = path.join(tmpDir, "recent_file.jpg");
    await fs.writeFile(recentFile, "recent content");

    await cleanupStaleTempFiles(tmpDir, 3600 * 1000 * 24);

    const existsOld = await fs.stat(oldFile).catch(() => null);
    assert.equal(existsOld, null);

    const existsRecent = await fs.stat(recentFile).catch(() => null);
    assert.ok(existsRecent !== null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
