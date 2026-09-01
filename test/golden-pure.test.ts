import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs, parseCommandArgs, parseStreamOutput } from "../src/agy-runner.js";
import { formatRelativeTime, isUuid, parseTimestamp } from "../src/db.js";
import { getModelMaxContext, modelLabel, renderContextProgressBar } from "../src/models.js";
import type { AgyConfig } from "../src/types.js";

const baseConfig: AgyConfig = {
  bin: "/usr/bin/agy",
  workspace: "/srv/ws",
  project: "",
  mode: "accept-edits",
  sandbox: false,
  allowSandboxDisable: true,
  model: "",
  effort: "high",
  allowedModels: [],
  timeoutMs: 60_000,
  maxOutputBytes: 1_000_000,
  allowDangerouslySkipPermissions: false,
  dbPath: "/tmp/x.db",
};

test("golden: buildArgs emits exact CLI contract for a default stream-json prompt", () => {
  const args = buildArgs(baseConfig, "hello", null, {});
  assert.deepEqual(args, ["--print", "hello", "--output-format", "stream-json", "--print-timeout", "60s", "--mode", "accept-edits", "--effort", "high"]);
});

test("golden: buildArgs injects attachment notes and add-dir for image and document runs", () => {
  const imageArgs = buildArgs(baseConfig, "", null, { imagePath: "/tmp/pic.png" });
  assert.equal(imageArgs[1], "Please analyze this image: /tmp/pic.png");
  assert.ok(imageArgs.includes("--add-dir"));
  assert.ok(imageArgs.includes("/tmp"));

  const docArgs = buildArgs(baseConfig, "summarize", "conv-1", { documentPath: "/ws/doc.pdf" });
  assert.equal(docArgs[1], "summarize\n\n[Document attached: /ws/doc.pdf]");
  assert.ok(docArgs.includes("--conversation"));
  assert.ok(docArgs.includes("conv-1"));
});

test("golden: buildArgs skips effort for claude models and effort-suffixed models", () => {
  const claude = buildArgs({ ...baseConfig }, "go", null, { model: "claude-sonnet-4-6", effort: "low" });
  assert.ok(!claude.includes("--effort"));
  const suffixed = buildArgs({ ...baseConfig }, "go", null, { model: "gemini-3.7-flash-medium", effort: "low" });
  assert.ok(!suffixed.includes("--effort"));
});

test("golden: parseCommandArgs handles quotes, escapes, and rejects unclosed quotes", () => {
  assert.deepEqual(parseCommandArgs(`--print "two words" --output-format text`), ["--print", "two words", "--output-format", "text"]);
  assert.deepEqual(parseCommandArgs(`--print 'single \\" quote'`), ["--print", 'single " quote']);
  assert.throws(() => parseCommandArgs("--print \"unclosed"), /Unclosed quote/);
});

test("golden: parseStreamOutput extracts response, usage, conversation id and tool calls", () => {
  const stdout = [
    JSON.stringify({ event: "init", init: { model: "gemini-3.7-flash-high" }, conversationId: "abc-123" }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "tool", tool_info: { name: "view_file", parameters: { path: "/x/y.ts" } }, usage: { input_tokens: 10 } } }),
    JSON.stringify({ event: "step_update", step_update: { text_delta: "Hel" } }),
    JSON.stringify({ event: "step_update", step_update: { text_delta: "lo" } }),
    JSON.stringify({ event: "result", result: { response: "Hello!", usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, duration_seconds: 2.5, num_turns: 2, status: "SUCCESS" } }),
  ].join("\n");
  const result = parseStreamOutput(stdout);
  assert.equal(result.text, "Hello!");
  assert.equal(result.conversationId, "abc-123");
  assert.equal(result.model, "gemini-3.7-flash-high");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.numTurns, 2);
  assert.equal(result.durationMs, 2500);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
});

test("golden: context progress bar renders percentage buckets deterministically", () => {
  assert.equal(renderContextProgressBar(500_000, 1_000_000), "[█████░░░░░] 50.0% (500,000 / 1M)");
  assert.equal(renderContextProgressBar(0, 200_000), "[░░░░░░░░░░] 0.0% (0 / 200K)");
  assert.equal(renderContextProgressBar(2_000_000, 200_000), "2,000,000 tokens (Session Total)");
});

test("golden: model label and context fallbacks", () => {
  assert.equal(modelLabel(null), "AGY default");
  assert.equal(modelLabel("totally-unknown"), "totally-unknown");
  assert.equal(getModelMaxContext("some-new-gemini"), 1_000_000);
  assert.equal(getModelMaxContext("claude-x"), 200_000);
});

test("golden: timestamp normalization across seconds/millis/iso strings", () => {
  const fixed = Date.parse("2026-01-15T10:30:00Z");
  assert.equal(parseTimestamp(fixed), fixed);
  assert.equal(parseTimestamp(Math.floor(fixed / 1000)), fixed);
  assert.equal(parseTimestamp("2026-01-15T10:30:00Z"), fixed);
  assert.ok(Number.isFinite(parseTimestamp(undefined)));
});

test("golden: relative time buckets", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 30_000, now), "just now");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), "2d ago");
  assert.match(formatRelativeTime(now - 30 * 86_400_000, now), /^\d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/);
});

test("golden: uuid validation", () => {
  assert.equal(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d479"), true);
  assert.equal(isUuid("F47AC10B-58CC-4372-A567-0E02B2C3D479"), true);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("f47ac10b58cc4372a5670e02b2c3d479"), false);
});
