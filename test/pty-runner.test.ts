import test from "node:test";
import assert from "node:assert/strict";
import { cleanAnsi, parseUsageQuota, parseCredits, parseContext, runPtyCommand } from "../src/pty-runner.js";

test("cleanAnsi removes terminal escape codes, OSC sequences, and kitty sequences", () => {
  const raw = "\x1b[>4m\x1b[=0;1u\x1b[?2004h\x1b]0;Terminal Title\x07\x1b[32mHello\x1b[0m \x1b[1;34mWorld\x1b[0m\r\n\x1b[2J\x1b[H\x1b[?2004l";
  assert.equal(cleanAnsi(raw).trim(), "Hello World");
});

test("parseUsageQuota formats production GEMINI MODELS & CLAUDE AND GPT MODELS with progress bars", () => {
  const productionSample = `
Models & Quota

Account: ardiannurcahya436@gmail.com

GEMINI MODELS
Weekly Limit Remaining
██████████████░░░░ 94% remaining
Refreshes in 151h 15m

Five Hour Limit Remaining
████████████░░░░░░ 81% remaining
Refreshes in 1h 52m

CLAUDE AND GPT MODELS
Weekly Limit Remaining
██████████████████ 100% Quota available

Five Hour Limit Remaining
██████████████████ 100% Quota available
`;

  const parsed = parseUsageQuota(productionSample);
  assert.match(parsed, /📊 <b>Models & Quota<\/b>/);
  assert.match(parsed, /<b>Account:<\/b> <code>ardiannurcahya436@gmail.com<\/code>/);
  assert.match(parsed, /<b>Gemini Models<\/b>/);
  assert.match(parsed, /Weekly Limit: <b>94% remaining<\/b> \(Refreshes in 151h 15m\)/);
  assert.match(parsed, /5-Hour Limit: <b>81% remaining<\/b> \(Refreshes in 1h 52m\)/);
  assert.match(parsed, /<b>Claude &amp; GPT Models<\/b>|<b>Claude & GPT Models<\/b>/);
  assert.match(parsed, /Weekly Limit: <b>100% Quota available<\/b>/);
  assert.match(parsed, /5-Hour Limit: <b>100% Quota available<\/b>/);
  // Ensure progress bar characters are NOT captured
  assert.doesNotMatch(parsed, /[█░▒▓]/);
});

test("parseUsageQuota preserves separate Gemini and Claude & GPT sections even with identical quotas", () => {
  const sharedSample = `
Models & Quota
Account: dev@example.com

GEMINI MODELS
Weekly Limit Remaining
████████████░░░░░░ 68% remaining
Refreshes in 120h 25m

Five Hour Limit Remaining
██████████████████ 100% remaining
Refreshes in 4h 58m

CLAUDE AND GPT MODELS
Weekly Limit Remaining
████████████░░░░░░ 68% remaining
Refreshes in 120h 25m

Five Hour Limit Remaining
██████████████████ 100% remaining
Refreshes in 4h 58m
`;

  const parsed = parseUsageQuota(sharedSample);
  assert.match(parsed, /<b>Gemini Models<\/b>/);
  assert.match(parsed, /<b>Claude & GPT Models<\/b>/);
  assert.match(parsed, /Weekly Limit: <b>68% remaining<\/b> \(Refreshes in 120h 25m\)/);
  assert.match(parsed, /5-Hour Limit: <b>100% remaining<\/b> \(Refreshes in 4h 58m\)/);
});

test("parseUsageQuota rejects startup / trust screen without quota data", () => {
  const startupScreen = `
Antigravity CLI v1.1.11
Do you trust the folder /srv/workspace? [y/n]
Type a command or prompt.
`;
  assert.throws(() => parseUsageQuota(startupScreen), /did not produce a Models & Quota report/);
});

test("parseCredits formats structured credits output", () => {
  const sample = `
Credits information
G1 credits remaining: 420.50
Purchase link: https://buy.antigravity.google.com/credits
`;
  const parsed = parseCredits(sample);
  assert.match(parsed, /💳 <b>AGY Credits<\/b>/);
  assert.match(parsed, /Credits Remaining: <b>420\.50<\/b>/);
  assert.match(parsed, /https:\/\/buy\.antigravity\.google\.com\/credits/);
});

test("parseCredits rejects empty / irrelevant output", () => {
  const splash = `Antigravity CLI (c) 2026 Google`;
  assert.throws(() => parseCredits(splash), /did not produce a Credits report/);
});

test("parseContext formats official active-context output", () => {
  const parsed = parseContext("/context Visualize current context usage\n└ Context Usage\n◉ ◉ ◉     Gemini 3.6 Flash (High) · 146.3k/1.0M tokens\n□ □ □     (14.0%)\n□ □ □     Token usage by category\n◉ User messages: 533 tokens (0.1%)\n◉ Agent responses: 97.5k tokens (9.3%)\n□ Free space: 902.2k (86.0%)\nCheckpoints (3) · /rewind\n└ Checkpoint 3 (active, in context): steps 117–304\nArtifact files · /artifact\n└ ~/.gemini/brain/plan.md: 1.6k tokens\nRelated: /artifact");
  assert.match(parsed, /Active Context/);
  assert.match(parsed, /146\.3k\/1\.0M tokens/);
  assert.match(parsed, /Free space: 902\.2k/);
  assert.match(parsed, /Token breakdown/);
  assert.match(parsed, /<b>Artifacts:<\/b> 1/);
  assert.doesNotMatch(parsed, /◉ ◉ ◉/);
});

test("parseContext rejects output without active context data", () => {
  assert.throws(() => parseContext("Antigravity CLI ready"), /Active Context report/);
});

test("parseUsageQuota preserves decimal percentages from AGY progress output", () => {
  const parsed = parseUsageQuota(`
    Models & Quota
    CLAUDE AND GPT MODELS
    Weekly Limit Remaining
    [██████████████████████████████████████████████████] 100.00%
    Quota available
    Five Hour Limit Remaining
    [██████████████████████████████████████████████████] 100.00%
    Quota available
  `);
  assert.match(parsed, /100\.00% Quota available/);
  assert.doesNotMatch(parsed, /<b>00% Quota available<\/b>/);
});

test("runPtyCommand cancels immediately when AbortSignal is aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      runPtyCommand(
        {
          bin: "/usr/bin/false",
          workspace: "/tmp",
          mode: "plan",
          effort: "high",
          sandbox: true,
          allowSandboxDisable: false,
          allowedModels: [],
          timeoutMs: 5000,
          maxOutputBytes: 10000,
          allowDangerouslySkipPermissions: false,
          dbPath: "/tmp/db.sqlite",
        },
        "/usage",
        { signal: controller.signal }
      ),
    /cancelled/
  );
});
