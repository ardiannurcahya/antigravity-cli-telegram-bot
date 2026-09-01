import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { asAppContext, callbackUpdate, createHarness, textUpdate } from "./helpers/fixtures.js";
import { handleCommand } from "../src/router/commands.js";
import { handleCallback } from "../src/router/callbacks.js";
import { handleUpdate } from "../src/router/updates.js";
import { authorizedUser } from "../src/router/auth.js";
import { settingsFor } from "../src/domain/settings.js";
import { ORIGINAL_COMMANDS } from "./helpers/original-commands.js";

test("auth: privateOnly + user/chat allowlist matrix", () => {
  const chatFiltered = createHarness({ TELEGRAM_PRIVATE_ONLY: "false", TELEGRAM_ALLOWED_CHAT_IDS: "-100" });
  try {
    const cfg = chatFiltered.config;
    assert.equal(authorizedUser(cfg, 111, -100, "group"), true, "allowed user + allowed group chat");
    assert.equal(authorizedUser(cfg, 111, 111, "private"), false, "private chat must also be chat-allowlisted");
    assert.equal(authorizedUser(cfg, 999, -100, "group"), false, "unknown user");
    assert.equal(authorizedUser(cfg, undefined, -100, "group"), false, "missing user");
    assert.equal(authorizedUser(cfg, 111, -200, "group"), false, "chat not allowlisted");

    const privateOnly = createHarness({});
    try {
      const pcfg = privateOnly.config;
      assert.equal(authorizedUser(pcfg, 111, 111, "private"), true, "private chat without chat filter");
      assert.equal(authorizedUser(pcfg, 111, -500, "group"), false, "privateOnly rejects groups even without chat filter");
      assert.equal(authorizedUser(pcfg, 111, undefined, undefined), false, "missing chat type rejected under privateOnly");
    } finally {
      privateOnly.cleanup();
    }
  } finally {
    chatFiltered.cleanup();
  }
});

test("/start and /menu render the main panel with exact copy", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCommand(ctx, textUpdate(777, "").message!, "/start", []);
    const texts = harness.telegram.sentTexts();
    assert.equal(texts.length, 2);
    assert.match(texts[0], /^AGY Telegram\n\nModel: AGY default\nEffort: high\nMode: plan\nVerbose: detailed\n/);
    assert.equal(texts[1], "Model and mode controls are ready.");
    assert.equal(harness.telegram.lastPayload("sendMessage")?.text, texts[1]);
  } finally {
    harness.cleanup();
  }
});

test("/new resets the session and emits the golden session banner", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await ctx.state.setSession(777, { conversationId: "old-conv" } as never);
    await handleCommand(ctx, textUpdate(777, "").message!, "/new", []);
    assert.equal(await ctx.state.session(777), null);
    const html = String(harness.telegram.lastPayload("sendMessage")?.text);
    const expected = [
      "✨ <b>New AGY conversation started.</b>\n",
      "• <b>Model:</b> <code>AGY default</code>",
      "• <b>Effort:</b> <code>high</code>",
      "• <b>Mode:</b> <code>plan</code>",
      "• <b>Verbose:</b> <code>detailed</code>",
      "• <b>Context Limit:</b> <code>1,000,000 tokens</code>",
      "• <b>Sandbox:</b> <code>Disabled</code>",
    ].join("\n");
    assert.equal(html, expected);
    assert.equal(harness.telegram.lastPayload("sendMessage")?.parse_mode, "HTML");
  } finally {
    harness.cleanup();
  }
});

test("settings commands persist values and reply with exact copy", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCommand(ctx, textUpdate(777, "").message!, "/effort", ["medium"]);
    assert.equal(ctx.state.session(777)?.settings?.effort, "medium");
    assert.equal(harness.telegram.sentTexts().at(-1), "Effort set to medium.");

    await handleCommand(ctx, textUpdate(777, "").message!, "/effort", ["ultra"]);
    assert.equal(harness.telegram.sentTexts().at(-1), "Invalid effort: ultra. Choose: low, medium, high.");

    await handleCommand(ctx, textUpdate(777, "").message!, "/mode", []);
    assert.equal(harness.telegram.sentTexts().at(-1), "Select execution mode:");

    await handleCommand(ctx, textUpdate(777, "").message!, "/agent", ["clear"]);
    assert.equal(ctx.state.session(777)?.settings?.agent, null);
    assert.equal(harness.telegram.sentTexts().at(-1), "Agent set to: default.");

    await handleCommand(ctx, textUpdate(777, "").message!, "/add-dir", ["/tmp/a"]);
    await handleCommand(ctx, textUpdate(777, "").message!, "/add-dir", ["/tmp/a"]);
    assert.deepEqual(ctx.state.session(777)?.settings?.addDirs, ["/tmp/a"]);
    await handleCommand(ctx, textUpdate(777, "").message!, "/add-dir", ["clear"]);
    assert.deepEqual(ctx.state.session(777)?.settings?.addDirs, []);

    await handleCommand(ctx, textUpdate(777, "").message!, "/output-format", ["xml"]);
    assert.equal(harness.telegram.sentTexts().at(-1), "Invalid format. Choose: text, json, stream-json.");

    await handleCommand(ctx, textUpdate(777, "").message!, "/json-schema", ['{"type":"object"}']);
    assert.equal(ctx.state.session(777)?.settings?.jsonSchema, '{"type":"object"}');
    await handleCommand(ctx, textUpdate(777, "").message!, "/print-timeout", ["10m"]);
    assert.equal(ctx.state.session(777)?.settings?.printTimeout, "10m");
    await handleCommand(ctx, textUpdate(777, "").message!, "/continue", ["on"]);
    assert.equal(ctx.state.session(777)?.settings?.continueSession, true);
    await handleCommand(ctx, textUpdate(777, "").message!, "/new-project", ["off"]);
    assert.equal(ctx.state.session(777)?.settings?.newProject, false);
    await handleCommand(ctx, textUpdate(777, "").message!, "/log-file", ["/var/log/x"]);
    assert.equal(ctx.state.session(777)?.settings?.logFile, "/var/log/x");
  } finally {
    harness.cleanup();
  }
});

test("sandbox lock honours server policy", async () => {
  const locked = createHarness({ AGY_SANDBOX: "true", AGY_ALLOW_SANDBOX_DISABLE: "false" });
  try {
    const ctx = asAppContext(locked);
    await handleCommand(ctx, textUpdate(777, "").message!, "/sandbox", ["off"]);
    assert.equal(locked.telegram.sentTexts().at(-1), "Sandbox disabling is locked by server configuration.");
    assert.equal(ctx.state.session(777), null, "locked attempt must not persist settings");
    assert.equal(settingsFor(ctx, 777).sandbox, true, "forced sandbox default still applies");

    const open = createHarness({});
    try {
      const octx = asAppContext(open);
      await handleCommand(octx, textUpdate(777, "").message!, "/sandbox", ["on"]);
      assert.equal(octx.state.session(777)?.settings?.sandbox, true);
      assert.equal(open.telegram.sentTexts().at(-1), "Sandbox enabled.");
    } finally {
      open.cleanup();
    }
  } finally {
    locked.cleanup();
  }
});

test("status, tokens, and session readouts keep their golden copy", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCommand(ctx, textUpdate(777, "").message!, "/status", []);
    assert.equal(harness.telegram.sentTexts().at(-1), "Status: idle\nQueued for this chat: 0\nTotal queued: 0");

    await handleCommand(ctx, textUpdate(777, "").message!, "/tokens", []);
    assert.equal(
      harness.telegram.sentTexts().at(-1),
      "Usage / Quota\n\nLast run: no completed run yet.\n\nAccumulated usage:\nUsage data was not provided by AGY.\n\nSubscription quota is not exposed by AGY stream-json."
    );

    await handleCommand(ctx, textUpdate(777, "").message!, "/session", []);
    assert.match(harness.telegram.sentTexts().at(-1)!, /^Session\n\nActive: new\nConversation: new\n/);
    assert.match(harness.telegram.sentTexts().at(-1)!, /Status: idle$/);
  } finally {
    harness.cleanup();
  }
});

test("unknown commands are rejected with the canonical hint", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const handled = await handleCommand(ctx, textUpdate(777, "").message!, "/definitely-not-a-command", []);
    assert.equal(handled, false);
    await handleUpdate(ctx, textUpdate(777, "/definitely-not-a-command"));
    assert.equal(harness.telegram.sentTexts().at(-1), "Unknown command. Use /menu.");
  } finally {
    harness.cleanup();
  }
});

test("parity: every command literal of the original index.ts is still handled", async () => {
  const harness = createHarness({ ALLOW_BOT_UPDATE: "false" });
  const ctx = asAppContext(harness);
  try {
    for (const command of ORIGINAL_COMMANDS) {
      const handled = await handleCommand(ctx, textUpdate(900, "").message!, command, []);
      assert.equal(handled, true, `command ${command} must be handled`);
    }
  } finally {
    harness.cleanup();
  }
});

test("callbacks: authorization gate blocks unknown users before answering", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCallback(ctx, callbackUpdate("action:new", 777, 42, 424242));
    harness.telegram.assertNeverCalled("answerCallbackQuery");
  } finally {
    harness.cleanup();
  }
});

test("callbacks: set:model persists model+effort and offers permanent default", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCallback(ctx, callbackUpdate("set:model:gemini-3.7-flash-medium"));
    const settings = ctx.state.session(777)?.settings;
    assert.equal(settings?.model, "gemini-3.7-flash-medium");
    assert.equal(settings?.effort, "medium");
    const edit = harness.telegram.lastPayload("editMessageText");
    assert.equal(edit?.text, "Model set to <b>Gemini 3.7 Flash (Medium)</b>.\n\nWould you like to set this as your permanent default?");
    assert.deepEqual(JSON.parse(JSON.stringify((edit?.reply_markup as { inline_keyboard: string[][] }).inline_keyboard)), [
      [{ text: "⭐ Yes, set as Default", callback_data: "action:setdefault" }, { text: "👌 Only this session", callback_data: "menu:main" }],
    ]);
    assert.equal(harness.telegram.sentTexts().at(-1), "Controls updated.");

    await handleCallback(ctx, callbackUpdate("set:model:not-a-real-model", 777, 43));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /^AGY Telegram\n/);
  } finally {
    harness.cleanup();
  }
});

test("callbacks: toggle, action:new, action:cancel, resume validation, menu routing", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCallback(ctx, callbackUpdate("noop"));
    harness.telegram.assertNeverCalled("editMessageText");

    await handleCallback(ctx, callbackUpdate("toggle:continue"));
    assert.equal(ctx.state.session(777)?.settings?.continueSession, true);
    assert.equal(harness.telegram.editedTexts().at(-1), "CLI options updated.");

    await handleCallback(ctx, callbackUpdate("toggle:new-project"));
    assert.equal(ctx.state.session(777)?.settings?.newProject, true);

    await handleCallback(ctx, callbackUpdate("action:new"));
    assert.equal(ctx.state.session(777)?.conversationId, undefined);
    assert.equal(ctx.state.session(777)?.settings?.continueSession, false);
    assert.equal(ctx.state.session(777)?.settings?.newProject, false);
    assert.match(String(harness.telegram.editedTexts().at(-1)), /^✨ <b>New AGY conversation started\.<\/b>/);
    assert.equal(harness.telegram.sentTexts().at(-1), "Controls ready.");

    await handleCallback(ctx, callbackUpdate("action:cancel"));
    assert.equal(harness.telegram.editedTexts().at(-1), "Cancelled: 0 queued, active=no.");

    await handleCallback(ctx, callbackUpdate("resume:use:not-a-uuid"));
    assert.equal(harness.telegram.editedTexts().at(-1), "Selected conversation ID is not a valid UUID.");

    await handleCallback(ctx, callbackUpdate("resume:use:f47ac10b-58cc-4372-a567-0e02b2c3d479"));
    assert.equal(harness.telegram.editedTexts().at(-1), "Selected conversation was not found or is invalid.");

    await handleCallback(ctx, callbackUpdate("menu:models"));
    assert.equal(harness.telegram.editedTexts().at(-1), "Select a model:");

    await handleCallback(ctx, callbackUpdate("menu:sandbox"));
    assert.equal(harness.telegram.editedTexts().at(-1), "Sandbox is disabled.");

    await handleCallback(ctx, callbackUpdate("set:verbose:silent"));
    assert.equal(ctx.state.session(777)?.settings?.verbose, "silent");
    assert.equal(harness.telegram.editedTexts().at(-1), "Verbose level set to silent.");

    await handleCallback(ctx, callbackUpdate("set:output:text"));
    assert.equal(ctx.state.session(777)?.settings?.outputFormat, "text");
    assert.equal(harness.telegram.editedTexts().at(-1), "Output format updated.");
  } finally {
    harness.cleanup();
  }
});

test("callbacks: cli:update routes to the dangerous-command confirmation flow", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCallback(ctx, callbackUpdate("cli:update"));
    assert.deepEqual(harness.pendingDangerousCommands.get("777"), ["update"]);
    assert.match(String(harness.telegram.sentTexts().at(-1)), /^This command can change the AGY installation/);

    await handleCallback(ctx, callbackUpdate("cli:version"));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /^Running agy --version\.\.\./);

    await handleCallback(ctx, callbackUpdate("cli:add-dir"));
    assert.match(String(harness.telegram.editedTexts().at(-1)), /^Use this custom command:\n\n\/agy --add-dir \/path/);
  } finally {
    harness.cleanup();
  }
});

test("handleUpdate queues plain prompts through the job pipeline", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(777, "Hello world, do the thing"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 1);
    assert.equal(harness.capturedJobs[0].prompt, "Hello world, do the thing");
    assert.equal(harness.capturedJobs[0].kind, "prompt");
  } finally {
    harness.cleanup();
  }
});

test("autoInterrupt merges follow-ups into the running prompt and cancels predecessors", async () => {
  const harness = createHarness({ TELEGRAM_AUTO_INTERRUPT: "true" });
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(777, "first task"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(harness.queue.statusForChat(777).active, "first job must be active");

    await handleUpdate(ctx, textUpdate(777, "second task"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(harness.capturedJobs.length, 2);
    assert.equal(harness.capturedJobs[1].prompt, "first task\n\n[Update / Follow-up]: second task");
  } finally {
    harness.cleanup();
  }
});

test("queue feedback: position announcements and queue-full notice", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(777, "job one"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await handleUpdate(ctx, textUpdate(777, "job two"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await handleUpdate(ctx, textUpdate(777, "job three"));
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    assert.ok(harness.telegram.sentTexts().includes("⏳ Queued at position #2."), "second pending job announces position #2");

    const tiny = createHarness({ MAX_QUEUE_SIZE: "1" });
    try {
      const tctx = asAppContext(tiny);
      await handleUpdate(tctx, textUpdate(555, "job one"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await handleUpdate(tctx, textUpdate(555, "job two"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await handleUpdate(tctx, textUpdate(555, "job three"));
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      assert.equal(tiny.telegram.sentTexts().at(-1), "Queue is full. Try again shortly.");
    } finally {
      tiny.cleanup();
    }
  } finally {
    harness.cleanup();
  }
});

test("/cancel and /stop abort in-flight controllers and clear pending dangerous commands", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const controller = new AbortController();
    ctx.controllers.set(`custom:${777}`, controller);
    ctx.pendingDangerousCommands.set("777", ["update"]);

    await handleCommand(ctx, textUpdate(777, "").message!, "/stop", []);

    assert.equal(controller.signal.aborted, true);
    assert.equal(ctx.pendingDangerousCommands.has("777"), false);
    assert.equal(harness.telegram.sentTexts().at(-1), "⛔ Cancelled: 0 queued job(s) removed, active AGY process terminated.");

    const promptController = new AbortController();
    ctx.controllers.set(`prompt:${777}`, promptController);
    await handleUpdate(ctx, textUpdate(777, "🛑 Stop"));
    assert.equal(promptController.signal.aborted, true);
    assert.equal(harness.telegram.sentTexts().at(-1), "⛔ Cancelled: 0 queued job(s) removed, active AGY process terminated.");
  } finally {
    harness.cleanup();
  }
});

test("dangerous /agy requires confirmation before executing", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, textUpdate(777, '/agy plugin install something'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.pendingDangerousCommands.get("777"), ["plugin", "install", "something"]);
    assert.match(harness.telegram.sentTexts()[0] ?? "", /^This command can change the AGY installation/);

    // Read-only plugin listing executes immediately (AGY_BIN is stubbed with /bin/echo)
    await handleUpdate(ctx, textUpdate(777, "/agy plugin list"));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const texts = harness.telegram.sentTexts();
    const runningIdx = texts.findIndex((t) => t === "Running agy plugin list...");
    assert.ok(runningIdx >= 0, "running notice must be sent");
    assert.equal(texts[runningIdx + 1], "AGY command result\n\nplugin list");
  } finally {
    harness.cleanup();
  }
});

test("attachment download failure replies with the canonical error", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    harness.telegram.failNext("getFile", new Error("bad file id"));
    await handleUpdate(ctx, {
      update_id: 1,
      message: {
        message_id: 5,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        photo: [{ file_id: "f1", file_unique_id: "u1", width: 1, height: 1 }],
      },
    });
    const last = harness.telegram.sentTexts().at(-1)!;
    assert.match(last, /^Failed to download attachment: bad file id$/);
  } finally {
    harness.cleanup();
  }
});

test("photo messages download then flow into the prompt queue with imagePath", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    harness.telegram.registerFile("f1", "photos/f1.jpg");
    await handleUpdate(ctx, {
      update_id: 2,
      message: {
        message_id: 6,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        caption: "what is this?",
        photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10 }],
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 1);
    assert.equal(harness.capturedJobs[0].prompt, "what is this?");
    assert.match(harness.capturedJobs[0].imagePath ?? "", /photo_\d+_f1\.jpg$/);
    assert.ok(fs.existsSync(harness.capturedJobs[0].imagePath!));
  } finally {
    harness.cleanup();
  }
});

test("voice messages download then flow into the prompt queue with mediaPath and metadata header", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    harness.telegram.registerFile("voice-id-1", "voice/voice.oga");
    await handleUpdate(ctx, {
      update_id: 3,
      message: {
        message_id: 7,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        voice: { file_id: "voice-id-1", duration: 15, mime_type: "audio/ogg" },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 1);
    assert.equal(harness.capturedJobs[0].mediaType, "Voice message");
    assert.match(harness.capturedJobs[0].mediaPath ?? "", /voice_\d+_ice-id-1\.ogg$/);
    assert.match(harness.capturedJobs[0].prompt ?? "", /^\[Voice message attached: .*\/voice_.*\.ogg \| Duration: 15s\]$/);
    assert.ok(fs.existsSync(harness.capturedJobs[0].mediaPath!));
  } finally {
    harness.cleanup();
  }
});

test("audio messages download with title and performer into workspace uploads", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    harness.telegram.registerFile("audio-id-1", "music/song.mp3");
    await handleUpdate(ctx, {
      update_id: 4,
      message: {
        message_id: 8,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        caption: "Analyze this track",
        audio: { file_id: "audio-id-1", duration: 180, title: "Bohemian Rhapsody", performer: "Queen", file_name: "queen.mp3" },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 1);
    assert.equal(harness.capturedJobs[0].mediaType, "Audio");
    assert.equal(harness.capturedJobs[0].documentName, "queen.mp3");
    assert.match(harness.capturedJobs[0].prompt ?? "", /^\[Audio attached: .*queen\.mp3 \| Title: Bohemian Rhapsody \| Artist: Queen \| Duration: 180s\]\n\nAnalyze this track$/);
    assert.ok(fs.existsSync(harness.capturedJobs[0].mediaPath!));
  } finally {
    harness.cleanup();
  }
});

test("video and video note messages download and preserve metadata", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    harness.telegram.registerFile("vid-1", "video/clip.mp4");
    await handleUpdate(ctx, {
      update_id: 5,
      message: {
        message_id: 9,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        video: { file_id: "vid-1", width: 1920, height: 1080, duration: 45, file_name: "vacation.mp4" },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 1);
    assert.equal(harness.capturedJobs[0].mediaType, "Video");
    assert.match(harness.capturedJobs[0].prompt ?? "", /\[Video attached: .*vacation\.mp4 \| Resolution: 1920x1080 \| Duration: 45s\]/);

    harness.capturedJobs[0].resolve();

    harness.telegram.registerFile("vnote-1", "video/round.mp4");
    await handleUpdate(ctx, {
      update_id: 6,
      message: {
        message_id: 10,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        video_note: { file_id: "vnote-1", length: 360, duration: 8 },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 2);
    assert.equal(harness.capturedJobs[1].mediaType, "Video note");
    assert.match(harness.capturedJobs[1].prompt ?? "", /\[Video note attached: .*vnote_.*\.mp4 \| Duration: 8s\]/);
  } finally {
    harness.cleanup();
  }
});

test("location, venue, and contact messages synthesize rich context into prompt", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleUpdate(ctx, {
      update_id: 7,
      message: {
        message_id: 11,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        location: { latitude: 47.3769, longitude: 8.5417, horizontal_accuracy: 10 },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 1);
    assert.match(harness.capturedJobs[0].prompt ?? "", /\[Location shared: Coordinates 47\.3769, 8\.5417 \| Accuracy: 10m\]/);

    harness.capturedJobs[0].resolve();

    await handleUpdate(ctx, {
      update_id: 8,
      message: {
        message_id: 12,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        venue: {
          location: { latitude: 47.378, longitude: 8.54 },
          title: "Zurich HB",
          address: "Bahnhofplatz 1, 8001 Zurich",
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 2);
    assert.match(harness.capturedJobs[1].prompt ?? "", /\[Location shared: "Zurich HB", Bahnhofplatz 1, 8001 Zurich \(Coordinates: 47\.378, 8\.54\)\]/);

    harness.capturedJobs[1].resolve();

    await handleUpdate(ctx, {
      update_id: 9,
      message: {
        message_id: 13,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        contact: {
          phone_number: "+41791234567",
          first_name: "Stephan",
          last_name: "Bolten",
          vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Stephan Bolten\nTEL:+41791234567\nEND:VCARD",
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 3);
    assert.match(harness.capturedJobs[2].prompt ?? "", /\[Contact shared: Stephan Bolten \(\+41791234567\) \| vCard saved: .*contact_.*\.vcf\]/);
  } finally {
    harness.cleanup();
  }
});

test("uncompressed image documents flow into the prompt queue with imagePath", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    harness.telegram.registerFile("doc_img_1", "documents/screenshot.png");
    await handleUpdate(ctx, {
      update_id: 10,
      message: {
        message_id: 14,
        chat: { id: 777, type: "private" },
        from: { id: 111 },
        caption: "check this uncompressed screenshot",
        document: {
          file_id: "doc_img_1",
          file_name: "screenshot.png",
          mime_type: "image/png",
          file_size: 2048,
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.capturedJobs.length, 1);
    assert.equal(harness.capturedJobs[0].prompt, "check this uncompressed screenshot");
    assert.match(harness.capturedJobs[0].imagePath ?? "", /\.png$/);
    assert.ok(fs.existsSync(harness.capturedJobs[0].imagePath!));
  } finally {
    harness.cleanup();
  }
});

test("/new command purges session temp images and files", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    const sessionDir = path.join(ctx.config.tempDir, "chat_777");
    await fs.promises.mkdir(sessionDir, { recursive: true });
    await fs.promises.writeFile(path.join(sessionDir, "photo_temp.jpg"), "data");

    await handleCommand(ctx, textUpdate(777, "").message!, "/new", []);
    const exists = await fs.promises.stat(sessionDir).catch(() => null);
    assert.equal(exists, null);
  } finally {
    harness.cleanup();
  }
});

test("bot self-update and restart stay disabled unless explicitly allowed", async () => {
  const harness = createHarness({ ALLOW_BOT_UPDATE: "false" });
  const ctx = asAppContext(harness);
  try {
    for (const cmd of ["/update", "/restart"]) {
      await handleCommand(ctx, textUpdate(777, "").message!, cmd, []);
    }
    const texts = harness.telegram.sentTexts();
    assert.equal(texts.at(-2), "⚠️ <b>Bot updates via Telegram are disabled.</b>\n\nTo enable remote updates, set <code>ALLOW_BOT_UPDATE=true</code> in your environment.");
    assert.equal(texts.at(-1), "⚠️ Bot restart via Telegram is disabled.\n\nTo enable, set ALLOW_BOT_UPDATE=true in your environment.");
  } finally {
    harness.cleanup();
  }
});

test("/help streams CLI help through a fresh loading message", async () => {
  const harness = createHarness();
  const ctx = asAppContext(harness);
  try {
    await handleCommand(ctx, textUpdate(777, "").message!, "/help", []);
    const texts = harness.telegram.sentTexts();
    assert.match(texts[0], /^AGY Telegram\n/);
    assert.equal(texts[1], "Model and mode controls are ready.");
    assert.equal(texts[2], "Loading AGY CLI help...");
    assert.equal(harness.telegram.editedTexts().at(-1), "Running agy --help...");
  } finally {
    harness.cleanup();
  }
});

test("createAppServices wires queue cancellation to controller abortion", async () => {
  const harness = createHarness();
  try {
    const { loadConfig } = await import("../src/config.js");
    const { StateStore } = await import("../src/state.js");
    const { ConversationDatabase } = await import("../src/db.js");
    const { createAppServices } = await import("../src/bot.js");
    fs.mkdirSync(path.join(path.dirname(harness.config.stateFile)), { recursive: true });
    const state = new StateStore(harness.config.stateFile);
    await state.load();
    const services = createAppServices({
      config: harness.config,
      state,
      convDb: new ConversationDatabase(harness.config.agy.dbPath),
      telegram: harness.telegram as unknown as import("../src/telegram.js").TelegramClient,
    });
    const promptController = new AbortController();
    const customController = new AbortController();
    services.controllers.set("prompt:42", promptController);
    services.controllers.set("custom:42", customController);

    services.queue.cancelForChat(42);

    assert.equal(promptController.signal.aborted, true, "prompt controller must abort on cancelForChat");
    assert.equal(customController.signal.aborted, true, "custom controller must abort on cancelForChat");

    const other = new AbortController();
    services.controllers.set("prompt:43", other);
    services.queue.cancelForChat(999);
    assert.equal(other.signal.aborted, false);
  } finally {
    harness.cleanup();
  }
});
