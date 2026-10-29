import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractQuota,
  renderQuota,
  parseUsageQuota,
  sectionHasLimits,
} from "../src/domain/quota-report.js";
import { extractCredits, parseCredits } from "../src/domain/credits-report.js";
import { extractContext, parseContext, parseContextMetrics } from "../src/domain/context-report.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pty");
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

test("quota: isolates the result panel past autocomplete noise and parses both providers", () => {
  const report = extractQuota(fixture("usage-two-providers.txt"));
  assert.equal(report.account, "ardiannurcahya436@gmail.com");
  assert.ok(sectionHasLimits(report.gemini));
  assert.ok(sectionHasLimits(report.claude));
  assert.equal(report.gemini.weekly.value, "94% remaining");
  assert.equal(report.gemini.weekly.refresh, "151h 15m");
  assert.equal(report.gemini.fiveHour.value, "81% remaining");
  assert.equal(report.claude.weekly.value, "100% Quota available");

  const html = renderQuota(report);
  assert.match(html, /<b>Gemini Models<\/b>/);
  assert.match(html, /<b>Claude &amp; GPT Models<\/b>|<b>Claude & GPT Models<\/b>/);
  assert.doesNotMatch(html, /[█░▒▓]/); // progress-bar glyphs stripped
});

test("quota resilience: parses a single provider without the literal 'Limit' keyword and a non-labeled account", () => {
  const report = extractQuota(fixture("usage-single-no-limit.txt"));
  assert.equal(report.account, "dev@example.com", "email recovered from 'Signed in as' line");
  assert.equal(report.gemini.weekly.value, "50% remaining");
  assert.equal(report.gemini.weekly.refresh, "100h");
  assert.equal(sectionHasLimits(report.claude), false);
  assert.match(parseUsageQuota(fixture("usage-single-no-limit.txt")), /Weekly: .* <b>50%<\/b>/);
});

test("quota: renders a disabled limit with the neutral indicator", () => {
  const html = parseUsageQuota(fixture("usage-disabled.txt"));
  assert.match(html, /5-Hour: ⚪ <i>Disabled<\/i>/);
  assert.match(html, /Weekly: .* <b>42%<\/b>/);
});

test("quota: throws when the output carries no quota information", () => {
  assert.throws(() => extractQuota("Antigravity CLI ready\n❯ "), /Models & Quota report/);
});

test("quota: parses separate GEMINI 4 ARGON section alongside Gemini and Claude & GPT", () => {
  const sample = `
└ Models & Quota

  Account: stephan.bolten@gmail.com

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit Remaining
    [██████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 43.64%
    Refreshes in 16h 22m

  Five Hour Limit Remaining
[█████████████████████████████████████████████████░] 98.42%
Refreshes in 3h 22m


CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit Remaining
[██████████████████████████████████████████████████] 100.00%
Quota available

  Five Hour Limit Remaining
[██████████████████████████████████████████████████] 100.00%
Quota available


GEMINI 4 ARGON
  For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) i

  Gemini 4 Argon Weekly Limit
[███████████████████████████████████████████░░░░░░░] 85.55%
Refreshes in 167h 0m


  │Within each group, models share a weekly limit and a 5-hour limit.
  ↑/↓ Scroll · pgup/pgdown Page · ctrl+end Bottom · ctrl+home Top · esc Close
accept-edits · Gemini 3.8 Flash · low (Google AI Pro)
`;

  const report = extractQuota(sample);
  assert.equal(report.account, "stephan.bolten@gmail.com");
  assert.ok(sectionHasLimits(report.gemini));
  assert.ok(sectionHasLimits(report.claude));
  assert.ok(sectionHasLimits(report.argon));
  assert.equal(report.argon.weekly.value, "85.55%");
  assert.equal(report.argon.weekly.refresh, "167h 0m");
  assert.equal(report.argon.fiveHour.value, null);

  const html = renderQuota(report);
  assert.match(html, /<b>Gemini Models<\/b>/);
  assert.match(html, /<b>Claude & GPT Models<\/b>/);
  assert.match(html, /<b>Gemini 4 Argon<\/b>/);
  assert.match(html, /• Weekly: 🔴 <b>85\.55%<\/b> \(in 167h 0m\) <i>\[-14%\]<\/i>/);
});

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

test("credits: extracts a balance and a purchase link", () => {
  const report = extractCredits(fixture("credits-balance.txt"));
  assert.equal(report.creditsRemaining, "$12.34");
  assert.equal(report.purchaseUrl, "https://antigravity.google/credits/buy");
  const html = parseCredits(fixture("credits-balance.txt"));
  assert.match(html, /Credits Remaining: <b>\$12\.34<\/b>/);
  assert.match(html, /<a href="https:\/\/antigravity\.google\/credits\/buy">/);
});

test("credits: throws when no credits information is present", () => {
  assert.throws(() => extractCredits("nothing useful here"), /Credits report/);
});

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

test("context: parses the panel, drops leading noise and the trailing Related/esc section", () => {
  const report = extractContext(fixture("context-full.txt"));
  assert.match(report.modelLine ?? "", /Gemini 3\.6 Flash \(High\) · 146\.3k\/1\.0M tokens/);
  assert.equal(report.categories.length, 3);
  assert.match(report.freeLine ?? "", /Free space: 902\.2k/);
  assert.match(report.checkpointLine ?? "", /Checkpoints \(3\)/);
  assert.equal(report.artifactsCount, 1);

  const html = parseContext(fixture("context-full.txt"));
  assert.match(html, /Token breakdown/);
  assert.match(html, /<b>Artifacts:<\/b> 1/);
  assert.doesNotMatch(html, /◉ ◉ ◉/);
  assert.doesNotMatch(html, /esc to cancel/);
});

test("context metrics: tolerant of commas and k/M units; never throws", () => {
  assert.deepEqual(parseContextMetrics("146,300 / 1,000,000 tokens (14.6%)"), {
    tokens: "146,300",
    currentTokens: 146300,
    maxTokens: 1000000,
    percentage: 15,
  });
  assert.deepEqual(parseContextMetrics("146.3k/1.0M tokens\n□ (14.0%)"), {
    tokens: "146.3k",
    currentTokens: 146300,
    maxTokens: 1000000,
    percentage: 14,
  });
  assert.deepEqual(parseContextMetrics("no tokens here"), {});
});
