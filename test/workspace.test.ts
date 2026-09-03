import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWithin, resolveWorkspacePath } from "../src/domain/workspace.js";
import { StateStore } from "../src/state.js";
import { effectiveWorkspaceFor, settingsFor } from "../src/domain/settings.js";
import { handleCommand } from "../src/router/commands.js";
import type { AppConfig, AppContext, ChatId, TelegramMessage } from "../src/types.js";

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

    // 5. Valid absolute path
    const validAbs = resolveWorkspacePath(proj1, projectsRoot, defaultWs);
    assert.equal(validAbs.valid, true);
    assert.equal(validAbs.resolvedPath, fs.realpathSync(proj1));

    // 6. Security boundary violation (outside projectsRoot and defaultWs)
    const outsideRes = resolveWorkspacePath(outsideDir, projectsRoot, defaultWs);
    assert.equal(outsideRes.valid, false);
    assert.match(outsideRes.error || "", /Security boundary violation/);

    // 7. Traversal attempt via ../
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

    // Simulate /new in 1:1 DM (preserveSettings = true, preserveWorkspace = false)
    await store.resetSession(dmChatId, true, false);
    const dmSession = store.session(dmChatId);
    assert.equal(dmSession?.settings?.model, "gemini-2.5-pro", "Model should be preserved in DM");
    assert.equal(dmSession?.settings?.workspace, null, "Workspace should be reset to null in DM");

    // Simulate /new in Forum Topic (preserveSettings = true, preserveWorkspace = true)
    await store.resetSession(topicChatId, true, true);
    const topicSession = store.session(topicChatId);
    assert.equal(topicSession?.settings?.model, "gemini-2.5-pro", "Model should be preserved in Topic");
    assert.equal(topicSession?.settings?.workspace, "/home/user/projects/topic-repo", "Workspace should be preserved in Topic");
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

    // 4. /workspace clear resets to default
    sentHtml.length = 0;
    const handled4 = await handleCommand(mockContext, baseMessage, "/workspace", ["clear"]);
    assert.equal(handled4, true);
    assert.match(sentHtml[0], /Workspace reset to default/);
    assert.equal(settingsFor(mockContext, 1111).workspace, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
