import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../src/context.js";
import { loadConfig } from "../../src/config.js";
import { ConversationDatabase } from "../../src/db.js";
import { JobQueue, type QueueJob } from "../../src/queue.js";
import { StateStore } from "../../src/state.js";
import type { AppConfig, InFlightJob, TelegramUpdate } from "../../src/types.js";
import { FakeTelegramClient } from "./fake-telegram.js";

export interface TestServices {
  config: AppConfig;
  state: StateStore;
  convDb: ConversationDatabase;
  telegram: FakeTelegramClient;
  queue: JobQueue;
  controllers: Map<string, AbortController>;
  pendingDangerousCommands: Map<string, string[]>;
  pendingInterruptedJobs: Map<string, InFlightJob>;
}

const BASE_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_ALLOWED_USER_IDS: "111,222",
  TELEGRAM_ALLOWED_CHAT_IDS: "",
  AGY_WORKSPACE: "",
  AGY_BIN: "/bin/echo",
  AGY_DB_PATH: "",
  STATE_FILE: "",
  TEMP_DIR: "",
};

export interface Harness extends TestServices {
  /** Jobs captured by the queue worker instead of spawning real processes. */
  capturedJobs: Array<QueueJob & { resolve: () => void; promise: Promise<void> }>;
  /** Replace the worker behaviour for advanced queue scenarios. */
  setWorker: (worker: (job: QueueJob, isCancelled: () => boolean) => Promise<void>) => void;
  cleanup: () => void;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-refactor-"));
}

function configFor(env: Record<string, string>, dir: string): AppConfig {
  return loadConfig({
    ...BASE_ENV,
    AGY_WORKSPACE: path.join(dir, "workspace"),
    AGY_DB_PATH: path.join(dir, "conversation_summaries.db"),
    STATE_FILE: path.join(dir, "state.json"),
    TEMP_DIR: path.join(dir, "tmp"),
    ...env,
  });
}

/**
 * Builds a fully wired in-memory service graph with a fake Telegram transport
 * and a queue worker that captures jobs (no child process is ever spawned).
 */
export function createHarness(env: Record<string, string> = {}): Harness {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
  const config = configFor(env, dir);
  const state = new StateStore(config.stateFile);
  const convDb = new ConversationDatabase(config.agy.dbPath);
  const telegram = new FakeTelegramClient();
  const controllers = new Map<string, AbortController>();
  const pendingDangerousCommands = new Map<string, string[]>();
  const pendingInterruptedJobs = new Map<string, InFlightJob>();
  const capturedJobs: Harness["capturedJobs"] = [];

  let currentWorker: (job: QueueJob, isCancelled: () => boolean) => Promise<void> = (job, isCancelled) =>
    new Promise<void>((resolve) => {
      const entry = Object.assign({}, job, {
        resolve,
        promise: Promise.resolve(),
      }) as Harness["capturedJobs"][number];
      capturedJobs.push(entry);
      const poll = setInterval(() => {
        if (isCancelled()) {
          clearInterval(poll);
          resolve();
        }
      }, 2);
      poll.unref?.();
    });

  const queue = new JobQueue(config.queue.maxSize, (job, isCancelled) => currentWorker(job, isCancelled));

  return {
    config,
    state,
    convDb,
    telegram,
    queue,
    controllers,
    pendingDangerousCommands,
    pendingInterruptedJobs,
    capturedJobs,
    setWorker(worker) {
      currentWorker = worker;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The fake client structurally matches TelegramClient; cast for AppContext wiring. */
export function asAppContext(harness: Harness): AppContext {
  return harness as unknown as AppContext;
}

/** A TelegramUpdate carrying a text message from an allowed user. */
export function textUpdate(chatId: number, text: string, userId = 111): TelegramUpdate {
  return {
    update_id: Date.now(),
    message: {
      message_id: Math.floor(Math.random() * 100000),
      chat: { id: chatId, type: "private" },
      from: { id: userId },
      text,
    },
  };
}

export function callbackUpdate(data: string, chatId = 777, messageId = 42, userId = 111): NonNullable<TelegramUpdate["callback_query"]> {
  return {
    id: `cb-${Math.random()}`,
    from: { id: userId },
    data,
    message: { message_id: messageId, chat: { id: chatId, type: "private" }, from: { id: userId } },
  };
}
