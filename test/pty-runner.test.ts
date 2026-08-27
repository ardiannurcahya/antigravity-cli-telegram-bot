import test from "node:test";
import assert from "node:assert/strict";
import { cleanAnsi, parseUsageQuota, parseCredits, parseContext, runPtyCommand } from "../src/pty-runner.js";

test("cleanAnsi removes terminal escape codes, OSC sequences, and kitty sequences", () => {
  const raw = "\x1b[>4m\x1b[=0;1u\x1b[?2004h\x1b]0;Terminal Title\x07\x1b[32mHello\x1b[0m \x1b[1;34mWorld\x1b[0m\r\n\x1b[2J\x1b[H\x1b[?2004l";
  assert.equal(cleanAnsi(raw).trim(), "Hello World");
});

test("parseUsageQuota formats production GEMINI MODELS & CLAUDE AND GPT MODELS with progress bars and traffic lights", () => {
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
  assert.match(parsed, /Weekly: 🟢 <b>94%<\/b> \(in 151h 15m\) <i>\[\+4%\]<\/i>/);
  assert.match(parsed, /5-Hour: ⭐ <b>81%<\/b> \(in 1h 52m\) <i>\[\+44%\]<\/i>/);
  assert.match(parsed, /<b>Claude &amp; GPT Models<\/b>|<b>Claude & GPT Models<\/b>/);
  assert.match(parsed, /Weekly: 🟢 <b>100%<\/b>/);
  assert.match(parsed, /5-Hour: 🟢 <b>100%<\/b>/);
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
  assert.match(parsed, /Weekly: 🟡 <b>68%<\/b> \(in 120h 25m\) <i>\[-4%\]<\/i>/);
  assert.match(parsed, /5-Hour: 🟢 <b>100%<\/b> \(in 4h 58m\) <i>\[\+1%\]<\/i>/);
});

test("parseUsageQuota correctly classifies Star, Green, Amber, and Red pacing", () => {
  // Green (on track): 84% remaining with 141h 43m left (expected ~84.4%, delta -0.4% -> On track)
  // Star (comfortable buffer): 91% remaining with 1h 42m left (expected 34%, delta +57% -> ⭐)
  const sample = `
Models & Quota
GEMINI MODELS
Weekly Limit Remaining
84% remaining
Refreshes in 141h 43m
Five Hour Limit Remaining
91% remaining
Refreshes in 1h 42m
`;
  const greenParsed = parseUsageQuota(sample);
  assert.match(greenParsed, /Weekly: 🟢 <b>84%<\/b> \(in 141h 43m\) <i>\[On track\]<\/i>/);
  assert.match(greenParsed, /5-Hour: ⭐ <b>91%<\/b> \(in 1h 42m\) <i>\[\+57%\]<\/i>/);

  // Red (critical pacing): 50% remaining with 120h left (expected 71.4% -> delta -21.4%)
  const redSample = `
Models & Quota
GEMINI MODELS
Weekly Limit Remaining
50% remaining
Refreshes in 120h
Five Hour Limit Remaining
8% remaining
Refreshes in 30m
`;
  const redParsed = parseUsageQuota(redSample);
  assert.match(redParsed, /Weekly: 🔴 <b>50%<\/b> \(in 120h\) <i>\[-21%\]<\/i>/);
  assert.match(redParsed, /5-Hour: 🔴 <b>8%<\/b> \(in 30m\) <i>\[-2%\]<\/i>/);
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
  assert.match(parsed, /Weekly: 🟢 <b>100\.00%<\/b>/);
  assert.doesNotMatch(parsed, /<b>00%/);
});

test("parseUsageQuota handles 0.00% and Disabled limits accurately", () => {
  const sample = `
└ Models & Quota

  Account: stephan.bolten@gmail.com

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit Remaining
    [███████████████████████████████████████░░░░░░░░░░░] 78.92%
    79% remaining · Refreshes in 125h 46m

  Five Hour Limit Remaining
    [█████████████████████████████████████████████████░] 98.67%
    99% remaining · Refreshes in 4h 45m

CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit Remaining
    [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.00%
    Refreshes in 59h 50m

  Five Hour Limit Remaining
    Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully re
`;

  const parsed = parseUsageQuota(sample);
  assert.match(parsed, /<b>Gemini Models<\/b>/);
  assert.match(parsed, /Weekly: 🟢 <b>78\.92%<\/b> \(in 125h 46m\)/);
  assert.match(parsed, /5-Hour: 🟢 <b>98\.67%<\/b> \(in 4h 45m\)/);
  assert.match(parsed, /<b>Claude & GPT Models<\/b>/);
  assert.match(parsed, /Weekly: 🔴 <b>0\.00%<\/b> \(in 59h 50m\)/);
  assert.match(parsed, /5-Hour: ⚪ <i>Disabled<\/i>/);
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
