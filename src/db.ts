import crypto from "node:crypto";
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

  public updateConversationTitle(conversationId: string, title: string): boolean {
    if (!DatabaseSyncClass || !conversationId || !isUuid(conversationId)) return false;
    let db: any = null;
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      db = new DatabaseSyncClass(this.dbPath);
      this.ensureTable(db);
      const cleanTitle = title.trim();
      const stmt = db.prepare(`
        UPDATE conversation_summaries
        SET title = ?, preview = ?
        WHERE conversation_id = ?;
      `);
      stmt.run(cleanTitle, cleanTitle, conversationId);
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  public markConversationKilled(conversationId: string): boolean {
    if (!DatabaseSyncClass || !conversationId || !isUuid(conversationId) || !fs.existsSync(this.dbPath)) return false;
    let db: any = null;
    try {
      db = new DatabaseSyncClass(this.dbPath);
      this.ensureTable(db);
      const stmt = db.prepare(`
        UPDATE conversation_summaries
        SET killed = 1
        WHERE conversation_id = ?;
      `);
      stmt.run(conversationId);
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  /**
   * Marks an ephemeral conversation (e.g. from `/btw`) as killed in the summary
   * database and cleans up its disk artifacts so it does not clutter `/resume`.
   */
  public deleteConversation(conversationId: string): boolean {
    if (!conversationId || !isUuid(conversationId)) return false;
    let db: any = null;
    try {
      const appDataDir = path.dirname(this.dbPath);
      const convDbFile = path.join(appDataDir, "conversations", `${conversationId}.db`);
      const brainDir = path.join(appDataDir, "brain", conversationId);
      if (fs.existsSync(convDbFile)) {
        fs.rmSync(convDbFile, { force: true });
      }
      if (fs.existsSync(`${convDbFile}-wal`)) {
        fs.rmSync(`${convDbFile}-wal`, { force: true });
      }
      if (fs.existsSync(`${convDbFile}-shm`)) {
        fs.rmSync(`${convDbFile}-shm`, { force: true });
      }
      if (fs.existsSync(brainDir)) {
        fs.rmSync(brainDir, { recursive: true, force: true });
      }
      if (DatabaseSyncClass && fs.existsSync(this.dbPath)) {
        db = new DatabaseSyncClass(this.dbPath);
        this.ensureTable(db);
        db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?;").run(conversationId);
      }
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  /**
   * Clones an existing conversation thread (per-conversation SQLite DB, brain
   * directory, and summary record) into a new independent UUID branch.
   */
  public forkConversation(
    sourceId: string,
    customTitle?: string,
    fallbackMeta?: { title?: string; stepCount?: number; workspace?: string; projectId?: string }
  ): ForkConversationResult | null {
    if (!DatabaseSyncClass || !sourceId || !isUuid(sourceId)) return null;
    let db: any = null;
    try {
      const appDataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });

      db = new DatabaseSyncClass(this.dbPath);
      this.ensureTable(db);

      const sourceRow = db.prepare(`
        SELECT * FROM conversation_summaries
        WHERE conversation_id = ? AND killed = 0
        LIMIT 1;
      `).get(sourceId) as Record<string, any> | undefined;

      const srcConvDbFile = path.join(appDataDir, "conversations", `${sourceId}.db`);
      const srcBrainDir = path.join(appDataDir, "brain", sourceId);
      const hasDiskArtifacts = fs.existsSync(srcConvDbFile) || fs.existsSync(srcBrainDir);

      if (!sourceRow && !hasDiskArtifacts && !fallbackMeta?.title && !fallbackMeta?.stepCount) {
        return null;
      }

      const newId = crypto.randomUUID();
      const newTrajectoryId = crypto.randomUUID();

      // 1. Clone per-conversation SQLite database if present on disk
      if (fs.existsSync(srcConvDbFile)) {
        const dstConvDbFile = path.join(appDataDir, "conversations", `${newId}.db`);
        fs.mkdirSync(path.dirname(dstConvDbFile), { recursive: true });

        // Flush WAL pages to main database file if WAL is active
        try {
          const srcDb = new DatabaseSyncClass(srcConvDbFile);
          srcDb.exec("PRAGMA wal_checkpoint(PASSIVE);");
          srcDb.close();
        } catch {
          // Ignore if busy or read-only
        }

        fs.copyFileSync(srcConvDbFile, dstConvDbFile);

        let convDb: any = null;
        try {
          convDb = new DatabaseSyncClass(dstConvDbFile);
          const metaRow = convDb.prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1;").get() as { trajectory_id?: string } | undefined;
          const oldTrajectoryId = metaRow?.trajectory_id && isUuid(metaRow.trajectory_id) ? metaRow.trajectory_id : null;

          convDb.prepare("UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?;").run(newTrajectoryId, newId);

          const pairs: Array<[Buffer, Buffer]> = [[Buffer.from(sourceId, "utf8"), Buffer.from(newId, "utf8")]];
          if (oldTrajectoryId) {
            pairs.push([Buffer.from(oldTrajectoryId, "utf8"), Buffer.from(newTrajectoryId, "utf8")]);
          }

          const blobRows = convDb.prepare("SELECT id, data FROM trajectory_metadata_blob;").all() as Array<{ id: string; data: Uint8Array | null }>;
          for (const row of blobRows) {
            const updated = replaceUuidInBlob(row.data, pairs);
            if (updated) {
              convDb.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?;").run(updated, row.id);
            }
          }

          const stepRows = convDb.prepare("SELECT idx, metadata, step_payload FROM steps;").all() as Array<{ idx: number; metadata: Uint8Array | null; step_payload: Uint8Array | null }>;
          for (const sRow of stepRows) {
            const newMeta = replaceUuidInBlob(sRow.metadata, pairs);
            const newPayload = replaceUuidInBlob(sRow.step_payload, pairs);
            if (newMeta || newPayload) {
              convDb.prepare("UPDATE steps SET metadata = ?, step_payload = ? WHERE idx = ?;").run(
                newMeta || sRow.metadata,
                newPayload || sRow.step_payload,
                sRow.idx
              );
            }
          }
        } finally {
          convDb?.close();
        }
      }

      // 2. Clone brain directory and rewrite conversation ID in JSONL transcripts
      if (fs.existsSync(srcBrainDir)) {
        const dstBrainDir = path.join(appDataDir, "brain", newId);
        fs.cpSync(srcBrainDir, dstBrainDir, { recursive: true });
        for (const fileName of ["transcript.jsonl", "transcript_full.jsonl"]) {
          const transcriptPath = path.join(dstBrainDir, ".system_generated", "logs", fileName);
          if (fs.existsSync(transcriptPath)) {
            const content = fs.readFileSync(transcriptPath, "utf8");
            if (content.includes(sourceId)) {
              fs.writeFileSync(transcriptPath, content.split(sourceId).join(newId), "utf8");
            }
          }
        }
      }

      // 3. Insert forked summary record into conversation_summaries.db
      const rawBaseTitle = (
        sourceRow?.title ||
        sourceRow?.preview ||
        fallbackMeta?.title ||
        "Conversation"
      ).trim();
      const baseTitle = rawBaseTitle.replace(/\s*\(fork(?:\s+\d+)?\)$/i, "");
      const forkTitle = (customTitle && customTitle.trim()) ? customTitle.trim() : `${baseTitle} (fork)`;
      const stepCount = Number(sourceRow?.step_count || fallbackMeta?.stepCount || 1);
      const nowIso = new Date().toISOString();
      const workspaceUris = sourceRow?.workspace_uris || (fallbackMeta?.workspace ? `["file://${fallbackMeta.workspace}"]` : "");
      const projectId = sourceRow?.project_id || fallbackMeta?.projectId || "default-cli-project";
      const lastUserInputIdx = typeof sourceRow?.last_user_input_step_index === "number" ? sourceRow.last_user_input_step_index : 0;

      const stmt = db.prepare(`
        INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
          status, source, project_id, agent_name, parent_conversation_id, nesting_depth,
          battle_id, winning_conversation_id, not_fully_idle, killed, last_user_input_time,
          last_user_input_step_index, app_data_dir
        ) VALUES (
          ?, ?, ?, ?, ?, ?, '', 'telegram', ?, '', ?, 0, '', '', 0, 0, ?, ?, 'antigravity-cli'
        );
      `);
      stmt.run(
        newId,
        forkTitle,
        forkTitle,
        stepCount,
        nowIso,
        workspaceUris,
        projectId,
        sourceId,
        nowIso,
        lastUserInputIdx
      );

      // Preserve raw_summary protobuf if column exists on the table
      if (sourceRow?.raw_summary instanceof Uint8Array) {
        try {
          const updatedRaw = replaceUuidInBlob(sourceRow.raw_summary, [
            [Buffer.from(sourceId, "utf8"), Buffer.from(newId, "utf8")],
          ]);
          db.prepare("UPDATE conversation_summaries SET raw_summary = ? WHERE conversation_id = ?;").run(
            updatedRaw || sourceRow.raw_summary,
            newId
          );
        } catch {
          // Column may not exist on synthetic tables
        }
      }

      return {
        conversationId: newId,
        parentConversationId: sourceId,
        title: forkTitle,
        stepCount,
      };
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  /**
   * Rolls back the conversation trajectory by N user turns (default: 1),
   * truncating steps in the per-conversation SQLite DB, JSONL transcripts,
   * and updating step counts in `conversation_summaries.db`.
   */
  public rewindConversation(conversationId: string, turns = 1): RewindConversationResult {
    if (!DatabaseSyncClass || !conversationId || !isUuid(conversationId) || !Number.isInteger(turns) || turns < 1) {
      return { ok: false, reason: "invalid_input" };
    }

    let summaryDb: any = null;
    try {
      const appDataDir = path.dirname(this.dbPath);
      const convDbFile = path.join(appDataDir, "conversations", `${conversationId}.db`);
      const brainLogsDir = path.join(appDataDir, "brain", conversationId, ".system_generated", "logs");
      const transcriptFile = path.join(brainLogsDir, "transcript.jsonl");
      const transcriptFullFile = path.join(brainLogsDir, "transcript_full.jsonl");

      let cutoffIdx: number | null = null;
      let prevUserIdx = 0;
      let removedSteps = 0;
      let remainingSteps = 0;
      let rewoundPromptPreview: string | undefined;

      // 1. Inspect and truncate per-conversation SQLite DB if present
      if (fs.existsSync(convDbFile)) {
        let convDb: any = null;
        try {
          convDb = new DatabaseSyncClass(convDbFile);
          const allSteps = convDb.prepare("SELECT idx, step_type, step_payload FROM steps ORDER BY idx ASC;").all() as Array<{
            idx: number;
            step_type: number;
            step_payload: Uint8Array | null;
          }>;
          const userSteps = allSteps.filter((s) => s.step_type === 14);
          if (userSteps.length === 0) {
            return { ok: false, reason: "not_found" };
          }
          if (turns >= userSteps.length) {
            return { ok: false, reason: "cannot_rewind_initial_turn", totalTurns: userSteps.length };
          }

          const targetUserStep = userSteps[userSteps.length - turns];
          const prevUserStep = userSteps[userSteps.length - turns - 1];
          cutoffIdx = targetUserStep.idx;
          prevUserIdx = prevUserStep.idx;

          const stepsToDelete = allSteps.filter((s) => s.idx >= cutoffIdx!);
          removedSteps = stepsToDelete.length;
          remainingSteps = allSteps.length - removedSteps;

          if (targetUserStep.step_payload) {
            rewoundPromptPreview = extractCleanUserPrompt(Buffer.from(targetUserStep.step_payload).toString("utf8"));
          }

          // Collect turn UUIDs referenced in the removed user steps to clean metadata tables
          const removedTurnUuids = new Set<string>();
          for (const st of stepsToDelete) {
            if (st.step_type === 14 && st.step_payload) {
              const matches = Buffer.from(st.step_payload).toString("utf8").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
              if (matches) {
                for (const m of matches) removedTurnUuids.add(m.toLowerCase());
              }
            }
          }

          convDb.prepare("DELETE FROM steps WHERE idx >= ?;").run(cutoffIdx);
          try {
            convDb.prepare("DELETE FROM parent_references WHERE idx >= ?;").run(cutoffIdx);
            convDb.prepare("DELETE FROM battle_mode_infos WHERE idx >= ?;").run(cutoffIdx);
          } catch {
            // Optional auxiliary tables
          }

          if (removedTurnUuids.size > 0) {
            try {
              const genRows = convDb.prepare("SELECT idx, data FROM gen_metadata;").all() as Array<{ idx: number; data: Uint8Array | null }>;
              for (const g of genRows) {
                if (!g.data) continue;
                const str = Buffer.from(g.data).toString("utf8").toLowerCase();
                for (const u of removedTurnUuids) {
                  if (str.includes(u)) {
                    convDb.prepare("DELETE FROM gen_metadata WHERE idx = ?;").run(g.idx);
                    break;
                  }
                }
              }
              const execRows = convDb.prepare("SELECT idx, data FROM executor_metadata;").all() as Array<{ idx: number; data: Uint8Array | null }>;
              for (const e of execRows) {
                if (!e.data) continue;
                const str = Buffer.from(e.data).toString("utf8").toLowerCase();
                for (const u of removedTurnUuids) {
                  if (str.includes(u)) {
                    convDb.prepare("DELETE FROM executor_metadata WHERE idx = ?;").run(e.idx);
                    break;
                  }
                }
              }
            } catch {
              // Ignore metadata cleanup errors
            }
          }
        } finally {
          convDb?.close();
        }
      }

      // 2. Inspect and truncate JSONL transcripts if present
      if (fs.existsSync(transcriptFile)) {
        const rawLines = fs.readFileSync(transcriptFile, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
        const parsedLines: Array<{ raw: string; obj: Record<string, any> }> = [];
        for (const raw of rawLines) {
          try {
            parsedLines.push({ raw, obj: JSON.parse(raw) });
          } catch {
            // Skip malformed JSONL line
          }
        }

        if (cutoffIdx === null) {
          const userEntries = parsedLines.filter((item) => item.obj.type === "USER_INPUT");
          if (userEntries.length === 0) {
            return { ok: false, reason: "not_found" };
          }
          if (turns >= userEntries.length) {
            return { ok: false, reason: "cannot_rewind_initial_turn", totalTurns: userEntries.length };
          }
          const targetEntry = userEntries[userEntries.length - turns];
          const prevEntry = userEntries[userEntries.length - turns - 1];
          cutoffIdx = Number(targetEntry.obj.step_index);
          prevUserIdx = Number(prevEntry.obj.step_index);
          removedSteps = parsedLines.filter((item) => Number(item.obj.step_index) >= cutoffIdx!).length;
          remainingSteps = parsedLines.length - removedSteps;
        }

        const firstRemovedUser = parsedLines.find(
          (item) => Number(item.obj.step_index) >= cutoffIdx! && item.obj.type === "USER_INPUT"
        );
        if (firstRemovedUser && typeof firstRemovedUser.obj.content === "string") {
          const clean = extractCleanUserPrompt(firstRemovedUser.obj.content);
          if (clean) rewoundPromptPreview = clean;
        }

        const keptLines = parsedLines.filter((item) => Number(item.obj.step_index) < cutoffIdx!).map((item) => item.raw);
        fs.writeFileSync(transcriptFile, keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "", "utf8");

        if (fs.existsSync(transcriptFullFile)) {
          const fullRawLines = fs.readFileSync(transcriptFullFile, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
          const keptFull = fullRawLines.filter((raw) => {
            try {
              const obj = JSON.parse(raw);
              return Number(obj.step_index) < cutoffIdx!;
            } catch {
              return true;
            }
          });
          fs.writeFileSync(transcriptFullFile, keptFull.length > 0 ? `${keptFull.join("\n")}\n` : "", "utf8");
        }
      }

      // 3. Update conversation_summaries.db (and handle summary-only fallback)
      if (fs.existsSync(this.dbPath)) {
        summaryDb = new DatabaseSyncClass(this.dbPath);
        this.ensureTable(summaryDb);
        const summaryRow = summaryDb.prepare(`
          SELECT step_count, last_user_input_step_index
          FROM conversation_summaries
          WHERE conversation_id = ? AND killed = 0
          LIMIT 1;
        `).get(conversationId) as { step_count?: number; last_user_input_step_index?: number } | undefined;

        if (cutoffIdx === null) {
          if (!summaryRow) {
            return { ok: false, reason: "not_found" };
          }
          const currentSteps = Number(summaryRow.step_count || 0);
          if (currentSteps <= turns) {
            return { ok: false, reason: "cannot_rewind_initial_turn", totalTurns: currentSteps };
          }
          removedSteps = turns;
          remainingSteps = currentSteps - turns;
          prevUserIdx = Math.max(0, remainingSteps - 1);
        }

        if (summaryRow) {
          summaryDb.prepare(`
            UPDATE conversation_summaries
            SET step_count = ?, last_user_input_step_index = ?, last_modified_time = ?
            WHERE conversation_id = ?;
          `).run(remainingSteps, prevUserIdx, new Date().toISOString(), conversationId);
        }
      } else if (cutoffIdx === null) {
        return { ok: false, reason: "not_found" };
      }

      return {
        ok: true,
        conversationId,
        removedTurns: turns,
        removedSteps,
        remainingSteps,
        rewoundPromptPreview,
      };
    } catch {
      return { ok: false, reason: "db_error" };
    } finally {
      summaryDb?.close();
    }
  }
}

export interface ForkConversationResult {
  conversationId: string;
  parentConversationId: string;
  title: string;
  stepCount: number;
}

export interface RewindConversationResult {
  ok: boolean;
  reason?: "invalid_input" | "not_found" | "cannot_rewind_initial_turn" | "db_error";
  totalTurns?: number;
  conversationId?: string;
  removedTurns?: number;
  removedSteps?: number;
  remainingSteps?: number;
  rewoundPromptPreview?: string;
}

function replaceUuidInBlob(blob: Uint8Array | null | undefined, pairs: Array<[Buffer, Buffer]>): Buffer | null {
  if (!blob || blob.length === 0) return null;
  let buf = Buffer.from(blob);
  let modified = false;
  for (const [search, replacement] of pairs) {
    if (search.length !== replacement.length || search.length === 0) continue;
    let idx = buf.indexOf(search);
    while (idx !== -1) {
      replacement.copy(buf, idx);
      modified = true;
      idx = buf.indexOf(search, idx + search.length);
    }
  }
  return modified ? buf : null;
}

export function extractCleanUserPrompt(rawText: string): string | undefined {
  if (!rawText) return undefined;
  const tagMatch = rawText.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const candidate = tagMatch ? tagMatch[1] : rawText;
  const printable = candidate
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!printable) return undefined;
  return printable.length > 80 ? `${printable.slice(0, 79)}…` : printable;
}

