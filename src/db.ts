import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ConversationSummary } from "./types.js";

const require = createRequire(import.meta.url);
let DatabaseSyncClass: any = null;
try {
  const sqlite = require("node:sqlite");
  DatabaseSyncClass = sqlite.DatabaseSync;
} catch {
  DatabaseSyncClass = null;
}

export function resolveEffectiveDbPath(configuredPath?: string): string {
  if (configuredPath && configuredPath.trim()) {
    const trimmed = configuredPath.trim();
    return trimmed.startsWith("~")
      ? path.join(os.homedir() || process.env.HOME || "/root", trimmed.slice(trimmed === "~" ? 1 : 2))
      : trimmed;
  }
  const candidates = [
    path.join(os.homedir() || "/root", ".gemini/antigravity-cli/conversation_summaries.db"),
    "/root/.gemini/antigravity-cli/conversation_summaries.db",
    path.join(process.env.HOME || "/root", ".gemini/antigravity-cli/conversation_summaries.db"),
    "/var/lib/agybot/.gemini/antigravity-cli/conversation_summaries.db",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export interface ConversationPage {
  items: ConversationSummary[];
  total: number;
  page: number;
  totalPages: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): boolean {
  if (!value || typeof value !== "string") return false;
  return UUID_REGEX.test(value.trim());
}

export function parseTimestamp(value: unknown): number {
  if (typeof value === "number") {
    if (value < 10_000_000_000) return value * 1000;
    if (value > 10_000_000_000_000) return Math.floor(value / 1000);
    return value;
  }
  if (typeof value === "string") {
    const num = Number(value);
    if (!Number.isNaN(num) && num > 0) return parseTimestamp(num);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (value instanceof Date) return value.getTime();
  return Date.now();
}

export function formatRelativeTime(value: unknown, now = Date.now()): string {
  const time = parseTimestamp(value);
  const diffMs = now - time;
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  const date = new Date(time);
  const day = String(date.getDate()).padStart(2, "0");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  return `${day} ${month} ${year}`;
}

export class ConversationDatabase {
  public constructor(public readonly dbPath: string) {}

  public getConversations(page = 0, pageSize = 10): ConversationPage {
    const normalizedPageSize = Math.max(1, pageSize);
    const emptyResult: ConversationPage = { items: [], total: 0, page: 0, totalPages: 1 };
    if (!DatabaseSyncClass || !fs.existsSync(this.dbPath)) return emptyResult;

    let db: any = null;
    try {
      db = new DatabaseSyncClass(this.dbPath, { readOnly: true });
      const countStmt = db.prepare(
        "SELECT COUNT(*) as total FROM conversation_summaries WHERE killed = 0 AND step_count > 0;"
      );
      const countRow = countStmt.get() as { total?: number } | undefined;
      const total = countRow?.total && Number.isSafeInteger(countRow.total) ? countRow.total : 0;
      const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
      const normalizedPage = Math.min(Math.max(page, 0), totalPages - 1);
      const offset = normalizedPage * normalizedPageSize;

      const listStmt = db.prepare(`
        SELECT
          conversation_id,
          COALESCE(NULLIF(preview, ''), NULLIF(title, ''), '(untitled)') AS display_title,
          COALESCE(step_count, 0) AS step_count,
          COALESCE(last_modified_time, 0) AS last_modified_time,
          COALESCE(project_id, '') AS project_id
        FROM conversation_summaries
        WHERE killed = 0
          AND step_count > 0
        ORDER BY last_modified_time DESC
        LIMIT ? OFFSET ?;
      `);
      const rows = listStmt.all(normalizedPageSize, offset) as unknown as ConversationSummary[];
      return {
        items: rows || [],
        total,
        page: normalizedPage,
        totalPages,
      };
    } catch {
      return emptyResult;
    } finally {
      db?.close();
    }
  }

  private ensureTable(db: any): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        preview text NOT NULL DEFAULT '',
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT '',
        source text NOT NULL DEFAULT '',
        project_id text NOT NULL DEFAULT '',
        agent_name text NOT NULL DEFAULT '',
        parent_conversation_id text NOT NULL DEFAULT '',
        nesting_depth integer NOT NULL DEFAULT 0,
        battle_id text NOT NULL DEFAULT '',
        winning_conversation_id text NOT NULL DEFAULT '',
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL DEFAULT '',
        last_user_input_step_index integer NOT NULL DEFAULT -1,
        app_data_dir text NOT NULL DEFAULT ''
      );
    `);
  }

  public upsertConversation(summary: {
    conversation_id: string;
    title?: string;
    preview?: string;
    step_count?: number;
    last_modified_time?: string | number;
    project_id?: string;
    workspace_uris?: string;
  }): void {
    if (!DatabaseSyncClass || !summary.conversation_id || !isUuid(summary.conversation_id)) return;
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const db = new DatabaseSyncClass(this.dbPath);
      this.ensureTable(db);
      const isoTime = typeof summary.last_modified_time === "number"
        ? new Date(summary.last_modified_time).toISOString()
        : (summary.last_modified_time || new Date().toISOString());
      const preview = (summary.preview || summary.title || "").trim();
      const title = (summary.title || "").trim();
      const stepCount = summary.step_count && summary.step_count > 0 ? summary.step_count : 1;
      const projectId = summary.project_id || "default-cli-project";
      const workspaceUris = summary.workspace_uris || "";

      const stmt = db.prepare(`
        INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
          status, source, project_id, agent_name, parent_conversation_id, nesting_depth,
          battle_id, winning_conversation_id, not_fully_idle, killed, last_user_input_time,
          last_user_input_step_index, app_data_dir
        ) VALUES (
          ?, ?, ?, ?, ?, ?, '', 'telegram', ?, '', '', 0, '', '', 0, 0, ?, 0, 'antigravity-cli'
        )
        ON CONFLICT(conversation_id) DO UPDATE SET
          preview = CASE WHEN excluded.preview != '' THEN excluded.preview ELSE conversation_summaries.preview END,
          title = CASE WHEN excluded.title != '' THEN excluded.title ELSE conversation_summaries.title END,
          step_count = CASE WHEN excluded.step_count > conversation_summaries.step_count THEN excluded.step_count ELSE conversation_summaries.step_count + excluded.step_count END,
          last_modified_time = excluded.last_modified_time;
      `);
      stmt.run(
        summary.conversation_id,
        title,
        preview,
        stepCount,
        isoTime,
        workspaceUris,
        projectId,
        isoTime
      );
      db.close();
    } catch {
      // Ignore write errors gracefully
    }
  }

  public getConversationById(id: string): ConversationSummary | null {
    if (!DatabaseSyncClass || !id || !fs.existsSync(this.dbPath)) return null;
    let db: any = null;
    try {
      db = new DatabaseSyncClass(this.dbPath, { readOnly: true });
      const stmt = db.prepare(`
        SELECT
          conversation_id,
          COALESCE(NULLIF(preview, ''), NULLIF(title, ''), '(untitled)') AS display_title,
          COALESCE(step_count, 0) AS step_count,
          COALESCE(last_modified_time, 0) AS last_modified_time,
          COALESCE(project_id, '') AS project_id
        FROM conversation_summaries
        WHERE conversation_id = ?
          AND killed = 0
          AND step_count > 0
        LIMIT 1;
      `);
      const row = stmt.get(id) as unknown as ConversationSummary | undefined;
      return row || null;
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}
