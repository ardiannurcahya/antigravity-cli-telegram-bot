import assert from "node:assert/strict";
import test from "node:test";
import { AgySttService, GeminiSttService, WhisperLocalSttService, createSttService } from "../src/stt/stt-service.js";
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

    await handleCommand(ctx, msg, "/stt", ["provider", "gemini"]);
    assert.equal(settingsFor(ctx, 777).sttProvider, "gemini");

    await handleCommand(ctx, msg, "/stt", ["model", "gemini-1.5-pro"]);
    assert.equal(settingsFor(ctx, 777).sttGeminiModel, "gemini-1.5-pro");

    await handleCommand(ctx, msg, "/stt", ["lang", "en"]);
    assert.equal(settingsFor(ctx, 777).sttLang, "en");
  } finally {
    harness.cleanup();
  }
});

test("createSttService creates GeminiSttService with custom geminiModel when provider is 'gemini'", () => {
  const config = mockConfig({
    stt: {
      ...mockConfig().stt,
      provider: "gemini",
      geminiApiKey: "fake-key",
      geminiModel: "gemini-2.5-flash",
    },
  });
  const service = createSttService(config, { sttGeminiModel: "gemini-1.5-pro" } as any);
  assert.ok(service instanceof GeminiSttService);
  assert.equal(service.isAvailable(), true);
  assert.equal((service as any).config.stt.geminiModel, "gemini-1.5-pro");
});

test("sttKeyboard only includes Whisper model button when provider is whisper-local", async () => {
  const { asAppContext, createHarness } = await import("./helpers/fixtures.js");
  const { sttKeyboard } = await import("../src/ui/inline-keyboards.js");
  const { saveSettings, settingsFor } = await import("../src/domain/settings.js");

  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const s1 = settingsFor(ctx, 777);
    s1.sttProvider = "whisper-local";
    await saveSettings(ctx, 777, s1);
    const kbWhisper = sttKeyboard(ctx, 777);
    const hasWhisperButton = kbWhisper.inline_keyboard.some((row) =>
      row.some((btn) => btn.callback_data === "menu:stt:whisper")
    );
    assert.equal(hasWhisperButton, true);

    const s2 = settingsFor(ctx, 777);
    s2.sttProvider = "gemini";
    await saveSettings(ctx, 777, s2);
    const kbGemini = sttKeyboard(ctx, 777);
    const hasWhisperButtonGemini = kbGemini.inline_keyboard.some((row) =>
      row.some((btn) => btn.callback_data === "menu:stt:whisper")
    );
    assert.equal(hasWhisperButtonGemini, false);

    const s3 = settingsFor(ctx, 777);
    s3.sttProvider = "agy";
    await saveSettings(ctx, 777, s3);
    const kbAgy = sttKeyboard(ctx, 777);
    const hasWhisperButtonAgy = kbAgy.inline_keyboard.some((row) =>
      row.some((btn) => btn.callback_data === "menu:stt:whisper")
    );
    assert.equal(hasWhisperButtonAgy, false);

    const s4 = settingsFor(ctx, 777);
    s4.sttProvider = "none";
    await saveSettings(ctx, 777, s4);
    const kbNone = sttKeyboard(ctx, 777);
    assert.equal(kbNone.inline_keyboard.length, 2); // Provider + Back
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
    await handleCallback(ctx, callbackUpdate("set:stt:provider:gemini"));
    assert.equal(settingsFor(ctx, 777).sttProvider, "gemini");

    await handleCallback(ctx, callbackUpdate("set:stt:provider:whisper-local"));
    assert.equal(settingsFor(ctx, 777).sttProvider, "whisper-local");
    const lastEdited = String(harness.telegram.editedTexts().at(-1));
    assert.match(lastEdited, /STT provider set to <b>whisper-local<\/b>/);
    // If whisper is not installed, a warning note is appended
    assert.match(lastEdited, /⚠️/);

    await handleCallback(ctx, callbackUpdate("set:stt:whisper:tiny"));
    assert.equal(settingsFor(ctx, 777).sttWhisperModel, "tiny");

    await handleCallback(ctx, callbackUpdate("menu:stt"));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /Select STT option to configure:/);
  } finally {
    harness.cleanup();
  }
});

test("handleUpdate notifies user if whisper-local is configured but whisper binary is missing", async () => {
  const { asAppContext, createHarness } = await import("./helpers/fixtures.js");
  const { handleUpdate } = await import("../src/router/updates.js");
  const { saveSettings, settingsFor } = await import("../src/domain/settings.js");

  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const s = settingsFor(ctx, 777);
    s.sttProvider = "whisper-local";
    await saveSettings(ctx, 777, s);

    // Mock voice message update from authorized user (111)
    const update = {
      update_id: 12345,
      message: {
        message_id: 99,
        chat: { id: 777, type: "private" },
        from: { id: 111, is_bot: false, first_name: "Tester" },
        date: Math.floor(Date.now() / 1000),
        voice: {
          file_id: "voice-file-id",
          duration: 3,
          mime_type: "audio/ogg",
        },
      },
    };

    // Mock getFile and downloadFile
    harness.telegram.getFile = async () => ({ file_id: "voice-file-id", file_path: "voice/file.oga" });
    harness.telegram.downloadFile = async (_filePath: string, dest: string) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from("dummy-audio-content"));
      return dest;
    };

    await handleUpdate(ctx, update as any);

    const sent = harness.telegram.sentTexts();
    const hasWhisperWarning = sent.some((txt) =>
      txt.includes("Whisper nicht verfügbar") || txt.includes("Whisper nicht gefunden")
    );
    assert.equal(hasWhisperWarning, true, "User must receive a warning that whisper is not installed");
  } finally {
    harness.cleanup();
  }
});

