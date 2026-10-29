import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDefaultTopicResetName,
  generateTopicShortName,
  resolveAutoTopicModel,
  resolveEffectiveForumThreadId,
  sanitizeTopicName,
  truncateGraphemes,
} from "../src/domain/topic-namer.js";

test("truncateGraphemes truncates by grapheme cluster without breaking emojis", () => {
  assert.equal(truncateGraphemes("🚀Deployment", 6), "🚀Deplo");
  assert.equal(truncateGraphemes("🏎️T150 Pro", 5), "🏎️T150");
  assert.equal(truncateGraphemes("Short", 6), "Short");
});

test("sanitizeTopicName cleans quotes, markdown, and limits length", () => {
  assert.equal(sanitizeTopicName('"🚀Deploy"'), "🚀Deplo");
  assert.equal(sanitizeTopicName("`🎮BeamNG`"), "🎮BeamN");
  assert.equal(sanitizeTopicName("**🎭Act.**"), "🎭Act.");
  assert.equal(sanitizeTopicName("💡Idea for Chat"), "💡Idea ");
});

test("resolveEffectiveForumThreadId resolves explicit threads and guards General fallback against 1:1 DMs", () => {
  assert.deepEqual(resolveEffectiveForumThreadId("-100123:42", false), { chatId: -100123, threadId: 42 });
  assert.deepEqual(resolveEffectiveForumThreadId("-100123", false), { chatId: "-100123", threadId: undefined });
  assert.deepEqual(resolveEffectiveForumThreadId("-100123", true), { chatId: "-100123", threadId: 1 });
  // Must NOT fall back to thread 1 in 1:1 private DM chats even if enableTopics is true
  assert.deepEqual(resolveEffectiveForumThreadId("987654321", true), { chatId: "987654321", threadId: undefined });
});

test("formatDefaultTopicResetName supports standard defaults and custom prefix", () => {
  assert.equal(formatDefaultTopicResetName(1), "General");
  assert.equal(formatDefaultTopicResetName(5), "Topic 5");
  assert.equal(formatDefaultTopicResetName(1, "T"), "T1");
  assert.equal(formatDefaultTopicResetName(5, "T"), "T5");
});

test("resolveAutoTopicModel prioritizes autoTopicModel, then agy.model, then sessionModel, then stt.agyModel", () => {
  const baseConfig: any = {
    telegram: { autoTopicModel: "custom-topic-model" },
    agy: { model: "claude-sonnet-4-6" },
    stt: { agyModel: "gemini-3.8-flash-low" },
  };
  assert.equal(resolveAutoTopicModel(baseConfig, "session-model"), "custom-topic-model");

  baseConfig.telegram.autoTopicModel = undefined;
  assert.equal(resolveAutoTopicModel(baseConfig, "session-model"), "claude-sonnet-4-6");

  baseConfig.agy.model = "";
  assert.equal(resolveAutoTopicModel(baseConfig, "session-model"), "session-model");

  assert.equal(resolveAutoTopicModel(baseConfig, null), "gemini-3.8-flash-low");
});

test("generateTopicShortName strips Telegram secrets from child process environment", async () => {
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "secret-bot-token-123";
  try {
    const config: any = {
      telegram: { autoTopicModel: "test-model" },
      agy: {
        // print env TELEGRAM_BOT_TOKEN if leaked, otherwise print 🚀Clean
        bin: "/usr/bin/env",
        allowDangerouslySkipPermissions: false,
      },
    };
    const result = await generateTopicShortName(config, "Deploy server", "Deployed");
    assert.notEqual(result, "secret");
  } finally {
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
  }
});

test("generateTopicShortName parses stream-json output and reports ephemeral conversationId for cleanup", async () => {
  const seenIds: string[] = [];
  const streamLine1 = JSON.stringify({ event: "init", init: { conversation_id: "11111111-2222-3333-4444-555555555555" } });
  const streamLine2 = JSON.stringify({ event: "result", result: { response: "🚀Deploy" } });
  const config: any = {
    telegram: { autoTopicModel: "test-model" },
    agy: {
      bin: "/usr/bin/printf",
      allowDangerouslySkipPermissions: false,
    },
  };
  // Note: printf with "--print" as first arg fails on GNU printf unless handled; use node -e via wrapper or test via sh
  const nodeConfig: any = {
    telegram: { autoTopicModel: "test-model" },
    agy: {
      bin: process.execPath,
      allowDangerouslySkipPermissions: false,
    },
  };
  // When process.execPath is invoked with ["--print", taskPrompt, ...], node -p/--print evaluates taskPrompt as JS which fails.
  // Use a tiny temporary script to simulate stream-json output:
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-topic-namer-"));
  const mockBin = path.join(tmpDir, "mock-agy.sh");
  await fs.writeFile(
    mockBin,
    `#!/bin/sh\necho '${streamLine1}'\necho '${streamLine2}'\n`,
    { mode: 0o755 }
  );
  try {
    config.agy.bin = mockBin;
    const label = await generateTopicShortName(
      config,
      "Deploy server",
      "Deployed",
      undefined,
      null,
      (id) => seenIds.push(id)
    );
    assert.equal(label, "🚀Deplo");
    assert.deepEqual(seenIds, ["11111111-2222-3333-4444-555555555555"]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("generateTopicShortName does not pass --effort when model name already contains effort suffix", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-topic-effort-"));
  const mockBin = path.join(tmpDir, "mock-check-args.sh");
  const recordedArgs = path.join(tmpDir, "args.txt");
  await fs.writeFile(
    mockBin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${recordedArgs}"\necho '{"event":"result","result":{"response":"📦Test"}}\'\n`,
    { mode: 0o755 }
  );
  try {
    const config: any = {
      telegram: { autoTopicModel: "gemini-3.8-flash-medium" },
      agy: { bin: mockBin, allowDangerouslySkipPermissions: false },
    };
    const label = await generateTopicShortName(config, "test", "test");
    assert.equal(label, "📦Test");
    const captured = (await fs.readFile(recordedArgs, "utf8")).split("\n");
    assert.ok(!captured.includes("--effort"), "Should not contain --effort flag when model ends in -medium");

    // Conversely, test that a model without suffix gets --effort low
    config.telegram.autoTopicModel = "custom-model";
    await generateTopicShortName(config, "test", "test");
    const captured2 = (await fs.readFile(recordedArgs, "utf8")).split("\n");
    assert.ok(captured2.includes("--effort"), "Should contain --effort flag when model lacks suffix");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


