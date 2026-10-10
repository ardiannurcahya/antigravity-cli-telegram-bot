import test from "node:test";
import assert from "node:assert/strict";
import { asAppContext, createHarness, textUpdate } from "./helpers/fixtures.js";
import { handleUpdate } from "../src/router/updates.js";
import { shouldAdvanceConversation } from "../src/usecases/prompt-job.js";

test("parity phase 3: /btw enqueues an ephemeral prompt job carrying the directive", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(12345, "/btw what timezone is the server in?"));
    assert.equal(harness.capturedJobs.length, 1);
    const job = harness.capturedJobs[0];
    assert.equal(job.kind, "prompt");
    assert.equal(job.ephemeral, true);
    assert.equal(job.prompt, "/btw what timezone is the server in?");
  } finally {
    harness.cleanup();
  }
});

test("parity phase 3: /btw without a question shows usage and enqueues nothing", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(12345, "/btw"));
    assert.equal(harness.capturedJobs.length, 0);
    const sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("Usage: <code>/btw")));
  } finally {
    harness.cleanup();
  }
});

test("parity phase 3: /btw is a registered command, not an unknown-command rejection", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(12345, "/btw quick aside"));
    const sent = harness.telegram.sentTexts();
    assert.ok(!sent.some((t) => t.includes("Unknown command. Use /menu.")));
  } finally {
    harness.cleanup();
  }
});

test("parity phase 3: shouldAdvanceConversation skips persistence only for ephemeral jobs", () => {
  assert.equal(shouldAdvanceConversation({ ephemeral: true }), false);
  assert.equal(shouldAdvanceConversation({ ephemeral: false }), true);
  assert.equal(shouldAdvanceConversation({}), true);
});
