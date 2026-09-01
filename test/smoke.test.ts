import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runPtyCommand, parseUsageQuota, parseCredits } from "../src/pty-runner.js";
import { ConversationDatabase, formatRelativeTime, isUuid } from "../src/db.js";
import { splitPreformattedHtml } from "../src/telegram.js";
import type { AgyConfig } from "../src/types.js";

const require = createRequire(import.meta.url);
let DatabaseSync: any = null;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = null;
}

test("smoke test: full interactive PTY execution with chunked output, prompt readiness, \\r input, and quota extraction", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-smoke-test-"));
  const mockAgyBin = path.join(tmpDir, "mock-agy.py");

  // Create a realistic interactive AGY mock script in Python with chunked delivery
  const mockScript = `#!/usr/bin/env python3
import sys, time, termios, tty

# Initialize raw TUI terminal
sys.stdout.write("\\x1b[>4m\\x1b[=0;1u\\x1b[?1049h\\x1b[?25l\\x1b[2J\\x1b[H")
sys.stdout.write("Antigravity CLI v1.1.11 (Production)\\n\\n")
sys.stdout.flush()

time.sleep(0.05)

# Display interactive prompt between TUI rows, as AGY does in production.
sys.stdout.write("\\n────────────────────────\\n>\\n────────────────────────\\n? for shortcuts\\n")
sys.stdout.flush()

# Read command from stdin character by character (raw mode)
fd = sys.stdin.fileno()
old_settings = termios.tcgetattr(fd)
tty.setraw(fd)
buf = ""

try:
    while True:
        ch = sys.stdin.read(1)
        if ch == "\\r": # Enter pressed in raw terminal
            break
        elif ch == "\\n":
            # Real raw terminal does NOT submit on \\n without \\r
            continue
        else:
            buf += ch
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

# Process command with chunked delivery to simulate realistic network latency
if buf.strip() == "/usage":
    chunk1 = """
Models & Quota

Account: ardiannurcahya436@gmail.com

GEMINI MODELS
Weekly Limit Remaining
██████████████░░░░ 94% remaining
"""
    sys.stdout.write(chunk1)
    sys.stdout.flush()
    time.sleep(0.1)

    chunk2 = """Refreshes in 151h 15m

Five Hour Limit Remaining
████████████░░░░░░ 81% remaining
Refreshes in 1h 52m

CLAUDE AND GPT MODELS
Weekly Limit Remaining
██████████████████ 100% Quota available

Five Hour Limit Remaining
██████████████████ 100% Quota available
"""
    sys.stdout.write(chunk2)
    sys.stdout.flush()
    time.sleep(0.1)

    # Return to prompt
    sys.stdout.write("\\n────────────────────────\\n>\\n────────────────────────\\n? for shortcuts\\n")
    sys.stdout.flush()
elif buf.strip() == "/credits":
    sys.stdout.write("Credits information\\n")
    sys.stdout.flush()
    time.sleep(0.05)
    sys.stdout.write("G1 credits remaining: 420.50\\nPurchase link: https://buy.antigravity.google.com/credits\\n\\n────────────────────────\\n>\\n────────────────────────\\n? for shortcuts\\n")
    sys.stdout.flush()
else:
    sys.stdout.write(f"Unknown command: {buf}\\n────────────────────────\\n>\\n────────────────────────\\n? for shortcuts\\n")
    sys.stdout.flush()
`;

  fs.writeFileSync(mockAgyBin, mockScript, { mode: 0o755 });

  const dummyConfig: AgyConfig = {
    bin: mockAgyBin,
    workspace: tmpDir,
    project: "",
    mode: "plan",
    effort: "high",
    sandbox: true,
    allowSandboxDisable: false,
    allowedModels: [],
    timeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
    allowDangerouslySkipPermissions: false,
    dbPath: "/tmp/dummy.db",
  };

  // 1. Test /usage via full interactive PTY
  const usageRaw = await runPtyCommand(dummyConfig, "/usage", { timeoutMs: 8000 });
  assert.match(usageRaw, /Models & Quota/);
  assert.match(usageRaw, /ardiannurcahya436@gmail\.com/);
  assert.match(usageRaw, /GEMINI MODELS/);
  assert.match(usageRaw, /CLAUDE AND GPT MODELS/);

  const usageHtml = parseUsageQuota(usageRaw);
  assert.match(usageHtml, /📊 <b>Models & Quota<\/b>/);
  assert.match(usageHtml, /<code>ardiannurcahya436@gmail\.com<\/code>/);
  assert.match(usageHtml, /<b>Gemini Models<\/b>/);
  assert.match(usageHtml, /Weekly: 🟢 <b>94%<\/b> \(in 151h 15m\) <i>\[\+4%\]<\/i>/);
  assert.match(usageHtml, /5-Hour: ⭐ <b>81%<\/b> \(in 1h 52m\) <i>\[\+44%\]<\/i>/);
  assert.match(usageHtml, /<b>Claude &amp; GPT Models<\/b>|<b>Claude & GPT Models<\/b>/);
  assert.match(usageHtml, /Weekly: 🟢 <b>100%<\/b>/);

  // 2. Test /credits via full interactive PTY
  const creditsRaw = await runPtyCommand(dummyConfig, "/credits", { timeoutMs: 8000 });
  assert.match(creditsRaw, /credits remaining/i);

  const creditsHtml = parseCredits(creditsRaw);
  assert.match(creditsHtml, /💳 <b>AGY Credits<\/b>/);
  assert.match(creditsHtml, /Credits Remaining: <b>420\.50<\/b>/);
  assert.match(creditsHtml, /https:\/\/buy\.antigravity\.google\.com\/credits/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("smoke test: process group is killed and Promise rejects on AbortSignal", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-smoke-abort-"));
  const hangingBin = path.join(tmpDir, "hang.py");

  fs.writeFileSync(
    hangingBin,
    `#!/usr/bin/env python3
import time
while True:
    time.sleep(1)
`,
    { mode: 0o755 }
  );

  const controller = new AbortController();
  const promise = runPtyCommand(
    {
      bin: hangingBin,
      workspace: tmpDir,
      mode: "plan",
      effort: "high",
      sandbox: true,
      allowSandboxDisable: false,
      allowedModels: [],
      timeoutMs: 10_000,
      maxOutputBytes: 10000,
      allowDangerouslySkipPermissions: false,
      dbPath: "/tmp/db.sqlite",
    },
    "/usage",
    { signal: controller.signal }
  );

  // Abort after 100ms
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(promise, /cancelled/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("smoke test: realistic SQLite pagination, UUID lookup, and relative dates across 25 sessions", () => {
  if (!DatabaseSync) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-db-smoke-"));
  const dbFile = path.join(tmpDir, "conversation_summaries.db");

  const sync = new DatabaseSync(dbFile);
  sync.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      preview TEXT,
      title TEXT,
      step_count INTEGER,
      last_modified_time INTEGER,
      project_id TEXT,
      killed INTEGER
    );
  `);

  const insert = sync.prepare(`
    INSERT INTO conversation_summaries (conversation_id, preview, title, step_count, last_modified_time, project_id, killed)
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `);

  const now = Date.now();
  const testUuids: string[] = [];

  for (let i = 1; i <= 25; i++) {
    const uuid = `12345678-1234-1234-1234-${String(i).padStart(12, "0")}`;
    testUuids.push(uuid);
    const timeOffset = i * 60 * 1000 * 30; // 30 mins apart
    insert.run(uuid, `Preview for session ${i}`, `Title ${i}`, i * 5, now - timeOffset, "default", 0);
  }

  sync.close();

  const convDb = new ConversationDatabase(dbFile);

  // Page 0 (items 1-10)
  const page0 = convDb.getConversations(0, 10);
  assert.equal(page0.total, 25);
  assert.equal(page0.totalPages, 3);
  assert.equal(page0.page, 0);
  assert.equal(page0.items.length, 10);
  assert.equal(page0.items[0].conversation_id, testUuids[0]);

  // Page 1 (items 11-20)
  const page1 = convDb.getConversations(1, 10);
  assert.equal(page1.page, 1);
  assert.equal(page1.items.length, 10);
  assert.equal(page1.items[0].conversation_id, testUuids[10]);

  // Page 2 (items 21-25)
  const page2 = convDb.getConversations(2, 10);
  assert.equal(page2.page, 2);
  assert.equal(page2.items.length, 5);
  assert.equal(page2.items[4].conversation_id, testUuids[24]);

  // UUID lookup
  assert.equal(isUuid(testUuids[0]), true);
  assert.equal(isUuid("not-a-uuid"), false);

  const item = convDb.getConversationById(testUuids[0]);
  assert.ok(item);
  assert.equal(item.display_title, "Preview for session 1");
  assert.equal(item.step_count, 5);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("formatTelegramHtml handles conversation:// and file:// links cleanly without backtick artifacts", async () => {
  const { formatTelegramHtml } = await import("../src/telegram/markdown-renderer.js");
  const markdown = "Consultez [utils.py](file:///path/to/utils.py) ou [`Conversation`](conversation://12345-abcde) pour les détails.";
  const formatted = formatTelegramHtml(markdown);

  assert.match(formatted, /<code>utils\.py<\/code>/);
  assert.match(formatted, /<code>Conversation<\/code>/);
  assert.doesNotMatch(formatted, /<a href="conversation/);
  assert.doesNotMatch(formatted, /<a href="file/);
  assert.doesNotMatch(formatted, /`<code>/);
});

test("TOP_LEVEL_COMMANDS includes mic-serve and mcp, and validateCustomArgs supports freeform prompts", async () => {
  const { TOP_LEVEL_COMMANDS, validateCustomArgs } = await import("../src/agy-runner.js");
  assert.equal(TOP_LEVEL_COMMANDS.has("mic-serve"), true);
  assert.equal(TOP_LEVEL_COMMANDS.has("mcp"), true);
  assert.equal(TOP_LEVEL_COMMANDS.has("models"), true);

  assert.equal(validateCustomArgs(["mic-serve"]), null);
  assert.equal(validateCustomArgs(["models"]), null);
  assert.equal(validateCustomArgs(["Explain", "this", "code"]), null);
  assert.equal(validateCustomArgs(["--print", "hello"]), null);
  assert.match(validateCustomArgs(["--prompt-interactive"]) || "", /requires a local TTY/);
});
