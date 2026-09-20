import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { asAppContext, createHarness, textUpdate } from "./helpers/fixtures.js";
import { handleCommand } from "../src/router/commands.js";
import { handleUpdate, PROMPT_DIRECTIVES } from "../src/router/updates.js";
import { handleTitleCommand } from "../src/usecases/title-command.js";
import { handleDiffCommand } from "../src/usecases/diff-command.js";

test("parity phase 1: PROMPT_DIRECTIVES contains required prompt directives", () => {
  assert.ok(PROMPT_DIRECTIVES.has("plan"));
  assert.ok(PROMPT_DIRECTIVES.has("boost"));
  assert.ok(PROMPT_DIRECTIVES.has("goal"));
  assert.ok(PROMPT_DIRECTIVES.has("grill-me"));
});

test("parity phase 1: prompt directives are passed directly to job queue without rejection", async () => {
  for (const directive of ["/plan Create architecture doc", "/boost Optimize query", "/goal Ship feature", "/grill-me Clarify API"]) {
    const harness = createHarness();
    const ctx = asAppContext(harness);
    try {
      await handleUpdate(ctx, textUpdate(12345, directive));
      assert.equal(harness.capturedJobs.length, 1);
      const job = harness.capturedJobs[0];
      assert.equal(job.kind, "prompt");
      assert.equal(job.prompt, directive);
    } finally {
      harness.cleanup();
    }
  }
});

test("parity phase 1: unrecognized slash commands are rejected with /menu notice", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(12345, "/unknown-cmd-test"));
    assert.equal(harness.capturedJobs.length, 0);
    const sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("Unknown command. Use /menu.")));
  } finally {
    harness.cleanup();
  }
});

test("parity phase 1: /title and /rename update session title and persist in SQLite", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const convId = "00000000-0000-4000-8000-000000000001";
    ctx.convDb.upsertConversation({
      conversation_id: convId,
      title: "Old title",
      preview: "Old title",
      step_count: 2,
    });

    await ctx.state.setSession("12345", {
      conversationId: convId,
      conversationTitle: "Old title",
    } as never);

    // Test usage if empty
    await handleTitleCommand(ctx, "12345", "");
    let sent = harness.telegram.sentTexts();
    assert.ok(sent[sent.length - 1].includes("Usage: <code>/title"));

    // Test /title
    await handleTitleCommand(ctx, "12345", "New Architecture Phase 1");
    let session = ctx.state.session("12345");
    assert.equal(session?.conversationTitle, "New Architecture Phase 1");

    let conv = ctx.convDb.getConversationById(convId);
    assert.equal(conv?.display_title, "New Architecture Phase 1");

    // Test /rename alias via handleCommand
    await handleCommand(ctx, textUpdate(12345, "").message!, "/rename", ["Refactored", "Telemetry"]);
    session = ctx.state.session("12345");
    assert.equal(session?.conversationTitle, "Refactored Telemetry");
    conv = ctx.convDb.getConversationById(convId);
    assert.equal(conv?.display_title, "Refactored Telemetry");
  } finally {
    harness.cleanup();
  }
});

test("parity phase 1: /diff detects non-git workspace and clean git workspace", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    // 1. Non-git workspace
    await handleDiffCommand(ctx, "12345");
    let sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("not an initialized Git repository")));

    // 2. Initialize a git repo in workspace
    const ws = harness.config.agy.workspace;
    execFileSync("git", ["init"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "TestUser"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: ws });
    fs.writeFileSync(path.join(ws, "README.md"), "# Test Project\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: ws });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: ws });

    // 3. Clean workspace diff
    await handleDiffCommand(ctx, "12345");
    sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("No local changes in active workspace")));

    // 4. Dirty workspace with short diff
    fs.writeFileSync(path.join(ws, "README.md"), "# Test Project Modified\n", "utf8");
    await handleDiffCommand(ctx, "12345");
    sent = harness.telegram.sentTexts();
    assert.ok(sent.some((t) => t.includes("Git diff:") && t.includes("Test Project Modified")));
  } finally {
    harness.cleanup();
  }
});
