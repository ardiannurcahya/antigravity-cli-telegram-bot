import assert from "node:assert/strict";
import test from "node:test";
import { cleanTextForSpeech, EdgeTtsService, createTtsService } from "../src/tts/tts-service.js";
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
      provider: "none",
      agyModel: "gemini-3.8-flash-low",
      whisperModel: "base",
      whisperBin: "whisper",
      language: "auto",
      timeoutMs: 10000,
      showTranscript: true,
    },
    tts: {
      mode: "auto",
      voice: "de-DE-ConradNeural",
      bin: "edge-tts",
      timeoutMs: 30000,
    },
    queue: { maxSize: 8 },
    stateFile: "/tmp/state.json",
    tempDir: "/tmp",
    logLevel: "info",
    ...overrides,
  };
}

test("cleanTextForSpeech strips markdown code blocks, links, and formatting", () => {
  const input = `
# Überschrift

Hier ist ein einfaches Beispiel:
\`\`\`typescript
const a = 1;
console.log(a);
\`\`\`

Besuche gerne [meine Website](https://example.com/foo/bar?baz=1) für mehr Details!
Das ist **wichtig** und _kursiv_, außerdem \`inline code\`.
`;

  const cleaned = cleanTextForSpeech(input);
  assert.ok(!cleaned.includes("console.log"));
  assert.ok(cleaned.includes("[Codeblock mit 2 Zeilen]"));
  assert.ok(cleaned.includes("meine Website"));
  assert.ok(!cleaned.includes("https://example.com"));
  assert.ok(cleaned.includes("wichtig und kursiv"));
  assert.ok(cleaned.includes("inline code"));
});

test("createTtsService creates EdgeTtsService", () => {
  const config = mockConfig();
  const service = createTtsService(config);
  assert.ok(service instanceof EdgeTtsService);
});

test("/tts command shows status and updates session settings", async () => {
  const { asAppContext, createHarness, textUpdate } = await import("./helpers/fixtures.js");
  const { handleCommand } = await import("../src/router/commands.js");
  const { settingsFor } = await import("../src/domain/settings.js");

  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const msg = textUpdate(777, "").message!;
    await handleCommand(ctx, msg, "/tts", []);
    const lastSent = harness.telegram.sentTexts().at(-1);
    assert.match(lastSent!, /Text-to-Speech \(TTS\) Voice Output Settings:/);

    await handleCommand(ctx, msg, "/tts", ["mode", "voice-and-text"]);
    assert.equal(settingsFor(ctx, 777).ttsMode, "voice-and-text");

    await handleCommand(ctx, msg, "/tts", ["mode", "auto"]);
    assert.equal(settingsFor(ctx, 777).ttsMode, "auto");

    await handleCommand(ctx, msg, "/tts", ["voice", "de-DE-KillianNeural"]);
    assert.equal(settingsFor(ctx, 777).ttsVoice, "de-DE-KillianNeural");
  } finally {
    harness.cleanup();
  }
});

test("TTS callbacks update mode and voice", async () => {
  const { asAppContext, callbackUpdate, createHarness } = await import("./helpers/fixtures.js");
  const { handleCallback } = await import("../src/router/callbacks.js");
  const { settingsFor } = await import("../src/domain/settings.js");

  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCallback(ctx, callbackUpdate("set:tts:mode:voice-only"));
    assert.equal(settingsFor(ctx, 777).ttsMode, "voice-only");

    await handleCallback(ctx, callbackUpdate("set:tts:voice:de-DE-KatjaNeural"));
    assert.equal(settingsFor(ctx, 777).ttsVoice, "de-DE-KatjaNeural");

    await handleCallback(ctx, callbackUpdate("menu:tts"));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /Select TTS option to configure:/);

    await handleCallback(ctx, callbackUpdate("menu:tts:mode"));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /Select TTS response mode:/);

    await handleCallback(ctx, callbackUpdate("menu:tts:voice"));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /Select TTS voice:/);
  } finally {
    harness.cleanup();
  }
});
