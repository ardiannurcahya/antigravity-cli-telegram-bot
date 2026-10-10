import test from "node:test";
import assert from "node:assert/strict";
import { asAppContext, createHarness, textUpdate } from "./helpers/fixtures.js";
import { handleUpdate } from "../src/router/updates.js";
import { appendRewindHistory, REWIND_HISTORY_LIMIT } from "../src/usecases/prompt-job.js";
import { computeRewind, parseRewindCount } from "../src/usecases/rewind-command.js";

test("parity phase 3: appendRewindHistory pushes the resumed id only when the turn advances", () => {
  assert.deepEqual(appendRewindHistory([], "id1", "id2"), ["id1"]);
  assert.deepEqual(appendRewindHistory(["id1"], "id2", "id3"), ["id1", "id2"]);
  // First turn: no previous id to record.
  assert.deepEqual(appendRewindHistory([], undefined, "id1"), []);
  // Same id back (no advance): unchanged.
  assert.deepEqual(appendRewindHistory(["id1"], "id2", "id2"), ["id1"]);
});

test("parity phase 3: rewind history is bounded", () => {
  let history: string[] = [];
  for (let i = 0; i < REWIND_HISTORY_LIMIT + 10; i += 1) {
    history = appendRewindHistory(history, `id${i}`, `id${i + 1}`);
  }
  assert.equal(history.length, REWIND_HISTORY_LIMIT);
  assert.equal(history[history.length - 1], `id${REWIND_HISTORY_LIMIT + 9}`);
});

test("parity phase 3: computeRewind pops the requested number of snapshots", () => {
  assert.deepEqual(computeRewind(["a", "b", "c"], 1), { targetId: "c", remaining: ["a", "b"], steps: 1 });
  assert.deepEqual(computeRewind(["a", "b", "c"], 2), { targetId: "b", remaining: ["a"], steps: 2 });
  // Over-request clamps to the available history.
  assert.deepEqual(computeRewind(["a", "b"], 9), { targetId: "a", remaining: [], steps: 2 });
  // Empty history yields no target.
  assert.deepEqual(computeRewind([], 1), { targetId: null, remaining: [], steps: 0 });
});

test("parity phase 3: parseRewindCount defaults to 1 and rejects non-positive input", () => {
  assert.equal(parseRewindCount(""), 1);
  assert.equal(parseRewindCount("3"), 3);
  assert.equal(parseRewindCount("0"), 1);
  assert.equal(parseRewindCount("-2"), 1);
  assert.equal(parseRewindCount("abc"), 1);
});

test("parity phase 3: /rewind restores an earlier conversation id and shrinks the history", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const older = "00000000-0000-4000-8000-000000000001";
    const current = "00000000-0000-4000-8000-000000000002";
    ctx.convDb.upsertConversation({ conversation_id: older, title: "Older turn", preview: "Older turn", step_count: 2 });
    await ctx.state.setSession("12345", {
      conversationId: current,
      conversationHistory: [older],
      conversationTitle: "Current turn",
      conversationStepCount: 3,
    } as never);

    await handleUpdate(ctx, textUpdate(12345, "/rewind"));

    const session = ctx.state.session("12345");
    assert.equal(session?.conversationId, older);
    assert.deepEqual(session?.conversationHistory, []);
    assert.equal(session?.conversationStepCount, 2);
    const sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("Rewound 1 turn")));
  } finally {
    harness.cleanup();
  }
});

test("parity phase 3: /rewind with no history tells the user to start fresh", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await ctx.state.setSession("12345", {
      conversationId: "00000000-0000-4000-8000-000000000002",
      conversationHistory: [],
    } as never);
    await handleUpdate(ctx, textUpdate(12345, "/rewind"));
    const session = ctx.state.session("12345");
    assert.equal(session?.conversationId, "00000000-0000-4000-8000-000000000002");
    const sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("Nothing to rewind")));
  } finally {
    harness.cleanup();
  }
});

test("parity phase 3: /rewind without an active conversation is a no-op with notice", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(12345, "/rewind"));
    assert.equal(harness.capturedJobs.length, 0);
    const sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("No active conversation to rewind")));
  } finally {
    harness.cleanup();
  }
});
