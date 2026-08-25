import type { ConversationDatabase } from "./db.js";
import type { JobQueue } from "./queue.js";
import type { StateStore } from "./state.js";
import type { TelegramClient } from "./telegram.js";
import type { AppConfig, ChatId, InFlightJob } from "./types.js";

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
  readonly pendingInterruptedJobs: Map<string, InFlightJob>;
}

export interface BaseServices {
  config: AppConfig;
  state: StateStore;
  convDb: ConversationDatabase;
  telegram: TelegramClient;
}

export function controllerKey(scope: "prompt" | "custom", chatId: ChatId): string {
  return `${scope}:${chatId}`;
}
