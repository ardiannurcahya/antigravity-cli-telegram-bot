import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { asAppContext, callbackUpdate, createHarness, textUpdate } from "./helpers/fixtures.js";
import { handleUpdate } from "../src/router/updates.js";
import { handleBtwCommand, runBtwJob } from "../src/usecases/btw-command.js";
import { handleForkCommand } from "../src/usecases/fork-command.js";
import { handleRewindCommand } from "../src/usecases/rewind-command.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

test("session lifecycle: /btw shows usage when called without arguments and enqueues btw job when given a question", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleBtwCommand(ctx, "12345", "   ");
    assert.equal(harness.capturedJobs.length, 0);
    const sent = harness.telegram.sentTexts();
    assert.ok(sent[sent.length - 1].includes("Usage: <code>/btw"));

    await handleUpdate(ctx, textUpdate(12345, "/btw What is the default port for Redis?"));
    assert.equal(harness.capturedJobs.length, 1);
    assert.equal(harness.capturedJobs[0].kind, "btw");
    assert.equal(harness.capturedJobs[0].prompt, "What is the default port for Redis?");
  } finally {
    harness.cleanup();
  }
});

test("session lifecycle: runBtwJob executes one-shot query, cleans up ephemeral DB entry, and preserves active session", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const activeConvId = "11111111-1111-4111-8111-111111111111";
    const ephemeralConvId = "22222222-2222-4222-8222-222222222222";

    ctx.convDb.upsertConversation({
      conversation_id: activeConvId,
      title: "Main Architecture Task",
      preview: "Main Architecture Task",
      step_count: 12,
    });
    ctx.convDb.upsertConversation({
      conversation_id: ephemeralConvId,
      title: "Ephemeral Side Question",
      preview: "Ephemeral Side Question",
      step_count: 2,
    });

    await ctx.state.setSession("12345", {
      conversationId: activeConvId,
      conversationTitle: "Main Architecture Task",
      conversationStepCount: 12,
      contextTokens: "42k",
      contextPercentage: 4,
    });

    const fakeAgyPath = path.join(harness.config.tempDir, "fake-agy.mjs");
    fs.writeFileSync(
      fakeAgyPath,
      `#!/usr/bin/env node
console.log(JSON.stringify({ event: "init", conversation_id: "${ephemeralConvId}", model: "gemini-3.8-flash-high" }));
console.log(JSON.stringify({ event: "result", conversation_id: "${ephemeralConvId}", response: "Redis uses port 6379 by default.", status: "SUCCESS", num_turns: 1 }));
`,
      { mode: 0o755 }
    );
    harness.config.agy.bin = fakeAgyPath;

    const controller = new AbortController();
    await runBtwJob(
      ctx,
      { chatId: "12345", kind: "btw", prompt: "What port does Redis use?" },
      controller,
      () => false
    );

    // Active session must remain completely untouched
    const afterSession = ctx.state.session("12345");
    assert.equal(afterSession?.conversationId, activeConvId);
    assert.equal(afterSession?.conversationTitle, "Main Architecture Task");
    assert.equal(afterSession?.conversationStepCount, 12);
    assert.equal(afterSession?.contextTokens, "42k");

    // Ephemeral conversation must be purged from conversation_summaries.db
    assert.equal(ctx.convDb.getConversationById(ephemeralConvId), null);
    assert.ok(ctx.convDb.getConversationById(activeConvId));

    const sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("Side question (/btw)") && t.includes("6379")));
  } finally {
    harness.cleanup();
  }
});

test("session lifecycle: /fork and /branch clone conversation SQLite DB, brain transcripts, and switch active session", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    // 1. No active session
    await handleForkCommand(ctx, "12345", "");
    let sent = harness.telegram.sentTexts();
    assert.ok(sent[sent.length - 1].includes("No active conversation to fork"));

    // 2. Setup active session with per-conversation DB and brain transcript
    const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sourceTrajId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const appDataDir = path.dirname(harness.config.agy.dbPath);
    const convDir = path.join(appDataDir, "conversations");
    const brainLogsDir = path.join(appDataDir, "brain", sourceId, ".system_generated", "logs");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainLogsDir, { recursive: true });

    const convDbPath = path.join(convDir, `${sourceId}.db`);
    const convDb = new DatabaseSync(convDbPath);
    convDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
      CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY, data blob);
      CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, status integer, metadata blob, step_payload blob);
    `);
    convDb.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17);").run(sourceTrajId, sourceId);
    convDb.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?);").run(
      Buffer.from(`header:${sourceId}:traj:${sourceTrajId}`, "utf8")
    );
    convDb.prepare("INSERT INTO steps VALUES (0, 14, 3, ?, ?);").run(
      Buffer.from(`meta:${sourceId}`, "utf8"),
      Buffer.from("<USER_REQUEST>Initial prompt</USER_REQUEST>", "utf8")
    );
    convDb.close();

    fs.writeFileSync(
      path.join(brainLogsDir, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", conversation_id: sourceId, content: "<USER_REQUEST>Initial prompt</USER_REQUEST>" })}\n`,
      "utf8"
    );

    ctx.convDb.upsertConversation({
      conversation_id: sourceId,
      title: "Original Feature Spec",
      preview: "Original Feature Spec",
      step_count: 6,
    });

    await ctx.state.setSession("12345", {
      conversationId: sourceId,
      conversationTitle: "Original Feature Spec",
      conversationStepCount: 6,
    });

    // 3. Fork with default title via /fork
    await handleForkCommand(ctx, "12345", "");
    const forkedSession = ctx.state.session("12345");
    assert.ok(forkedSession?.conversationId);
    assert.notEqual(forkedSession.conversationId, sourceId);
    assert.equal(forkedSession.conversationTitle, "Original Feature Spec (fork)");
    assert.equal(forkedSession.conversationStepCount, 6);

    const newId = forkedSession.conversationId!;
    const forkedSummary = ctx.convDb.getConversationById(newId);
    assert.equal(forkedSummary?.display_title, "Original Feature Spec (fork)");
    assert.equal(forkedSummary?.step_count, 6);

    // Original conversation is still intact
    const origSummary = ctx.convDb.getConversationById(sourceId);
    assert.equal(origSummary?.display_title, "Original Feature Spec");

    // Cloned per-conversation DB has updated cascade_id and blob UUIDs
    const clonedConvDb = new DatabaseSync(path.join(convDir, `${newId}.db`), { readOnly: true });
    const clonedMeta = clonedConvDb.prepare("SELECT * FROM trajectory_meta LIMIT 1;").get() as { trajectory_id: string; cascade_id: string };
    assert.equal(clonedMeta.cascade_id, newId);
    assert.notEqual(clonedMeta.trajectory_id, sourceTrajId);
    const clonedBlob = clonedConvDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main';").get() as { data: Uint8Array };
    assert.ok(Buffer.from(clonedBlob.data).toString("utf8").includes(newId));
    clonedConvDb.close();

    // Cloned transcript has updated conversation ID
    const clonedTranscript = fs.readFileSync(
      path.join(appDataDir, "brain", newId, ".system_generated", "logs", "transcript.jsonl"),
      "utf8"
    );
    assert.ok(clonedTranscript.includes(newId));

    // 4. Test /branch alias with custom title
    await handleUpdate(ctx, textUpdate(12345, "/branch Alternative Implementation"));
    const branchSession = ctx.state.session("12345");
    assert.notEqual(branchSession?.conversationId, newId);
    assert.equal(branchSession?.conversationTitle, "Alternative Implementation");
  } finally {
    harness.cleanup();
  }
});

test("session lifecycle: /rewind and /undo roll back turns in SQLite and JSONL transcripts", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    // 1. No active session
    await handleRewindCommand(ctx, "12345", "");
    let sent = harness.telegram.sentTexts();
    assert.ok(sent[sent.length - 1].includes("No active conversation to rewind"));

    // 2. Invalid argument
    await handleRewindCommand(ctx, "12345", "abc");
    sent = harness.telegram.sentTexts();
    assert.ok(sent[sent.length - 1].includes("Usage: <code>/rewind"));

    // 3. Setup conversation with 3 user turns (indices 0, 3, 6)
    const convId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const appDataDir = path.dirname(harness.config.agy.dbPath);
    const convDir = path.join(appDataDir, "conversations");
    const brainLogsDir = path.join(appDataDir, "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainLogsDir, { recursive: true });

    const convDbPath = path.join(convDir, `${convId}.db`);
    const convDb = new DatabaseSync(convDbPath);
    convDb.exec(`
      CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, status integer, metadata blob, step_payload blob);
      CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer);
      CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
    `);

    const stepDefs = [
      { idx: 0, type: 14, payload: "<USER_REQUEST>Turn 1: Setup project</USER_REQUEST>" },
      { idx: 1, type: 15, payload: "Planner step 1" },
      { idx: 2, type: 132, payload: "Tool step 1" },
      { idx: 3, type: 14, payload: "<USER_REQUEST>Turn 2: Add database layer</USER_REQUEST>" },
      { idx: 4, type: 15, payload: "Planner step 2" },
      { idx: 5, type: 132, payload: "Tool step 2" },
      { idx: 6, type: 14, payload: "<USER_REQUEST>Turn 3: Wrong direction experiment</USER_REQUEST>" },
      { idx: 7, type: 15, payload: "Planner step 3" },
    ];
    for (const s of stepDefs) {
      convDb.prepare("INSERT INTO steps VALUES (?, ?, 3, NULL, ?);").run(
        s.idx,
        s.type,
        Buffer.from(s.payload, "utf8")
      );
    }
    convDb.close();

    const transcriptLines = stepDefs.map((s) =>
      JSON.stringify({
        step_index: s.idx,
        type: s.type === 14 ? "USER_INPUT" : "PLANNER_RESPONSE",
        content: s.payload,
      })
    );
    fs.writeFileSync(path.join(brainLogsDir, "transcript.jsonl"), `${transcriptLines.join("\n")}\n`, "utf8");

    ctx.convDb.upsertConversation({
      conversation_id: convId,
      title: "Multi-turn Session",
      preview: "Multi-turn Session",
      step_count: 8,
    });
    await ctx.state.setSession("12345", {
      conversationId: convId,
      conversationTitle: "Multi-turn Session",
      conversationStepCount: 8,
      contextTokens: "85k",
      contextPercentage: 9,
    });

    // 4. Rewind 1 turn via /rewind
    await handleRewindCommand(ctx, "12345", "1");
    let session = ctx.state.session("12345");
    assert.equal(session?.conversationStepCount, 6);
    assert.equal(session?.contextTokens, undefined);

    sent = harness.telegram.sentTexts();
    assert.ok(sent[sent.length - 1].includes("Conversation rewound"));
    assert.ok(sent[sent.length - 1].includes("Turn 3: Wrong direction experiment"));

    // Verify steps 6 and 7 are removed from per-conversation SQLite DB
    const checkDb1 = new DatabaseSync(convDbPath, { readOnly: true });
    const remaining1 = checkDb1.prepare("SELECT idx FROM steps ORDER BY idx ASC;").all() as Array<{ idx: number }>;
    assert.deepEqual(remaining1.map((r) => r.idx), [0, 1, 2, 3, 4, 5]);
    checkDb1.close();

    // 5. Rewind another turn via /undo alias
    await handleUpdate(ctx, textUpdate(12345, "/undo"));
    session = ctx.state.session("12345");
    assert.equal(session?.conversationStepCount, 3);

    // 6. Attempting to rewind the initial turn (only 1 user turn left at idx 0) is blocked
    await handleUpdate(ctx, { update_id: 99, callback_query: callbackUpdate("action:rewind", 12345, 99) });
    sent = harness.telegram.sentTexts();
    assert.ok(sent[sent.length - 1].includes("Cannot rewind 1 turn"));
    assert.equal(ctx.state.session("12345")?.conversationStepCount, 3);
  } finally {
    harness.cleanup();
  }
});

test("session lifecycle: deleteConversation and forkConversation handle SQLite WAL mode gracefully", () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const appDataDir = path.dirname(harness.config.agy.dbPath);
    const convsDir = path.join(appDataDir, "conversations");
    fs.mkdirSync(convsDir, { recursive: true });

    // 1. Test WAL and SHM cleanup in deleteConversation
    const delId = "33333333-3333-4333-8333-333333333333";
    const delDbFile = path.join(convsDir, `${delId}.db`);
    const delWalFile = path.join(convsDir, `${delId}.db-wal`);
    const delShmFile = path.join(convsDir, `${delId}.db-shm`);
    fs.writeFileSync(delDbFile, "fake db");
    fs.writeFileSync(delWalFile, "fake wal");
    fs.writeFileSync(delShmFile, "fake shm");

    const deleted = ctx.convDb.deleteConversation(delId);
    assert.equal(deleted, true);
    assert.equal(fs.existsSync(delDbFile), false);
    assert.equal(fs.existsSync(delWalFile), false);
    assert.equal(fs.existsSync(delShmFile), false);

    // 2. Test WAL checkpointing during forkConversation
    const srcId = "44444444-4444-4444-8444-444444444444";
    const srcDbFile = path.join(convsDir, `${srcId}.db`);

    // Create a real WAL SQLite database with pending frames
    const srcDb = new DatabaseSync(srcDbFile);
    srcDb.exec("PRAGMA journal_mode = WAL;");
    srcDb.exec("CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);");
    srcDb.exec(`INSERT INTO trajectory_meta VALUES ('${srcId}', '${srcId}');`);
    srcDb.exec("CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB);");
    srcDb.exec("CREATE TABLE steps (idx INT, metadata BLOB, step_payload BLOB);");
    srcDb.exec(`INSERT INTO steps VALUES (0, NULL, x'${Buffer.from(`{"prompt":"wal test ${srcId}"}`).toString("hex")}');`);
    assert.ok(fs.existsSync(`${srcDbFile}-wal`));

    ctx.convDb.upsertConversation({
      conversation_id: srcId,
      title: "WAL Source Session",
      preview: "WAL Source Session",
      step_count: 1,
    });

    const forked = ctx.convDb.forkConversation(srcId, "WAL Forked Branch");
    assert.ok(forked);
    assert.notEqual(forked.conversationId, srcId);

    // The destination database must contain the table and data consolidated from WAL
    const dstDbFile = path.join(convsDir, `${forked.conversationId}.db`);
    assert.ok(fs.existsSync(dstDbFile));

    const checkDst = new DatabaseSync(dstDbFile, { readOnly: true });
    const metaRow = checkDst.prepare("SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 1;").get() as { trajectory_id: string; cascade_id: string };
    assert.equal(metaRow.cascade_id, forked.conversationId);

    const stepRow = checkDst.prepare("SELECT step_payload FROM steps WHERE idx = 0;").get() as { step_payload: Uint8Array };
    const payloadStr = Buffer.from(stepRow.step_payload).toString("utf8");
    assert.ok(payloadStr.includes(`wal test ${forked.conversationId}`));
    checkDst.close();
    srcDb.close();
  } finally {
    harness.cleanup();
  }
});
