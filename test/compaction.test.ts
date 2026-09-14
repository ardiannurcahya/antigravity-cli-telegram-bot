import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenCount } from "../src/domain/usage-math.js";
import { contextButtonLabel, contextActionsKeyboard, mainInlineKeyboard } from "../src/ui/inline-keyboards.js";
import { createHarness } from "./helpers/fixtures.js";
import { runCompactionJob } from "../src/usecases/compaction.js";
import type { AgyResult } from "../src/types.js";

test("formatTokenCount correctly formats tokens across ranges", () => {
  assert.equal(formatTokenCount(null), "");
  assert.equal(formatTokenCount(undefined), "");
  assert.equal(formatTokenCount(0), "");
  assert.equal(formatTokenCount(533), "533");
  assert.equal(formatTokenCount(4100), "4.1k");
  assert.equal(formatTokenCount(146300), "146k");
  assert.equal(formatTokenCount(1000000), "1M");
  assert.equal(formatTokenCount(1200000), "1.2M");
});

test("contextButtonLabel renders dynamic labels based on session telemetry", () => {
  assert.equal(contextButtonLabel(null), "🧠 Active Context");
  assert.equal(contextButtonLabel({}), "🧠 Active Context");
  assert.equal(contextButtonLabel({ contextTokens: "142k" }), "🧠 142k");
  assert.equal(contextButtonLabel({ contextTokens: "142k", contextPercentage: 14 }), "🧠 142k (14%)");
});

test("contextActionsKeyboard generates compact and refresh action buttons", () => {
  const keyboard = contextActionsKeyboard();
  assert.equal(keyboard.inline_keyboard.length, 1);
  assert.equal(keyboard.inline_keyboard[0].length, 2);
  assert.equal(keyboard.inline_keyboard[0][0].text, "🗜️ Compact Context");
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "action:compact");
  assert.equal(keyboard.inline_keyboard[0][1].text, "🔄 Refresh");
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, "action:context");
});

test("mainInlineKeyboard in dev profile adapts label to session context telemetry", async () => {
  const harness = createHarness();
  const chatId = 12345;

  // Set profile to dev
  await harness.state.setSession(chatId, {
    settings: { menuProfile: "dev" },
  });

  const keyboardDefault = mainInlineKeyboard(harness as any, chatId);
  const devRowDefault = keyboardDefault.inline_keyboard.find((row) => row.some((b) => b.callback_data === "action:context"));
  assert.ok(devRowDefault);
  const contextBtnDefault = devRowDefault.find((b) => b.callback_data === "action:context");
  assert.equal(contextBtnDefault?.text, "🧠 Active Context");

  // Update session with context telemetry
  await harness.state.setSession(chatId, {
    contextTokens: "142k",
    contextPercentage: 14,
  });

  const keyboardWithTelemetry = mainInlineKeyboard(harness as any, chatId);
  const devRowWithTelemetry = keyboardWithTelemetry.inline_keyboard.find((row) => row.some((b) => b.callback_data === "action:context"));
  assert.ok(devRowWithTelemetry);
  const contextBtnWithTelemetry = devRowWithTelemetry.find((b) => b.callback_data === "action:context");
  assert.equal(contextBtnWithTelemetry?.text, "🧠 142k (14%)");

  harness.cleanup();
});

test("runCompactionJob aborts safely when no conversation is active", async () => {
  const harness = createHarness();
  const chatId = 999;
  const controller = new AbortController();

  await runCompactionJob(harness as any, { chatId, kind: "compact" }, controller, () => false);

  const sent = harness.telegram.sentTexts();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /No active AGY conversation to compact/);

  harness.cleanup();
});

test("runCompactionJob fail-safe abort preserves session when synthesis fails", async () => {
  const harness = createHarness();
  const chatId = 1001;
  const controller = new AbortController();

  // Create mock script that fails on synthesis
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const mockScript = path.join(os.tmpdir(), `mock-fail-${Date.now()}.sh`);
  fs.writeFileSync(mockScript, '#!/bin/sh\necho "Simulated model failure" >&2\nexit 1\n', { mode: 0o755 });

  harness.config.agy.bin = mockScript;

  await harness.state.setSession(chatId, {
    conversationId: "original-conv-id",
    settings: { model: "gemini-3.8-flash-high", workspace: harness.config.agy.workspace },
    contextTokens: "150k",
  });

  await runCompactionJob(harness as any, { chatId, kind: "compact" }, controller, () => false);

  // Verify session is still intact (NOT reset)
  const sessionAfter = harness.state.session(chatId);
  assert.equal(sessionAfter?.conversationId, "original-conv-id");
  assert.equal(sessionAfter?.settings?.workspace, harness.config.agy.workspace);

  // Verify failure notification was sent/edited
  const edited = harness.telegram.editedTexts();
  const progressEdit = edited.find((text) => /Compaction aborted/i.test(text));
  assert.ok(progressEdit, "Should have edited progress message with abort notice");

  fs.unlinkSync(mockScript);
  harness.cleanup();
});

test("runCompactionJob successfully executes 3-phase compaction pipeline", async () => {
  const harness = createHarness();
  const chatId = 1002;
  const controller = new AbortController();

  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const mockScript = path.join(os.tmpdir(), `mock-compaction-${Date.now()}.js`);

  const scriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const printIndex = args.indexOf("--print");
const prompt = printIndex >= 0 ? args[printIndex + 1] : "";

if (prompt.includes("Synthesize our active task state")) {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-synth-123",
      response: "1. Objective: Refactor parser\\n2. Modified: src/types.ts\\n3. Next: run tests",
      usage: { input_tokens: 150000, total_tokens: 150500 },
    },
  }));
} else if (prompt.includes("Resuming task from handover snapshot")) {
  if (!prompt.includes("Do not include any token metrics")) {
    console.error("Re-hydration prompt missing anti-hallucination constraint");
    process.exit(1);
  }
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-fresh-999",
      response: "State restored. Resuming next step.",
      usage: { input_tokens: 3500, total_tokens: 3800 },
    },
  }));
} else {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-default",
      response: "default response",
    },
  }));
}
`;
  fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
  harness.config.agy.bin = mockScript;

  await harness.state.setSession(chatId, {
    conversationId: "old-saturated-conv-id",
    settings: { model: "gemini-3.8-flash-high", effort: "high", workspace: harness.config.agy.workspace },
    contextTokens: "150k",
    contextPercentage: 15,
  });

  await runCompactionJob(harness as any, { chatId, kind: "compact" }, controller, () => false);

  // Check state after compaction
  const sessionAfter = harness.state.session(chatId);
  assert.equal(sessionAfter?.conversationId, "conv-fresh-999", "Conversation ID must be updated to the fresh session");
  assert.equal(sessionAfter?.settings?.workspace, harness.config.agy.workspace, "Workspace must be preserved");
  assert.equal(sessionAfter?.settings?.model, "gemini-3.8-flash-high", "Model must be preserved");
  assert.equal(sessionAfter?.settings?.effort, "high", "Effort must be preserved");
  assert.equal(sessionAfter?.contextTokens, "3.5k", "Context tokens must reflect new compacted size");

  // Check messages sent to user
  const edited = harness.telegram.editedTexts();
  const successEdit = edited.find((text) => /Context compacted successfully/i.test(text));
  assert.ok(successEdit, "Should have announced successful compaction");
  assert.match(successEdit, /Reduced from ~150k to 3\.5k tokens/i);

  const sent = harness.telegram.sentTexts();
  const modelAck = sent.find((text) => /State restored\. Resuming next step\./i.test(text));
  assert.equal(modelAck, undefined, "Should not deliver redundant separate model acknowledgement to avoid chat clutter");

  fs.unlinkSync(mockScript);
  harness.cleanup();
});

test("runCompactionJob preserves session and delivers handover note when re-hydration fails", async () => {
  const harness = createHarness();
  const chatId = 1003;
  const controller = new AbortController();

  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const mockScript = path.join(os.tmpdir(), `mock-rehydration-fail-${Date.now()}.js`);

  const scriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const printIndex = args.indexOf("--print");
const prompt = printIndex >= 0 ? args[printIndex + 1] : "";

if (prompt.includes("Synthesize our active task state")) {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-synth-1003",
      response: "Synthesized snapshot content for handover",
      usage: { input_tokens: 80000, total_tokens: 80500 },
    },
  }));
} else if (prompt.includes("Resuming task from handover snapshot")) {
  console.error("Simulated re-hydration failure: model API unavailable");
  process.exit(1);
}
`;
  fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
  harness.config.agy.bin = mockScript;

  await harness.state.setSession(chatId, {
    conversationId: "original-conv-1003",
    settings: { model: "gemini-3.8-flash-high", workspace: harness.config.agy.workspace },
    contextTokens: "80k",
  });

  await runCompactionJob(harness as any, { chatId, kind: "compact" }, controller, () => false);

  // Verify session remains intact and attached to the original conversation
  const sessionAfter = harness.state.session(chatId);
  assert.equal(sessionAfter?.conversationId, "original-conv-1003", "Session conversation ID must remain intact on failure");
  assert.equal(sessionAfter?.contextTokens, "80k");

  // Verify progress message notified user with bounded message indicating session is preserved
  const edited = harness.telegram.editedTexts();
  const abortEdit = edited.find((text) => /Compaction aborted.*re-hydration failed/i.test(text));
  assert.ok(abortEdit, "Progress message must contain abort notification");
  assert.match(abortEdit, /Original session preserved intact/i);

  // Verify handover snapshot note was delivered via formatted reply
  const sent = harness.telegram.sentTexts();
  const snapshotFallback = sent.find((text) => /Handover snapshot note/i.test(text));
  assert.ok(snapshotFallback, "Snapshot fallback note must be delivered to chat");

  fs.unlinkSync(mockScript);
  harness.cleanup();
});

test("runCompactionJob preserves session when re-hydration returns no conversation ID", async () => {
  const harness = createHarness();
  const chatId = 1004;
  const controller = new AbortController();

  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const mockScript = path.join(os.tmpdir(), `mock-missing-conv-${Date.now()}.js`);

  const scriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const printIndex = args.indexOf("--print");
const prompt = printIndex >= 0 ? args[printIndex + 1] : "";

if (prompt.includes("Synthesize our active task state")) {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-synth-1004",
      response: "Synthesized snapshot content",
      usage: { input_tokens: 50000, total_tokens: 50200 },
    },
  }));
} else if (prompt.includes("Resuming task from handover snapshot")) {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: null,
      response: "Restored but missing ID",
      usage: { input_tokens: 2000, total_tokens: 2100 },
    },
  }));
}
`;
  fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
  harness.config.agy.bin = mockScript;

  await harness.state.setSession(chatId, {
    conversationId: "original-conv-1004",
    settings: { model: "gemini-3.8-flash-high", workspace: harness.config.agy.workspace },
    contextTokens: "50k",
  });

  await runCompactionJob(harness as any, { chatId, kind: "compact" }, controller, () => false);

  // Verify original session is preserved
  const sessionAfter = harness.state.session(chatId);
  assert.equal(sessionAfter?.conversationId, "original-conv-1004", "Session must remain intact if no conversation ID is produced");

  const edited = harness.telegram.editedTexts();
  const abortEdit = edited.find((text) => /did not return a valid conversation ID/i.test(text));
  assert.ok(abortEdit, "Progress message must indicate missing conversation ID");
  assert.match(abortEdit, /Original session preserved intact/i);

  fs.unlinkSync(mockScript);
  harness.cleanup();
});

test("runCompactionJob preserves session when re-hydration is cancelled", async () => {
  const harness = createHarness();
  const chatId = 1005;
  const controller = new AbortController();

  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const mockScript = path.join(os.tmpdir(), `mock-cancelled-${Date.now()}.js`);

  const scriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const printIndex = args.indexOf("--print");
const prompt = printIndex >= 0 ? args[printIndex + 1] : "";

if (prompt.includes("Synthesize our active task state")) {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-synth-1005",
      response: "Snapshot ready",
      usage: { input_tokens: 40000, total_tokens: 40200 },
    },
  }));
} else {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-cancelled",
      response: "Cancelled run",
    },
  }));
}
`;
  fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
  harness.config.agy.bin = mockScript;

  await harness.state.setSession(chatId, {
    conversationId: "original-conv-1005",
    settings: { model: "gemini-3.8-flash-high", workspace: harness.config.agy.workspace },
    contextTokens: "40k",
  });

  // Let cancellation trigger when checking after re-hydration
  await runCompactionJob(harness as any, { chatId, kind: "compact" }, controller, () => {
    return true;
  });

  // Verify session remains intact
  const sessionAfter = harness.state.session(chatId);
  assert.equal(sessionAfter?.conversationId, "original-conv-1005", "Session must remain intact if compaction is cancelled");

  fs.unlinkSync(mockScript);
  harness.cleanup();
});

test("runCompactionJob clears continueSession and newProject flags during re-hydration and session commit", async () => {
  const harness = createHarness();
  const chatId = 1006;
  const controller = new AbortController();

  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const mockScript = path.join(os.tmpdir(), `mock-flags-${Date.now()}.js`);

  const scriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const printIndex = args.indexOf("--print");
const prompt = printIndex >= 0 ? args[printIndex + 1] : "";

if (prompt.includes("Synthesize our active task state")) {
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-synth-1006",
      response: "Snapshot for flag check",
      usage: { input_tokens: 45000, total_tokens: 45200 },
    },
  }));
} else if (prompt.includes("Resuming task from handover snapshot")) {
  if (args.includes("--continue") || args.includes("--new-project")) {
    console.error("Re-hydration invocation must not inherit --continue or --new-project flags");
    process.exit(1);
  }
  console.log(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "fresh-conv-1006",
      response: "Fresh compacted session active",
      usage: { input_tokens: 1800, total_tokens: 1900 },
    },
  }));
}
`;
  fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
  harness.config.agy.bin = mockScript;

  await harness.state.setSession(chatId, {
    conversationId: "original-conv-1006",
    settings: {
      model: "gemini-3.8-flash-high",
      workspace: harness.config.agy.workspace,
      continueSession: true,
      newProject: true,
    },
    contextTokens: "45k",
  });

  await runCompactionJob(harness as any, { chatId, kind: "compact" }, controller, () => false);

  const sessionAfter = harness.state.session(chatId);
  assert.equal(sessionAfter?.conversationId, "fresh-conv-1006", "Compacted session must be activated");
  assert.equal(sessionAfter?.settings?.continueSession, false, "continueSession must be reset to false");
  assert.equal(sessionAfter?.settings?.newProject, false, "newProject must be reset to false");

  fs.unlinkSync(mockScript);
  harness.cleanup();
});

