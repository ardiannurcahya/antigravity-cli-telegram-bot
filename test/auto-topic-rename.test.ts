import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { handleCallback } from "../src/router/callbacks.js";
import { handleCommand } from "../src/router/commands.js";
import { cliToolsKeyboard, modeSandboxKeyboard } from "../src/ui/inline-keyboards.js";
import { sessionInfoHtml } from "../src/ui/messages.js";
import { resetForumTopicNameIfAutoRenamed } from "../src/usecases/topic-reset.js";

const base = { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "123", AGY_WORKSPACE: "/srv/workspace" };

test("autoTopicRename configuration defaults to false (opt-in)", () => {
  const config = loadConfig(base);
  assert.equal(config.telegram.autoTopicRename, false);
  assert.equal(config.telegram.autoTopicModel, undefined);
  assert.equal(config.telegram.topicResetPrefix, undefined);
});

test("autoTopicRename and optional topic settings can be configured via env", () => {
  const config = loadConfig({
    ...base,
    TELEGRAM_AUTO_TOPIC_RENAME: "1",
    TELEGRAM_AUTO_TOPIC_MODEL: "gemini-3.8-flash-low",
    TELEGRAM_TOPIC_RESET_PREFIX: "T",
  });
  assert.equal(config.telegram.autoTopicRename, true);
  assert.equal(config.telegram.autoTopicModel, "gemini-3.8-flash-low");
  assert.equal(config.telegram.topicResetPrefix, "T");
});

test("resetForumTopicNameIfAutoRenamed calls editForumTopic with upstream defaults or custom prefix", async () => {
  let editedChatId: any = null;
  let editedThreadId: any = null;
  let editedName: string | null = null;

  const mockContext: any = {
    telegram: {
      editForumTopic: async (chatId: any, threadId: number, name: string) => {
        editedChatId = chatId;
        editedThreadId = threadId;
        editedName = name;
        return true;
      },
    },
    state: {
      session: (key: string) => {
        if (key === "-100123:5") {
          return { hasAutoRenamedTopic: true };
        }
        return null;
      },
    },
  };

  // Case 1: Topic was auto-renamed -> defaults to "Topic 5"
  await resetForumTopicNameIfAutoRenamed(mockContext, "-100123:5");
  assert.equal(editedChatId, -100123);
  assert.equal(editedThreadId, 5);
  assert.equal(editedName, "Topic 5");

  // Reset trackers
  editedChatId = null;
  editedThreadId = null;
  editedName = null;

  // Case 2: Topic was NOT auto-renamed
  await resetForumTopicNameIfAutoRenamed(mockContext, "-100123:6");
  assert.equal(editedName, null, "Should not edit topic if not auto-renamed");

  // Case 3: Thread 1 (General topic) should reset to "General" by default
  const mockContextGen: any = {
    config: {
      telegram: {
        enableTopics: true,
      },
    },
    telegram: {
      editForumTopic: async (chatId: any, threadId: number, name: string) => {
        editedChatId = chatId;
        editedThreadId = threadId;
        editedName = name;
        return true;
      },
    },
    state: {
      session: (key: string) => {
        if (key === "-100123:1" || key === "-100123" || key === "123456") {
          return { hasAutoRenamedTopic: true };
        }
        return null;
      },
    },
  };
  await resetForumTopicNameIfAutoRenamed(mockContextGen, "-100123:1");
  assert.equal(editedChatId, -100123);
  assert.equal(editedThreadId, 1);
  assert.equal(editedName, "General");

  // Case 4: General topic session without :1 suffix when enableTopics is true in supergroup
  editedChatId = null;
  editedThreadId = null;
  editedName = null;
  await resetForumTopicNameIfAutoRenamed(mockContextGen, "-100123");
  assert.equal(String(editedChatId), "-100123");
  assert.equal(editedThreadId, 1);
  assert.equal(editedName, "General");

  // Case 5: Private 1:1 DM (positive chatId) should NOT call editForumTopic even if enableTopics is true
  editedChatId = null;
  editedThreadId = null;
  editedName = null;
  await resetForumTopicNameIfAutoRenamed(mockContextGen, "123456");
  assert.equal(editedName, null, "Should not attempt forum topic reset on 1:1 private DM");

  // Case 6: Custom topicResetPrefix ("T") resets to "T1" and "T5"
  mockContextGen.config.telegram.topicResetPrefix = "T";
  await resetForumTopicNameIfAutoRenamed(mockContextGen, "-100123:1");
  assert.equal(editedName, "T1");
});

test("cliToolsKeyboard and modeSandboxKeyboard expose toggle:autotopic and handleCallback toggles it in-place", async () => {
  const config = loadConfig(base);
  const sessions: Record<string, any> = {};
  let lastEditedText = "";
  let lastEditedKeyboard: any = null;

  const ctx: any = {
    config,
    state: {
      session: (key: string) => sessions[String(key)] || null,
      setSession: async (key: string, val: any) => {
        sessions[String(key)] = { ...sessions[String(key)], ...val };
      },
    },
    telegram: {
      answerCallbackQuery: async () => true,
      editMessageText: async (_chatId: any, _msgId: number, text: string, markup?: any) => {
        lastEditedText = text;
        lastEditedKeyboard = markup;
      },
    },
  };

  const cliKb = cliToolsKeyboard(ctx, "123");
  const cliButtons = cliKb.inline_keyboard.flat();
  assert.ok(cliButtons.some((b) => b.callback_data === "toggle:autotopic" && b.text === "🏷️ Auto-Topic: Off"));

  const modeKb = modeSandboxKeyboard(ctx, "123");
  const modeButtons = modeKb.inline_keyboard.flat();
  assert.ok(modeButtons.some((b) => b.callback_data === "toggle:autotopic" && b.text === "🏷️ Auto-Topic: Off"));

  await handleCallback(ctx, {
    id: "cb1",
    from: { id: 123, is_bot: false, first_name: "Test" },
    message: { message_id: 10, chat: { id: 123, type: "private" } },
    data: "toggle:autotopic",
  });

  assert.equal(sessions["123"]?.settings?.autoTopicRename, true);
  assert.equal(lastEditedText, "🏷️ Auto-topic rename set to On.");
  assert.ok(lastEditedKeyboard.inline_keyboard.flat().some((b: any) => b.text === "🏷️ Auto-Topic: On"));
});

test("sessionInfoHtml includes Auto-Topic status in forum topics and /autotopic status shows detailed diagnostics", async () => {
  const config = loadConfig({
    ...base,
    TELEGRAM_ENABLE_TOPICS: "1",
    TELEGRAM_AUTO_TOPIC_RENAME: "1",
    TELEGRAM_TOPIC_RESET_PREFIX: "T",
  });
  const sessions: Record<string, any> = {
    "-100123:5": {
      hasAutoRenamedTopic: true,
      settings: { autoTopicRename: true },
    },
  };
  const sentMessages: string[] = [];

  const ctx: any = {
    config,
    state: {
      session: (key: string) => sessions[String(key)] || null,
      setSession: async (key: string, val: any) => {
        sessions[String(key)] = { ...sessions[String(key)], ...val };
      },
    },
    telegram: {
      sendMessage: async (_chatId: any, text: string) => {
        sentMessages.push(text);
        return { message_id: 1 };
      },
    },
  };

  const banner = sessionInfoHtml(ctx, "-100123:5");
  assert.match(banner, /• <b>Auto-Topic:<\/b> <code>Enabled<\/code>/);

  await handleCommand(
    ctx,
    {
      message_id: 99,
      chat: { id: -100123, type: "supergroup" },
      message_thread_id: 5,
      from: { id: 123, is_bot: false, first_name: "Stephan" },
      text: "/autotopic status",
    } as any,
    "/autotopic",
    ["status"]
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Auto Topic Rename is currently enabled/);
  assert.match(sentMessages[0], /Forum topic:<\/b> <code>#5<\/code>/);
  assert.match(sentMessages[0], /Renamed in session:<\/b> <code>yes \(resets on \/new\)<\/code>/);
  assert.match(sentMessages[0], /Reset name on \/new:<\/b> <code>T5<\/code>/);
});


