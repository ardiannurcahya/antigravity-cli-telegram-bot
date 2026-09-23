import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTelemetryQuoteBlock,
  formatSessionDuration,
  evaluateActiveContext,
  evaluatePromptCache,
  evaluateThinkingTokens,
  evaluateToolCalls,
  evaluateResponseSize,
  type TelemetryData,
} from "../src/domain/telemetry.js";
import { formatTelegramHtml, formatTelegramHtmlChunks } from "../src/telegram.js";
import { loadConfig } from "../src/config.js";

test("TC-TEL-01: balanced nominal turn", () => {
  const data: TelemetryData = {
    contextGrowthTokens: 1_280,
    activeTokens: 45_000,
    maxTokens: 1_000_000,
    inputTokens: 1_000,
    cacheReadTokens: 9_000,
    thinkingTokens: 1_240,
    outputTokens: 280,
    toolCalls: 2,
    durationMs: 1_200,
    model: "gemini-3.8-flash-high",
  };

  const block = buildTelemetryQuoteBlock(data);
  assert.match(block, /\*\*>\s*⚡ Run: \+1\.3k ctx · 2 tools · 1\.2s · 5% ctx/);
  assert.match(block, /⏱️ \*\*This turn\*\*/);
  assert.match(block, /• \*\*Context growth:\*\* \+1,280 tokens \(feeds active context\)/);
  assert.match(block, /• \*\*Thinking tokens:\*\* 1,240 tokens — Balanced reasoning/);
  assert.match(block, /• \*\*Tool calls:\*\* 2 executions — Nominal \(verified on server\)/);
  assert.match(block, /• \*\*Model & duration:\*\* Gemini 3\.8 Flash \(High\) · 1\.2s/);
  assert.match(block, /📊 \*\*Session totals\*\*/);
  assert.match(block, /• \*\*Active context:\*\* 45,000 \/ 1,000,000 tokens \(5%\) — Nominal/);
  assert.match(block, /• \*\*Prompt cache:\*\* 90% hit rate — Warm cache \(optimal\)/);

  // Render to Telegram HTML
  const html = formatTelegramHtml(block);
  assert.match(html, /^<blockquote expandable>/);
  assert.match(html, /<\/blockquote>$/);
  assert.match(html, /<b>Active context:<\/b>/);
  assert.match(html, /Model &amp; duration:/);
});

test("TC-TEL-02: 0 tools executed (clean conceptual answer without warning)", () => {
  const data: TelemetryData = {
    contextGrowthTokens: 5_350,
    activeTokens: 25_000,
    maxTokens: 1_000_000,
    inputTokens: 5_000,
    cacheReadTokens: 20_000,
    thinkingTokens: 800,
    outputTokens: 350,
    toolCalls: 0,
    durationMs: 1_400,
    model: "gemini-3.8-flash",
  };

  const block = buildTelemetryQuoteBlock(data);
  // Must NOT contain ⚠️ on 0 tools (maintainer feedback)
  assert.match(block, /\*\*>\s*⚡ Run: \+5\.3k ctx · 0 tools · 1\.4s · 3% ctx/);
  assert.doesNotMatch(block, /0 tools ⚠️/);
  assert.match(block, /• \*\*Context growth:\*\* \+5,350 tokens \(feeds active context\)/);
  assert.match(block, /• \*\*Tool calls:\*\* 0 executions — Conceptual answer \(no files or commands checked on server\)/);
});

test("TC-TEL-03: saturated context (> 70%) triggers visual alert", () => {
  const data: TelemetryData = {
    activeTokens: 780_000,
    maxTokens: 1_000_000,
    inputTokens: 200_000,
    cacheReadTokens: 580_000,
    thinkingTokens: 1_500,
    outputTokens: 500,
    toolCalls: 3,
    durationMs: 3_200,
    model: "gemini-3.8-flash",
  };

  const block = buildTelemetryQuoteBlock(data);
  assert.match(block, /78% ctx ⚠️/);
  assert.match(block, /• \*\*Active context:\*\* 780,000 \/ 1,000,000 tokens \(78%\) — Alert \(run \/compact or \/new\)/);
});

test("TC-TEL-04: cache miss or cold start (0% hit rate)", () => {
  const data: TelemetryData = {
    activeTokens: 20_000,
    maxTokens: 1_000_000,
    inputTokens: 20_000,
    cacheReadTokens: 0,
    thinkingTokens: 600,
    outputTokens: 200,
    toolCalls: 1,
    durationMs: 1_800,
    model: "gemini-3.8-flash",
  };

  const block = buildTelemetryQuoteBlock(data);
  assert.match(block, /• \*\*Prompt cache:\*\* 0% hit rate — Cold cache \/ cache miss/);
});

test("TC-TEL-05: model without thinking tokens reported", () => {
  const data: TelemetryData = {
    activeTokens: 15_000,
    maxTokens: 1_000_000,
    toolCalls: 1,
    durationMs: 900,
    model: "gemini-3.8-flash-low",
  };

  const block = buildTelemetryQuoteBlock(data);
  assert.match(block, /• \*\*Thinking tokens:\*\* 0 tokens — Minimal \/ fast reasoning/);
  assert.match(block, /• \*\*Context growth:\*\* \+15,000 tokens \(feeds active context\)/);
});

test("evaluateToolCalls scales properly with activity", () => {
  assert.equal(evaluateToolCalls(0).collapsedLabel, "0 tools");
  assert.equal(evaluateToolCalls(1).collapsedLabel, "1 tool");
  assert.equal(evaluateToolCalls(4).collapsedLabel, "4 tools");
  assert.equal(evaluateToolCalls(8).collapsedLabel, "8 tools");
  assert.equal(evaluateToolCalls(8).status, "vigilance");
  assert.equal(evaluateToolCalls(15).collapsedLabel, "15 tools ⚠️");
  assert.equal(evaluateToolCalls(15).status, "alert");
});

test("evaluateActiveContext threshold boundaries", () => {
  assert.equal(evaluateActiveContext(390_000, 1_000_000).status, "nominal");
  assert.equal(evaluateActiveContext(400_000, 1_000_000).status, "vigilance");
  assert.equal(evaluateActiveContext(700_000, 1_000_000).status, "vigilance");
  assert.equal(evaluateActiveContext(710_000, 1_000_000).status, "alert");
  assert.equal(evaluateActiveContext(710_000, 1_000_000).hasWarning, true);
});

test("evaluatePromptCache thresholds", () => {
  assert.equal(evaluatePromptCache(850, 150).status, "nominal");
  assert.equal(evaluatePromptCache(500, 500).status, "vigilance");
  assert.equal(evaluatePromptCache(200, 800).status, "alert");
});

test("evaluateThinkingTokens thresholds", () => {
  assert.equal(evaluateThinkingTokens(400).status, "vigilance");
  assert.equal(evaluateThinkingTokens(1500).status, "nominal");
  assert.equal(evaluateThinkingTokens(3000).status, "vigilance");
  assert.equal(evaluateThinkingTokens(5000).status, "alert");
});

test("evaluateResponseSize thresholds", () => {
  assert.equal(evaluateResponseSize(400).status, "nominal");
  assert.equal(evaluateResponseSize(800).status, "vigilance");
  assert.equal(evaluateResponseSize(1500).status, "alert");
});

test("chunking: telemetry footer is appended only to the final message chunk", () => {
  const longParagraph = "This is a long test response paragraph to test multi-chunk splitting. ".repeat(60);
  const data: TelemetryData = {
    activeTokens: 50_000,
    maxTokens: 1_000_000,
    toolCalls: 2,
    durationMs: 1500,
    model: "gemini-3.8-flash-high",
  };
  const footer = buildTelemetryQuoteBlock(data);
  const fullResponse = `${longParagraph}\n\n${footer}`;

  const maxChars = 1000;
  const chunks = formatTelegramHtmlChunks(fullResponse, maxChars);

  assert.ok(chunks.length > 1, "Response should be split into multiple chunks");
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.doesNotMatch(chunks[i], /<blockquote expandable>/, `Chunk ${i + 1} should NOT contain telemetry blockquote`);
    assert.doesNotMatch(chunks[i], /⚡ Run:/, `Chunk ${i + 1} should NOT contain telemetry header`);
  }
  const lastChunk = chunks[chunks.length - 1];
  assert.match(lastChunk, /<blockquote expandable>/, "Last chunk should contain telemetry blockquote");
  assert.match(lastChunk, /⚡ Run:/, "Last chunk should contain telemetry header");
});

test("config: TELEMETRY_POST_PROMPT parsing and default", () => {
  const baseEnv = {
    TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    TELEGRAM_ALLOWED_USER_IDS: "12345678",
    AGY_WORKSPACE: "/tmp",
  };

  // Default is 'message'
  const cfgDefault = loadConfig({ ...baseEnv });
  assert.equal(cfgDefault.telegram.telemetryPostPrompt, "message");

  // Explicit 'inline'
  const cfgInline = loadConfig({ ...baseEnv, TELEMETRY_POST_PROMPT: "inline" });
  assert.equal(cfgInline.telegram.telemetryPostPrompt, "inline");

  // Explicit 'progress'
  const cfgProgress = loadConfig({ ...baseEnv, TELEMETRY_POST_PROMPT: "progress" });
  assert.equal(cfgProgress.telegram.telemetryPostPrompt, "progress");

  // Explicit 'off'
  const cfgOff = loadConfig({ ...baseEnv, TELEMETRY_POST_PROMPT: "off" });
  assert.equal(cfgOff.telegram.telemetryPostPrompt, "off");

  // Aliases: 'footer' -> 'inline', 'separate' -> 'message', 'none' -> 'off'
  assert.equal(loadConfig({ ...baseEnv, TELEMETRY_POST_PROMPT: "footer" }).telegram.telemetryPostPrompt, "inline");
  assert.equal(loadConfig({ ...baseEnv, TELEMETRY_POST_PROMPT: "separate" }).telegram.telemetryPostPrompt, "message");
  assert.equal(loadConfig({ ...baseEnv, TELEMETRY_POST_PROMPT: "none" }).telegram.telemetryPostPrompt, "off");

  // Invalid throws
  assert.throws(() => loadConfig({ ...baseEnv, TELEMETRY_POST_PROMPT: "invalid" }), /TELEMETRY_POST_PROMPT must be/);
});

test("TC-TEL-08: explicit contextPercentage and session totals from Proposition 1", () => {
  const data: TelemetryData = {
    contextGrowthTokens: 2_705,
    activeTokens: 146_300,
    maxTokens: 1_000_000,
    contextPercentage: 14,
    sessionUsageTotals: { total_tokens: 320_000 },
    sessionTurns: 12,
    sessionDurationMs: 93_300,
    inputTokens: 2_205,
    cacheReadTokens: 10_045,
    thinkingTokens: 1_200,
    outputTokens: 500,
    toolCalls: 4,
    durationMs: 2_500,
    model: "gemini-3.8-flash",
  };

  const block = buildTelemetryQuoteBlock(data);
  assert.match(block, /\*\*>\s*⚡ Run: \+2\.7k ctx · 4 tools · 2\.5s · 14% ctx/);
  assert.match(block, /⏱️ \*\*This turn\*\*/);
  assert.match(block, /• \*\*Context growth:\*\* \+2,705 tokens \(feeds active context\)/);
  assert.match(block, /• \*\*Thinking tokens:\*\* 1,200 tokens — Balanced reasoning/);
  assert.match(block, /• \*\*Tool calls:\*\* 4 executions — Nominal \(verified on server\)/);
  assert.match(block, /• \*\*Model & duration:\*\* gemini-3\.8-flash · 2\.5s/);
  assert.match(block, /📊 \*\*Session totals\*\*/);
  assert.match(block, /• \*\*Active context:\*\* 146,300 \/ 1,000,000 tokens \(14%\) — Nominal/);
  assert.match(block, /• \*\*Cumulative usage:\*\* 320k tokens consumed · 12 turns · 1m 33s total/);
  assert.match(block, /• \*\*Prompt cache:\*\* 82% hit rate — Warm cache \(optimal\)/);
});

test("TC-TEL-09: compacted or pruned context (negative growth)", () => {
  const data: TelemetryData = {
    contextGrowthTokens: -20_000,
    activeTokens: 10_000,
    maxTokens: 1_000_000,
    durationMs: 1_500,
  };
  const block = buildTelemetryQuoteBlock(data);
  assert.match(block, /⚡ Run: -20k ctx/);
  assert.match(block, /• \*\*Context growth:\*\* -20,000 tokens \(pruned \/ compacted\)/);
});

test("TC-TEL-10: formatSessionDuration formatting thresholds", () => {
  assert.equal(formatSessionDuration(500), "0.5s total");
  assert.equal(formatSessionDuration(22_490), "22.5s total");
  assert.equal(formatSessionDuration(93_300), "1m 33s total");
  assert.equal(formatSessionDuration(3_720_000), "1h 2m total");
});

test("TC-TEL-11: run duration vs session duration isolation", () => {
  const data: TelemetryData = {
    contextGrowthTokens: 15_000,
    activeTokens: 63_000,
    maxTokens: 1_000_000,
    durationMs: 4_900,
    sessionDurationMs: 120_000,
    sessionUsageTotals: { total_tokens: 171_000 },
    sessionTurns: 3,
    toolCalls: 2,
    model: "gemini-3.8-flash",
  };
  const block = buildTelemetryQuoteBlock(data);
  // Header and This turn must report run duration (4.9s), NOT session duration (120s)
  assert.match(block, /\*\*>\s*⚡ Run: \+15k ctx · 2 tools · 4\.9s · 6% ctx/);
  assert.match(block, /• \*\*Model & duration:\*\* gemini-3\.8-flash · 4\.9s/);
  // Session totals reports cumulative duration (2m 0s total)
  assert.match(block, /• \*\*Cumulative usage:\*\* 171k tokens consumed · 3 turns · 2m 0s total/);
});

