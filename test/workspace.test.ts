import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWithin, resolveWorkspacePath, listAvailableWorkspaces } from "../src/domain/workspace.js";
import { StateStore } from "../src/state.js";
import { effectiveWorkspaceFor, settingsFor } from "../src/domain/settings.js";
import { handleCommand } from "../src/router/commands.js";
import { handleCallback } from "../src/router/callbacks.js";
import { handleUpdate } from "../src/router/updates.js";
import { runPromptJob } from "../src/usecases/prompt-job.js";
import type { AppConfig, AppContext, ChatId, TelegramMessage, TelegramCallbackQuery, TelegramUpdate } from "../src/types.js";

test("isWithin correctly enforces path containment and blocks traversal", () => {
  const root = "/home/user/projects";
  assert.equal(isWithin("/home/user/projects/repo1", root), true);
  assert.equal(isWithin("/home/user/projects/repo1/subfolder", root), true);
  assert.equal(isWithin("/home/user/projects", root), true);
  assert.equal(isWithin("/home/user/projects-other", root), false);
  assert.equal(isWithin("/home/user", root), false);
  assert.equal(isWithin("/etc/passwd", root), false);
  assert.equal(isWithin("/home/user/projects/../other", root), false);
});

test("resolveWorkspacePath validates directories and enforces boundary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ws-test-"));
  try {
    const projectsRoot = path.join(tempDir, "projects");
    const defaultWs = path.join(tempDir, "default-workspace");
    const outsideDir = path.join(tempDir, "outside");
    const proj1 = path.join(projectsRoot, "project-alpha");
    const testFile = path.join(projectsRoot, "file.txt");

    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(defaultWs, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(proj1, { recursive: true });
    fs.writeFileSync(testFile, "hello");

    // 1. Empty input
    assert.equal(resolveWorkspacePath("", projectsRoot, defaultWs).valid, false);

    // 2. Non-existent path
    const nonExistent = resolveWorkspacePath("ghost-project", projectsRoot, defaultWs);
    assert.equal(nonExistent.valid, false);
    assert.match(nonExistent.error || "", /Directory not found/);

    // 3. File instead of directory
    const fileRes = resolveWorkspacePath("file.txt", projectsRoot, defaultWs);
    assert.equal(fileRes.valid, false);
    assert.match(fileRes.error || "", /not a directory/);

    // 4. Valid relative project name
    const validRel = resolveWorkspacePath("project-alpha", projectsRoot, defaultWs);
    assert.equal(validRel.valid, true);
    assert.equal(validRel.resolvedPath, fs.realpathSync(proj1));

    // 5. Valid path starting with leading slash (e.g. /project-alpha)
    const validSlash = resolveWorkspacePath("/project-alpha", projectsRoot, defaultWs);
    assert.equal(validSlash.valid, true);
    assert.equal(validSlash.resolvedPath, fs.realpathSync(proj1));

    // 6. Subdirectory of defaultWorkspace (e.g. scripts or /scripts)
    const defaultSub = path.join(defaultWs, "scripts");
    fs.mkdirSync(defaultSub, { recursive: true });
    const validDefaultRel = resolveWorkspacePath("scripts", projectsRoot, defaultWs);
    assert.equal(validDefaultRel.valid, true);
    assert.equal(validDefaultRel.resolvedPath, fs.realpathSync(defaultSub));

    const validDefaultSlash = resolveWorkspacePath("/scripts", projectsRoot, defaultWs);
    assert.equal(validDefaultSlash.valid, true);
    assert.equal(validDefaultSlash.resolvedPath, fs.realpathSync(defaultSub));

    // 7. Valid absolute path
    const validAbs = resolveWorkspacePath(proj1, projectsRoot, defaultWs);
    assert.equal(validAbs.valid, true);
    assert.equal(validAbs.resolvedPath, fs.realpathSync(proj1));

    // 8. Security boundary violation (outside projectsRoot and defaultWs)
    const outsideRes = resolveWorkspacePath(outsideDir, projectsRoot, defaultWs);
    assert.equal(outsideRes.valid, false);
    assert.match(outsideRes.error || "", /Security boundary violation/);

    // 9. Traversal attempt via ../
    const traversalRes = resolveWorkspacePath("../outside", projectsRoot, defaultWs);
    assert.equal(traversalRes.valid, false);
    assert.match(traversalRes.error || "", /Security boundary violation/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resetSession lifecycle: clears workspace in 1:1 DMs (Option A) and preserves in Forum Topics", async () => {
  const tempFile = path.join(os.tmpdir(), `agy-state-test-${Date.now()}.json`);
  try {
    const store = new StateStore(tempFile);
    await store.load();

    const dmChatId = 12345;
    const topicChatId = "99999:42";

    // Setup DM session with custom workspace and custom model
    await store.setSession(dmChatId, {
      settings: {
        model: "gemini-2.5-pro",
        effort: "high",
        mode: "plan",
        sandbox: false,
        workspace: "/home/user/projects/my-repo",
      },
    });

    // Setup Topic session with custom workspace and custom model
    await store.setSession(topicChatId, {
      settings: {
        model: "gemini-2.5-pro",
        effort: "high",
        mode: "plan",
        sandbox: false,
        workspace: "/home/user/projects/topic-repo",
      },
    });

    // Simulate /new in 1:1 DM by default (resetSession without explicit preserveWorkspace argument)
    await store.resetSession(dmChatId);
    const dmSession = store.session(dmChatId);
    assert.equal(dmSession?.settings?.mode, "plan", "Mode should be preserved in DM");
    assert.equal(dmSession?.settings?.workspace, null, "Workspace should be reset to null in DM by default");

    // Simulate /new in Forum Topic by default (resetSession without explicit preserveWorkspace argument)
    await store.resetSession(topicChatId);
    const topicSession = store.session(topicChatId);
    assert.equal(topicSession?.settings?.mode, "plan", "Mode should be preserved in Topic");
    assert.equal(topicSession?.settings?.workspace, "/home/user/projects/topic-repo", "Workspace should be preserved in Topic by default");

    // Verify explicit preserveWorkspace = true is honored in DM
    await store.setSession(dmChatId, { settings: { model: "gemini-2.5-pro", workspace: "/home/user/projects/dm-forced" } });
    await store.resetSession(dmChatId, true, true);
    assert.equal(store.session(dmChatId)?.settings?.workspace, "/home/user/projects/dm-forced");
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test("effectiveWorkspaceFor falls back to config.agy.workspace when no custom workspace is set", async () => {
  const tempFile = path.join(os.tmpdir(), `agy-state-test-${Date.now()}.json`);
  try {
    const store = new StateStore(tempFile);
    await store.load();

    const dummyContext = {
      config: {
        agy: {
          workspace: "/srv/agy-workspaces/default",
          model: "gemini-2.5-flash",
          effort: "high",
          mode: "plan",
          sandbox: false,
          allowedModels: ["gemini-2.5-flash"],
        },
        telegram: { verbose: "detailed" },
      },
      state: store,
    } as unknown as AppContext;

    const chatId = 54321;
    assert.equal(effectiveWorkspaceFor(dummyContext, chatId), "/srv/agy-workspaces/default");

    // Set custom workspace
    await store.setSession(chatId, {
      settings: {
        model: "gemini-2.5-flash",
        effort: "high",
        mode: "plan",
        sandbox: false,
        workspace: "/home/user/projects/custom-app",
      },
    });

    assert.equal(effectiveWorkspaceFor(dummyContext, chatId), "/home/user/projects/custom-app");
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test("/workspace command handles info, switching, validation errors, and clear", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cmd-test-"));
  const tempStateFile = path.join(tempDir, "state.json");
  const projectsRoot = path.join(tempDir, "projects");
  const defaultWs = path.join(tempDir, "default");
  const projectA = path.join(projectsRoot, "project-a");

  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(defaultWs, { recursive: true });
  fs.mkdirSync(projectA, { recursive: true });

  try {
    const store = new StateStore(tempStateFile);
    await store.load();

    const sentHtml: string[] = [];
    const mockTelegram = {
      sendMessage: async (_chatId: ChatId, text: string, options?: any) => {
        sentHtml.push(options?.parse_mode === "HTML" ? text : text);
        return { message_id: 100 };
      },
    };

    const mockContext = {
      config: {
        agy: {
          workspace: defaultWs,
          projectsRoot,
          model: "gemini-2.5-flash",
          effort: "high",
          mode: "plan",
          sandbox: false,
          allowedModels: ["gemini-2.5-flash"],
        },
        telegram: { verbose: "detailed" },
      },
      state: store,
      telegram: mockTelegram,
    } as unknown as AppContext;

    const baseMessage: TelegramMessage = {
      message_id: 1,
      date: Date.now(),
      chat: { id: 1111, type: "private" },
    };

    // 1. /workspace without args displays active workspace
    sentHtml.length = 0;
    const handled1 = await handleCommand(mockContext, baseMessage, "/workspace", []);
    assert.equal(handled1, true);
    assert.match(sentHtml[0], /Active Workspace:/);
    assert.match(sentHtml[0], /\(default\)/);

    // 2. /workspace with valid project
    sentHtml.length = 0;
    const handled2 = await handleCommand(mockContext, baseMessage, "/workspace", ["project-a"]);
    assert.equal(handled2, true);
    assert.match(sentHtml[0], /Workspace switched/);
    assert.equal(settingsFor(mockContext, 1111).workspace, fs.realpathSync(projectA));

    // Check /workspace info after switch
    sentHtml.length = 0;
    await handleCommand(mockContext, baseMessage, "/workspace", []);
    assert.match(sentHtml[0], /\(custom\)/);

    // 3. /workspace with invalid directory
    sentHtml.length = 0;
    const handled3 = await handleCommand(mockContext, baseMessage, "/workspace", ["does-not-exist"]);
    assert.equal(handled3, true);
    assert.match(sentHtml[0], /Workspace error/);
    // Workspace must remain project-a
    assert.equal(settingsFor(mockContext, 1111).workspace, fs.realpathSync(projectA));

    // 4. /workspace with leading slash /project-a
    sentHtml.length = 0;
    const handledSlash = await handleCommand(mockContext, baseMessage, "/workspace", ["/project-a"]);
    assert.equal(handledSlash, true);
    assert.match(sentHtml[0], /Workspace switched/);
    assert.equal(settingsFor(mockContext, 1111).workspace, fs.realpathSync(projectA));

    // 5. /workspace clear resets to default
    sentHtml.length = 0;
    const handled4 = await handleCommand(mockContext, baseMessage, "/workspace", ["clear"]);
    assert.equal(handled4, true);
    assert.match(sentHtml[0], /Workspace reset to default/);
    assert.equal(settingsFor(mockContext, 1111).workspace, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("listAvailableWorkspaces scans projects and ignores hidden or vendor folders", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-list-test-"));
  try {
    const projectsRoot = path.join(tempDir, "projects");
    const defaultWs = path.join(tempDir, "default-ws");
    const repo1 = path.join(projectsRoot, "repo-alpha");
    const repo2 = path.join(projectsRoot, "repo-beta");
    const hidden = path.join(projectsRoot, ".git");
    const nodeModules = path.join(projectsRoot, "node_modules");
    const subWs = path.join(defaultWs, "tool-script");

    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(defaultWs, { recursive: true });
    fs.mkdirSync(repo1, { recursive: true });
    fs.mkdirSync(repo2, { recursive: true });
    fs.mkdirSync(hidden, { recursive: true });
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.mkdirSync(subWs, { recursive: true });

    const list = listAvailableWorkspaces(projectsRoot, defaultWs);
    const names = list.map((w) => w.name);
    assert.ok(names.includes("repo-alpha"));
    assert.ok(names.includes("repo-beta"));
    assert.ok(names.includes("tool-script"));
    assert.ok(!names.includes(".git"), "Should ignore hidden directories");
    assert.ok(!names.includes("node_modules"), "Should ignore node_modules");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("interactive callback set:ws switches workspace and set:ws:clear resets", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cb-test-"));
  const tempStateFile = path.join(tempDir, "state.json");
  const projectsRoot = path.join(tempDir, "projects");
  const defaultWs = path.join(tempDir, "default");
  const projectA = path.join(projectsRoot, "project-alpha");

  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(defaultWs, { recursive: true });
  fs.mkdirSync(projectA, { recursive: true });

  try {
    const store = new StateStore(tempStateFile);
    await store.load();

    const sentHtml: string[] = [];
    const mockTelegram = {
      sendMessage: async (_chatId: ChatId, text: string, options?: any) => {
        sentHtml.push(options?.parse_mode === "HTML" ? text : text);
        return { message_id: 101 };
      },
      editMessageText: async (_chatId: ChatId, _msgId: number, text: string, _markup?: any, parseMode?: string) => {
        sentHtml.push(parseMode === "HTML" ? text : text);
      },
      answerCallbackQuery: async () => true,
    };

    const mockContext = {
      config: {
        agy: {
          workspace: defaultWs,
          projectsRoot,
          model: "gemini-2.5-flash",
          effort: "high",
          mode: "plan",
          sandbox: false,
          allowedModels: ["gemini-2.5-flash"],
        },
        telegram: { verbose: "detailed", allowedUserIds: ["2222"] },
      },
      state: store,
      telegram: mockTelegram,
    } as unknown as AppContext;

    const baseCallback: TelegramCallbackQuery = {
      id: "cb-1",
      from: { id: 2222, is_bot: false, first_name: "Med" },
      message: {
        message_id: 50,
        date: Date.now(),
        chat: { id: 2222, type: "private" },
      },
      data: "set:ws:project-alpha",
    };

    // 1. Click on project-alpha
    sentHtml.length = 0;
    await handleCallback(mockContext, baseCallback);
    assert.equal(settingsFor(mockContext, 2222).workspace, fs.realpathSync(projectA));
    assert.match(sentHtml[0], /Workspace switched/);

    // 2. Click on clear
    sentHtml.length = 0;
    await handleCallback(mockContext, { ...baseCallback, data: "set:ws:clear" });
    assert.equal(settingsFor(mockContext, 2222).workspace, null);
    assert.match(sentHtml[0], /Workspace reset to default/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runPromptJob prefixes starting progress message with workspace banner when custom workspace is set", async () => {
  const tempFile = path.join(os.tmpdir(), `agy-state-ws-prompt-${Date.now()}.json`);
  try {
    const store = new StateStore(tempFile);
    await store.load();

    const sentMessages: Array<{ text: string; parseMode?: string }> = [];
    const mockTelegram = {
      sendChatAction: async () => true,
      sendMessage: async (_chatId: ChatId, text: string, _markup?: any, parseMode?: string) => {
        sentMessages.push({ text, parseMode });
        return { message_id: 200 };
      },
      deleteMessage: async () => true,
      editMessageText: async () => {},
    };

    const mockContext = {
      config: {
        agy: {
          workspace: "/default/ws",
          model: "gemini-2.5-flash",
          effort: "high",
          mode: "plan",
          sandbox: false,
          allowedModels: ["gemini-2.5-flash"],
        },
        telegram: { verbose: "detailed", progressMode: "full" },
      },
      state: store,
      controllers: new Map(),
      telegram: mockTelegram,
    } as unknown as AppContext;

    const chatId = 8888;
    await store.setSession(chatId, {
      settings: {
        model: "gemini-2.5-flash",
        effort: "high",
        mode: "plan",
        sandbox: false,
        workspace: "/custom/project/repo",
      },
    });

    let cancelAfterStart = false;
    const isCancelled = () => cancelAfterStart;

    const jobPromise = runPromptJob(mockContext, { id: "job-1", chatId, kind: "prompt", prompt: "hello" }, isCancelled);
    cancelAfterStart = true;
    mockContext.controllers.get("prompt:8888")?.abort();
    await jobPromise.catch(() => {});

    assert.ok(sentMessages.length > 0, "At least one starting progress message should be sent");
    assert.match(sentMessages[0].text, /📁 <b>Workspace:<\/b> <code>\/custom\/project\/repo<\/code>/);
    assert.equal(sentMessages[0].parseMode, "HTML");
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test("button '✨ New' and command '/new' reset workspace to default in 1:1 DM and preserve in Forum Topic", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-new-test-"));
  const tempStateFile = path.join(tempDir, "state.json");
  const defaultWs = path.join(tempDir, "default");
  fs.mkdirSync(defaultWs, { recursive: true });

  try {
    const store = new StateStore(tempStateFile);
    await store.load();

    const mockTelegram = {
      sendMessage: async () => ({ message_id: 123 }),
      sendChatAction: async () => true,
    };

    const mockContext = {
      config: {
        agy: {
          workspace: defaultWs,
          projectsRoot: tempDir,
          model: "gemini-2.5-flash",
          effort: "high",
          mode: "plan",
          sandbox: false,
          allowedModels: ["gemini-2.5-flash"],
        },
        telegram: {
          allowedUserIds: ["1111", "2222"],
          verbose: "detailed",
          tempDir: path.join(tempDir, "tmp"),
        },
        tempDir: path.join(tempDir, "tmp"),
      },
      state: store,
      telegram: mockTelegram,
    } as unknown as AppContext;

    // 1. In private 1:1 DM, "✨ New" button resets workspace to null
    const dmChatId = 1111;
    await store.setSession(dmChatId, {
      settings: {
        model: "gemini-2.5-flash",
        workspace: "/home/user/projects/dm-repo",
      },
    });
    assert.equal(settingsFor(mockContext, dmChatId).workspace, "/home/user/projects/dm-repo");

    await handleUpdate(mockContext, {
      update_id: 1,
      message: {
        message_id: 10,
        date: Date.now(),
        chat: { id: dmChatId, type: "private" },
        from: { id: dmChatId, is_bot: false },
        text: "✨ New",
      },
    });
    assert.equal(settingsFor(mockContext, dmChatId).workspace, null, "✨ New button should reset workspace in DM");

    // 2. In private 1:1 DM, /new command resets workspace to null
    await store.setSession(dmChatId, {
      settings: {
        model: "gemini-2.5-flash",
        workspace: "/home/user/projects/dm-repo",
      },
    });
    const dmMsg: TelegramMessage = {
      message_id: 11,
      date: Date.now(),
      chat: { id: dmChatId, type: "private" },
      from: { id: dmChatId, is_bot: false },
      text: "/new",
    };
    await handleCommand(mockContext, dmMsg, "/new", []);
    assert.equal(settingsFor(mockContext, dmChatId).workspace, null, "/new command should reset workspace in DM");

    // 3. In Forum Topic, "✨ New" button preserves workspace
    const topicChatId = 2222;
    const threadId = 55;
    const topicSessionKey = `${topicChatId}:${threadId}`;
    await store.setSession(topicSessionKey, {
      settings: {
        model: "gemini-2.5-flash",
        workspace: "/home/user/projects/topic-repo",
      },
    });
    await handleUpdate(mockContext, {
      update_id: 2,
      message: {
        message_id: 20,
        message_thread_id: threadId,
        date: Date.now(),
        chat: { id: topicChatId, type: "supergroup" },
        from: { id: 2222, is_bot: false },
        text: "✨ New",
      },
    });
    assert.equal(settingsFor(mockContext, topicSessionKey).workspace, "/home/user/projects/topic-repo", "✨ New button should preserve workspace in Forum Topic");

    // 4. In Forum Topic, /new command preserves workspace
    const topicMsg: TelegramMessage = {
      message_id: 21,
      message_thread_id: threadId,
      date: Date.now(),
      chat: { id: topicChatId, type: "supergroup" },
      from: { id: 2222, is_bot: false },
      text: "/new",
    };
    await handleCommand(mockContext, topicMsg, "/new", []);
    assert.equal(settingsFor(mockContext, topicSessionKey).workspace, "/home/user/projects/topic-repo", "/new command should preserve workspace in Forum Topic");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

