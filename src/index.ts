#!/usr/bin/env node
import dns from "node:dns";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "./config.js";
import { ConversationDatabase } from "./db.js";
import { StateStore } from "./state.js";
import { TelegramClient } from "./telegram.js";
import { acquireInstanceLock, releaseInstanceLock } from "./infra/instance-lock.js";
import { createAppServices, createBot } from "./bot.js";
import { warmupWhisperLocal } from "./stt/stt-service.js";

dns.setDefaultResultOrder?.("ipv4first");

const config = loadConfig();

const instanceLockPath = path.join(path.dirname(config.stateFile), "agy-telegram.lock");
const lock = acquireInstanceLock(instanceLockPath);
if (!lock.acquired) {
  console.error(
    lock.holderPid
      ? `[lock] Another agy-telegram instance is already running (PID ${lock.holderPid}). Stop it first: systemctl stop agy-telegram`
      : `[lock] Could not acquire instance lock at ${instanceLockPath}`
  );
  process.exit(1);
}

const state = new StateStore(config.stateFile);
await state.load();
const services = createAppServices({
  config,
  state,
  convDb: new ConversationDatabase(config.agy.dbPath),
  telegram: new TelegramClient(config.telegram.token),
});

if (config.stt?.provider === "whisper-local") {
  void warmupWhisperLocal(config);
}

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught Exception:", error);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    releaseInstanceLock(instanceLockPath);
    process.exit(0);
  });
}

await createBot(services).start();
