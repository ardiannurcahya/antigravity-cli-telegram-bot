import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ConversationDatabase, formatRelativeTime, isUuid, parseTimestamp } from "../src/db.js";

const require = createRequire(import.meta.url);
let DatabaseSync: any = null;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = null;
}

test("isUuid validates standard UUID strings", () => {
  assert.equal(isUuid("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isUuid("E756259F-7242-4247-BA7B-7FB8F5260013"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(undefined), false);
});

test("formatRelativeTime formats durations as expected", () => {
  const now = new Date("2026-08-09T16:00:00Z").getTime();

  // Just now (< 60s)
  assert.equal(formatRelativeTime(now - 30 * 1000, now), "just now");

  // Minutes ago (8m ago, 58m ago)
  assert.equal(formatRelativeTime(now - 8 * 60 * 1000, now), "8m ago");
  assert.equal(formatRelativeTime(now - 58 * 60 * 1000, now), "58m ago");

  // Hours ago (2h ago)
  assert.equal(formatRelativeTime(now - 2 * 3600 * 1000, now), "2h ago");

  // Days ago (3d ago)
  assert.equal(formatRelativeTime(now - 3 * 86400 * 1000, now), "3d ago");

  // Older dates (09 Aug 2026)
  const olderDate = new Date("2026-08-01T12:00:00Z").getTime();
  assert.match(formatRelativeTime(olderDate, now), /01 Aug 2026/);
});

test("parseTimestamp parses various timestamp formats", () => {
  const ms = 1786264407452;
  const sec = 1786264407;
  assert.equal(parseTimestamp(ms), ms);
  assert.equal(parseTimestamp(sec), sec * 1000);
  assert.equal(parseTimestamp("1786264407452"), ms);
  assert.equal(parseTimestamp("2026-08-09T16:00:00Z"), new Date("2026-08-09T16:00:00Z").getTime());
});

test("ConversationDatabase returns empty page for non-existent database file", () => {
  const db = new ConversationDatabase("/non/existent/path/db.sqlite");
  const result = db.getConversations(0, 10);
  assert.equal(result.total, 0);
  assert.equal(result.items.length, 0);
  assert.equal(result.page, 0);
  assert.equal(result.totalPages, 1);
  assert.equal(db.getConversationById("123"), null);
});

test("ConversationDatabase correctly reads, counts, orders, and paginates conversation records", () => {
  if (!DatabaseSync) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-db-"));
  const dbFile = path.join(tmpDir, "conversation_summaries.db");

  const sync = new DatabaseSync(dbFile);
  sync.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      preview TEXT,
      title TEXT,
      step_count INTEGER,
      last_modified_time INTEGER,
      project_id TEXT,
      killed INTEGER
    );
  `);

  const insert = sync.prepare(`
    INSERT INTO conversation_summaries (conversation_id, preview, title, step_count, last_modified_time, project_id, killed)
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `);

  const now = Date.now();
  // Valid conversations
  insert.run("uuid-1", "Preview One", "Title One", 71, now - 1000, "default", 0);
  insert.run("uuid-2", "", "Title Two", 261, now - 2000, "default", 0);
  insert.run("uuid-3", "Preview Three", "", 46, now - 3000, "default", 0);
  insert.run("uuid-4", "", "", 15, now - 4000, "default", 0);

  // Invalid: killed or step_count 0
  insert.run("uuid-killed", "Killed session", "Killed", 50, now - 500, "default", 1);
  insert.run("uuid-zero-step", "Zero step", "Zero", 0, now - 600, "default", 0);

  sync.close();

  const convDb = new ConversationDatabase(dbFile);
  const page0 = convDb.getConversations(0, 2);

  assert.equal(page0.total, 4);
  assert.equal(page0.totalPages, 2);
  assert.equal(page0.items.length, 2);
  assert.equal(page0.items[0].conversation_id, "uuid-1");
  assert.equal(page0.items[0].display_title, "Preview One");
  assert.equal(page0.items[1].conversation_id, "uuid-2");
  assert.equal(page0.items[1].display_title, "Title Two");

  const page1 = convDb.getConversations(1, 2);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0].conversation_id, "uuid-3");
  assert.equal(page1.items[0].display_title, "Preview Three");
  assert.equal(page1.items[1].conversation_id, "uuid-4");
  assert.equal(page1.items[1].display_title, "(untitled)");

  // Get by ID
  const item1 = convDb.getConversationById("uuid-1");
  assert.ok(item1);
  assert.equal(item1.display_title, "Preview One");
  assert.equal(item1.step_count, 71);

  // Killed or zero step items should return null
  assert.equal(convDb.getConversationById("uuid-killed"), null);
  assert.equal(convDb.getConversationById("uuid-zero-step"), null);
  assert.equal(convDb.getConversationById("non-existent"), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ConversationDatabase upsertConversation correctly inserts and updates sessions", () => {
  if (!DatabaseSync) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-upsert-"));
  const dbFile = path.join(tmpDir, "conversation_summaries.db");

  const convDb = new ConversationDatabase(dbFile);
  const testId = "123e4567-e89b-12d3-a456-426614174000";

  // Upsert new conversation
  convDb.upsertConversation({
    conversation_id: testId,
    preview: "Initial Test Prompt",
    title: "Initial Test Prompt",
    step_count: 2,
    last_modified_time: Date.now(),
    project_id: "test-proj",
  });

  const row1 = convDb.getConversationById(testId);
  assert.ok(row1);
  assert.equal(row1.conversation_id, testId);
  assert.equal(row1.display_title, "Initial Test Prompt");
  assert.equal(row1.step_count, 2);

  // Update existing conversation
  convDb.upsertConversation({
    conversation_id: testId,
    preview: "Updated Test Prompt",
    title: "Updated Test Prompt",
    step_count: 5,
    last_modified_time: Date.now(),
    project_id: "test-proj",
  });

  const row2 = convDb.getConversationById(testId);
  assert.ok(row2);
  assert.equal(row2.display_title, "Updated Test Prompt");
  assert.equal(row2.step_count, 5);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
