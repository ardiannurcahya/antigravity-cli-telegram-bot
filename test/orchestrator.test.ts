import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildArgs } from "../src/agy-runner.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_MODELS, parseAgyModelsOutput, setActiveModels } from "../src/models.js";
import {
  buildOrchestratorCliSettings,
  formatModelDisplay,
  getOrchestratorFamilies,
  primaryOrchestratorModelId,
} from "../src/domain/orchestrator.js";
import { modelKeyboard, orchestratorKeyboard } from "../src/ui/inline-keyboards.js";
import { handleCallback } from "../src/router/callbacks.js";
import { handleCommand } from "../src/router/commands.js";
import { settingsFor } from "../src/domain/settings.js";
import { asAppContext, callbackUpdate, createHarness, textUpdate } from "./helpers/fixtures.js";

test("derives role-filtered families and efforts dynamically from agy models output", () => {
  const sampleOutput = [
    "gemini-4-neon-xhigh           Gemini 4 Neon (XHigh)",
    "gemini-4-neon-high            Gemini 4 Neon (High)",
    "gemini-4-neon-medium          Gemini 4 Neon (Medium)",
    "gemini-4-neon-low             Gemini 4 Neon (Low)",
    "gemini-4-carbon-high          Gemini 4 Carbon (High)",
    "gemini-4-carbon-medium        Gemini 4 Carbon (Medium)",
    "gemini-4-carbon-low           Gemini 4 Carbon (Low)",
    "gemini-4-argon-high           Gemini 4 Argon (High)",
    "gemini-4-argon-low            Gemini 4 Argon (Low)",
    "gemini-4-hydrogen-xhigh       Gemini 4 Hydrogen (XHigh)",
    "gemini-4-hydrogen-high        Gemini 4 Hydrogen (High)",
    "gemini-4-hydrogen-low         Gemini 4 Hydrogen (Low)",
    "claude-opus-5-5-high          Claude Opus 5.5 (High)",
    "claude-opus-5-5-medium        Claude Opus 5.5 (Medium)",
    "claude-sonnet-5-5-high        Claude Sonnet 5.5 (High)",
    "claude-sonnet-5-5-low         Claude Sonnet 5.5 (Low)",
    "gemini-pro-orchestrator-neon  Orchestrator (Neon)",
    "gemini-pro-orchestrator-g1-pro Orchestrator (Argon)",
    "gpt-oss-120b-medium           GPT-OSS 120B (Medium)",
  ].join("\n");

  const parsed = parseAgyModelsOutput(sampleOutput);
  const planners = getOrchestratorFamilies(parsed, "planner");
  assert.deepEqual(planners.map((f) => f.familyId), [
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-argon",
    "claude-opus-5-5",
  ]);
  assert.deepEqual(planners[0].variants.map((v) => v.effort), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(planners[1].variants.map((v) => v.effort), ["low", "medium", "high"]);

  const executors = getOrchestratorFamilies(parsed, "executor");
  assert.deepEqual(executors.map((f) => f.familyId), [
    "gemini-4-hydrogen",
    "claude-sonnet-5-5",
  ]);
  assert.deepEqual(executors[0].variants.map((v) => v.effort), ["low", "high", "xhigh"]);
  assert.deepEqual(executors[1].variants.map((v) => v.effort), ["low", "high"]);
  assert.equal(primaryOrchestratorModelId(parsed), "gemini-pro-orchestrator-neon");
});

test("buildArgs emits --settings with exact model labels and omits --effort for orchestrator", () => {
  const baseCfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    AGY_WORKSPACE: "/srv/ws",
  }).agy;

  const orchArgs = buildArgs(baseCfg, "plan and run", null, {
    model: "gemini-pro-orchestrator-neon",
    effort: "high",
    orchestratorPlanner: "gemini-4-neon-xhigh",
    orchestratorExecutor: "gemini-4-hydrogen-xhigh",
  });
  assert.ok(!orchArgs.includes("--effort"), "Orchestrator must never pass --effort");
  const settingsIdx = orchArgs.indexOf("--settings");
  assert.ok(settingsIdx >= 0, "Orchestrator custom pairing must pass --settings");
  assert.deepEqual(JSON.parse(orchArgs[settingsIdx + 1]), {
    orchestrator: {
      planner: "Gemini 4 Neon (XHigh)",
      executor: "Gemini 4 Hydrogen (XHigh)",
    },
  });

  const nonOrchArgs = buildArgs(baseCfg, "hello", null, {
    model: "gemini-3.8-flash-high",
    orchestratorPlanner: "gemini-4-neon-xhigh",
    orchestratorExecutor: "gemini-4-hydrogen-xhigh",
  });
  assert.ok(!nonOrchArgs.includes("--settings"), "Non-orchestrator models must not receive orchestrator --settings");

  const unsetPairingArgs = buildArgs(baseCfg, "hello", null, {
    model: "gemini-pro-orchestrator-neon",
    orchestratorPlanner: null,
    orchestratorExecutor: null,
  });
  assert.ok(!unsetPairingArgs.includes("--settings"), "Default pairing without overrides must omit --settings");
  assert.equal(buildOrchestratorCliSettings("gemini-3.8-flash-high", "gemini-4-neon-xhigh", null), null);
});

test("modelKeyboard collapses orchestrator entries and respects AGY_ALLOWED_MODELS", () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const kb = modelKeyboard(ctx, 777, 0);
    const callbacks = kb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.equal(callbacks.filter((c) => c === "menu:orchestrator").length, 1);
    assert.ok(!callbacks.includes("set:model:gemini-pro-orchestrator-neon"));
    assert.ok(!callbacks.includes("set:model:gemini-pro-orchestrator-g1-pro"));
  } finally {
    harness.cleanup();
  }

  const restricted = createHarness({
    AGY_ALLOWED_MODELS: "gemini-3.8-flash-high,claude-sonnet-5-5-high",
  });
  try {
    const rctx = asAppContext(restricted);
    const kb = modelKeyboard(rctx, 777, 0);
    const callbacks = kb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(!callbacks.includes("menu:orchestrator"), "Orchestrator must be hidden when excluded by AGY_ALLOWED_MODELS");
  } finally {
    restricted.cleanup();
  }
});

test("orchestrator callbacks update planner/executor, downgrade unsupported xhigh, stay under 64B, and persist defaults", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCallback(ctx, callbackUpdate("menu:orchestrator"));
    assert.equal(settingsFor(ctx, 777).model, "gemini-pro-orchestrator-neon");

    // Pick Neon (defaults to high), then switch to xhigh
    await handleCallback(ctx, callbackUpdate("set:orch:pf:gemini-4-neon"));
    assert.equal(settingsFor(ctx, 777).orchestratorPlanner, "gemini-4-neon-high");

    await handleCallback(ctx, callbackUpdate("set:orch:pe:xhigh"));
    assert.equal(settingsFor(ctx, 777).orchestratorPlanner, "gemini-4-neon-xhigh");

    // Switch Planner to Argon (does not support xhigh -> auto-downgrade to high)
    await handleCallback(ctx, callbackUpdate("set:orch:pf:gemini-4-argon"));
    assert.equal(settingsFor(ctx, 777).orchestratorPlanner, "gemini-4-argon-high");

    // Switch Executor to Claude Sonnet 5.5 and set effort to medium
    await handleCallback(ctx, callbackUpdate("set:orch:ef:claude-sonnet-5-5"));
    assert.equal(settingsFor(ctx, 777).orchestratorExecutor, "claude-sonnet-5-5-high");

    await handleCallback(ctx, callbackUpdate("set:orch:ee:medium"));
    assert.equal(settingsFor(ctx, 777).orchestratorExecutor, "claude-sonnet-5-5-medium");

    assert.equal(
      formatModelDisplay(settingsFor(ctx, 777)),
      "Orchestrator (Argon High → Sonnet 5.5 Medium)"
    );

    // Every callback_data in orchestratorKeyboard must be <= 64 bytes (Telegram limit)
    const kb = orchestratorKeyboard(ctx, 777);
    for (const btn of kb.inline_keyboard.flat()) {
      assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, `callback_data too long: ${btn.callback_data}`);
    }

    // Persist defaults via action:setdefault and verify .env + loadConfig round-trip
    await handleCallback(ctx, callbackUpdate("action:setdefault"));
    const envRaw = await fs.readFile(ctx.config.envFile!, "utf8");
    assert.match(envRaw, /^AGY_ORCHESTRATOR_PLANNER=gemini-4-argon-high$/m);
    assert.match(envRaw, /^AGY_ORCHESTRATOR_EXECUTOR=claude-sonnet-5-5-medium$/m);

    const reloaded = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWED_USER_IDS: "111",
      AGY_MODEL: "gemini-pro-orchestrator-neon",
      AGY_ORCHESTRATOR_PLANNER: "gemini-4-argon-high",
      AGY_ORCHESTRATOR_EXECUTOR: "claude-sonnet-5-5-medium",
    });
    assert.equal(reloaded.agy.orchestratorPlanner, "gemini-4-argon-high");
    assert.equal(reloaded.agy.orchestratorExecutor, "claude-sonnet-5-5-medium");

    // Reset pairing back to AGY default
    await handleCallback(ctx, callbackUpdate("set:orch:reset:default"));
    assert.equal(settingsFor(ctx, 777).orchestratorPlanner, null);
    assert.equal(settingsFor(ctx, 777).orchestratorExecutor, null);
  } finally {
    setActiveModels([...DEFAULT_MODELS]);
    harness.cleanup();
  }
});

test("/orchestrator and /model orchestrator commands validate and enforce AGY_ALLOWED_MODELS", async () => {
  const harness = createHarness({
    AGY_ALLOWED_MODELS: "gemini-pro-orchestrator-neon,gemini-4-neon-xhigh,gemini-4-hydrogen-xhigh,gemini-4-argon-low",
  });
  const ctx = asAppContext(harness);
  try {
    const msg = textUpdate(777, "").message!;

    await handleCommand(ctx, msg, "/model", ["orchestrator"]);
    assert.equal(settingsFor(ctx, 777).model, "gemini-pro-orchestrator-neon");
    assert.match(harness.telegram.sentTexts().at(-1)!, /Orchestrator Configuration/);

    await handleCommand(ctx, msg, "/orchestrator", ["planner", "gemini-4-neon-xhigh"]);
    assert.equal(settingsFor(ctx, 777).orchestratorPlanner, "gemini-4-neon-xhigh");

    await handleCommand(ctx, msg, "/orchestrator", ["executor", "gemini-4-hydrogen-xhigh"]);
    assert.equal(settingsFor(ctx, 777).orchestratorExecutor, "gemini-4-hydrogen-xhigh");

    // Disallowed executor must be rejected
    await handleCommand(ctx, msg, "/orchestrator", ["executor", "claude-sonnet-5-5-high"]);
    assert.match(harness.telegram.sentTexts().at(-1)!, /Invalid or disallowed executor model/);
    assert.equal(settingsFor(ctx, 777).orchestratorExecutor, "gemini-4-hydrogen-xhigh");

    // Reset via command
    await handleCommand(ctx, msg, "/orchestrator", ["reset"]);
    assert.equal(settingsFor(ctx, 777).orchestratorPlanner, null);
    assert.equal(settingsFor(ctx, 777).orchestratorExecutor, null);
  } finally {
    harness.cleanup();
  }
});
