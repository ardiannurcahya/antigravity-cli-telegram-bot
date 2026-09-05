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
