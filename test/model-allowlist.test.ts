import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { getAvailableModels, isModelAllowed } from "../src/domain/settings.js";
import { modelKeyboard } from "../src/ui/inline-keyboards.js";
import type { AppContext } from "../src/context.js";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_ALLOWED_USER_IDS: "123",
};

function makeContext(configOverrides: Partial<ReturnType<typeof loadConfig>["agy"]> = {}): AppContext {
  const config = loadConfig(baseEnv);
  config.agy = { ...config.agy, ...configOverrides };
  return {
    config,
    state: {
      session: () => undefined,
    },
  } as unknown as AppContext;
}

test("isModelAllowed enforces explicit AGY_ALLOWED_MODELS allowlist", () => {
  const config = loadConfig({
    ...baseEnv,
    AGY_ALLOWED_MODELS: "gemini-3.8-flash-low",
  });
  const context = { config } as Pick<AppContext, "config">;

  assert.equal(isModelAllowed(context, "gemini-3.8-flash-low"), true);
  assert.equal(isModelAllowed(context, "gemini-3.7-flash-high"), false);
  assert.equal(isModelAllowed(context, "claude-sonnet-4-6"), false);
});

test("isModelAllowed keeps default active models allowed when AGY_ALLOWED_MODELS is unset", () => {
  const config = loadConfig(baseEnv);
  const context = { config } as Pick<AppContext, "config">;

  assert.equal(config.agy.allowedModelsExplicit, false);
  assert.equal(isModelAllowed(context, "gemini-3.7-flash-high"), true);
  assert.equal(isModelAllowed(context, "claude-sonnet-4-6"), true);
});

test("modelKeyboard includes configured custom models and filters by allowlist", () => {
  const customCtx = makeContext({
    model: "gemini-4-custom-preview",
    allowedModels: ["gemini-4-custom-preview", "gemini-3.8-flash-low"],
    allowedModelsExplicit: true,
  });

  const available = getAvailableModels(customCtx, 123);
  assert.deepEqual(available.map((m) => m.id), ["gemini-4-custom-preview", "gemini-3.8-flash-low"]);

  const keyboard = modelKeyboard(customCtx, 123, 0);
  const buttonCallbacks = keyboard.inline_keyboard.flat().map((btn) => btn.callback_data);
  assert.ok(buttonCallbacks.includes("set:model:gemini-4-custom-preview"));
  assert.ok(buttonCallbacks.includes("set:model:gemini-3.8-flash-low"));
  assert.ok(!buttonCallbacks.includes("set:model:claude-sonnet-4-6"));
});
