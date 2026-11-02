import type { ConversationDatabase } from "./db.js";
import type { JobQueue } from "./queue.js";
import type { StateStore } from "./state.js";
import type { TelegramClient } from "./telegram.js";
import type { AppConfig, ChatId } from "./types.js";

/**
 * Explicit dependency graph of the running bot. Every handler and use case
 * receives this object instead of reaching for module-level singletons.
 */
export interface AppContext {
  readonly config: AppConfig;
  readonly state: StateStore;
  readonly convDb: ConversationDatabase;
  readonly telegram: TelegramClient;
  queue: JobQueue;
  readonly controllers: Map<string, AbortController>;
  readonly pendingDangerousCommands: Map<string, string[]>;
}

export interface BaseServices {
  config: AppConfig;
  state: StateStore;
  convDb: ConversationDatabase;
  telegram: TelegramClient;
}

export function controllerKey(scope: "prompt" | "custom" | "subagent_poller", chatId: ChatId): string {
  return `${scope}:${chatId}`;
}

/**
 * Checks whether an active AGY turn (prompt, custom command, or queued job) is currently
 * processing for the specified chat.
 */
export function isSessionBusy(context: AppContext, chatId: ChatId): boolean {
  if (context.controllers?.has(controllerKey("prompt", chatId))) return true;
  if (context.controllers?.has(controllerKey("custom", chatId))) return true;
  const status = context.queue?.statusForChat?.(chatId);
  return Boolean(status?.active || (status?.queued ?? 0) > 0);
}

