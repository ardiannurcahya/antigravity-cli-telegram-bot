import os from "node:os";
import path from "node:path";
import { resolveEffectiveDbPath } from "./db.js";
import { DEFAULT_MODELS } from "./models.js";
import type { AppConfig } from "./types.js";

function resolvePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return path.join(os.homedir() || process.env.HOME || "/var/lib/agybot", trimmed.slice(trimmed === "~" ? 1 : 2));
  }
  return trimmed;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedUserIds = numericCsvFrom(env, "TELEGRAM_ALLOWED_USER_IDS");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (allowedUserIds.length === 0) throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one ID");
  const workspace = (env.AGY_WORKSPACE || "/srv/agy-workspaces/default").trim();
  if (!path.isAbsolute(workspace)) throw new Error("AGY_WORKSPACE must be absolute");
  const mode = (env.AGY_MODE || "plan").trim();
  if (!isMode(mode)) throw new Error("AGY_MODE must be plan or accept-edits");
  const effort = (env.AGY_EFFORT || "high").trim();
  if (!isEffort(effort)) throw new Error("AGY_EFFORT must be low, medium, or high");
  const allowedModels = modelsFrom(env);
  const model = (env.AGY_MODEL || "").trim();
  if (model && !allowedModels.includes(model)) throw new Error(`AGY_MODEL is not in AGY_ALLOWED_MODELS: ${model}`);
  const dbPath = resolveEffectiveDbPath(env.AGY_DB_PATH);
  return {
    telegram: {
      token, allowedUserIds, allowedChatIds: numericCsvFrom(env, "TELEGRAM_ALLOWED_CHAT_IDS"),
      privateOnly: booleanFrom(env, "TELEGRAM_PRIVATE_ONLY", true),
      maxMessageChars: positiveIntegerFrom(env, "TELEGRAM_MAX_MESSAGE_CHARS", 3900),
      progressMode: progressModeFrom(env),
      verbose: verboseFrom(env),
      allowBotUpdate: booleanFrom(env, "ALLOW_BOT_UPDATE", booleanFrom(env, "TELEGRAM_ALLOW_BOT_UPDATE", false)),
      autoInterrupt: booleanFrom(env, "TELEGRAM_AUTO_INTERRUPT", false),
    },
    agy: {
      bin: (env.AGY_BIN || "/root/.local/bin/agy").trim(), workspace, project: (env.AGY_PROJECT || "").trim(), mode,
      sandbox: booleanFrom(env, "AGY_SANDBOX", false), allowSandboxDisable: booleanFrom(env, "AGY_ALLOW_SANDBOX_DISABLE", true),
      model, effort, allowedModels, timeoutMs: positiveIntegerFrom(env, "AGY_TIMEOUT_MS", 1_800_000),
      maxOutputBytes: positiveIntegerFrom(env, "AGY_MAX_OUTPUT_BYTES", 20_000_000),
      agent: (env.AGY_AGENT || "").trim() || undefined,
      allowDangerouslySkipPermissions: booleanFrom(env, "AGY_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS", false),
      dbPath,
    },
    queue: { maxSize: positiveIntegerFrom(env, "MAX_QUEUE_SIZE", 8) },
    stateFile: (env.STATE_FILE || "/var/lib/agy-telegram/state.json").trim(),
    tempDir: (env.TEMP_DIR || "/var/lib/agy-telegram/tmp").trim(), logLevel: (env.LOG_LEVEL || "info").trim(),
    envFile: (env.ENV_FILE || env.AGY_ENV_FILE || path.join(os.homedir() || process.env.HOME || "/var/lib/agybot", ".config/agy-telegram/.env")).trim(),
  };
}

export function isMode(value: string): value is "plan" | "accept-edits" { return value === "plan" || value === "accept-edits"; }
export function isEffort(value: string): value is "low" | "medium" | "high" { return value === "low" || value === "medium" || value === "high"; }
export function isVerbose(value: string): value is "silent" | "compact" | "detailed" { return value === "silent" || value === "compact" || value === "detailed"; }

function modelsFrom(env: Record<string, string | undefined>): string[] {
  const configured = (env.AGY_ALLOWED_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean);
  const ids = configured.length ? configured : DEFAULT_MODELS.map((model) => model.id);
  const known = new Set(DEFAULT_MODELS.map((model) => model.id));
  for (const id of ids) if (!known.has(id)) throw new Error(`AGY_ALLOWED_MODELS contains unsupported model: ${id}`);
  return ids;
}

function numericCsvFrom(env: Record<string, string | undefined>, name: string): string[] {
  return (env[name] || "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
    if (!/^-?\d+$/.test(value)) throw new Error(`${name} must contain numeric Telegram IDs`);
    return value;
  });
}

function positiveIntegerFrom(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function booleanFrom(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean value`);
}

function progressModeFrom(env: Record<string, string | undefined>): "full" | "compact" | "delete" {
  const raw = env.TELEGRAM_PROGRESS_MODE?.trim().toLowerCase();
  if (!raw) return "full";
  if (["delete", "remove", "off", "none", "clean"].includes(raw)) return "delete";
  if (["compact", "short", "simple", "minimal", "1line"].includes(raw)) return "compact";
  if (["full", "verbose", "all", "on"].includes(raw)) return "full";
  throw new Error(`TELEGRAM_PROGRESS_MODE must be 'delete', 'compact', or 'full' (received: ${raw})`);
}

function verboseFrom(env: Record<string, string | undefined>): "silent" | "compact" | "detailed" {
  const raw = (env.TELEGRAM_VERBOSE || env.AGY_VERBOSE)?.trim().toLowerCase();
  if (!raw) return "detailed";
  if (["silent", "quiet", "off", "none", "minimal", "low"].includes(raw)) return "silent";
  if (["compact", "simple", "medium", "normal", "1line"].includes(raw)) return "compact";
  if (["detailed", "verbose", "full", "high", "all", "on"].includes(raw)) return "detailed";
  throw new Error(`TELEGRAM_VERBOSE must be 'silent', 'compact', or 'detailed' (received: ${raw})`);
}

