import assert from "node:assert/strict";
import test from "node:test";
import { AgySttService, WhisperLocalSttService, createSttService } from "../src/stt/stt-service.js";
import type { AppConfig } from "../src/types.js";

function mockConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    telegram: {
      token: "test-token",
      allowedUserIds: ["123"],
      allowedChatIds: ["123"],
      privateOnly: false,
      maxMessageChars: 4000,
      progressMode: "delete",
      verbose: "detailed",
      allowBotUpdate: false,
      autoInterrupt: false,
    },
    agy: {
      bin: "/mock/bin/agy",
      workspace: "/tmp",
      project: "test-project",
      mode: "accept-edits",
      sandbox: false,
      allowSandboxDisable: true,
      model: "gemini-3.8-flash-low",
      effort: "low",
      allowedModels: ["gemini-3.8-flash-low"],
      timeoutMs: 30000,
      maxOutputBytes: 1000000,
      allowDangerouslySkipPermissions: true,
      dbPath: "/tmp/conv.db",
      projectsRoot: "/tmp/projects",
    },
    stt: {
      provider: "agy",
      agyModel: "gemini-3.8-flash-low",
      whisperModel: "base",
      whisperBin: "whisper",
      language: "auto",
      timeoutMs: 10000,
      showTranscript: true,
    },
    queue: { maxSize: 8 },
    stateFile: "/tmp/state.json",
    tempDir: "/tmp",
    logLevel: "info",
    ...overrides,
  };
}

test("createSttService creates AgySttService when provider is 'agy'", () => {
  const config = mockConfig({ stt: { ...mockConfig().stt, provider: "agy" } });
  const service = createSttService(config);
  assert.ok(service instanceof AgySttService);
  assert.equal(service.isAvailable(), true);
});

test("createSttService creates WhisperLocalSttService when provider is 'whisper-local'", () => {
  const config = mockConfig({ stt: { ...mockConfig().stt, provider: "whisper-local" } });
  const service = createSttService(config);
  assert.ok(service instanceof WhisperLocalSttService);
  assert.equal(service.isAvailable(), true);
});

test("createSttService returns null when provider is 'none'", () => {
  const config = mockConfig({ stt: { ...mockConfig().stt, provider: "none" } });
  const service = createSttService(config);
  assert.equal(service, null);
});

test("/stt command shows status and updates session settings", async () => {
  const { asAppContext, createHarness, textUpdate } = await import("./helpers/fixtures.js");
  const { handleCommand } = await import("../src/router/commands.js");
  const { settingsFor } = await import("../src/domain/settings.js");

  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const msg = textUpdate(777, "").message!;
    await handleCommand(ctx, msg, "/stt", []);
    const lastSent = harness.telegram.sentTexts().at(-1);
    assert.match(lastSent!, /Speech-to-Text \(STT\) Settings:/);

    await handleCommand(ctx, msg, "/stt", ["provider", "whisper-local"]);
    assert.equal(settingsFor(ctx, 777).sttProvider, "whisper-local");

    await handleCommand(ctx, msg, "/stt", ["model", "small"]);
    assert.equal(settingsFor(ctx, 777).sttWhisperModel, "small");

    await handleCommand(ctx, msg, "/stt", ["lang", "en"]);
    assert.equal(settingsFor(ctx, 777).sttLang, "en");
  } finally {
    harness.cleanup();
  }
});

test("STT callbacks update provider and model", async () => {
  const { asAppContext, callbackUpdate, createHarness } = await import("./helpers/fixtures.js");
  const { handleCallback } = await import("../src/router/callbacks.js");
  const { settingsFor } = await import("../src/domain/settings.js");

  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCallback(ctx, callbackUpdate("set:stt:provider:whisper-local"));
    assert.equal(settingsFor(ctx, 777).sttProvider, "whisper-local");

    await handleCallback(ctx, callbackUpdate("set:stt:whisper:tiny"));
    assert.equal(settingsFor(ctx, 777).sttWhisperModel, "tiny");

    await handleCallback(ctx, callbackUpdate("menu:stt"));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /Select STT option to configure:/);
  } finally {
    harness.cleanup();
  }
});

