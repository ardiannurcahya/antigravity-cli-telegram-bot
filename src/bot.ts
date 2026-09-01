import fs from "node:fs/promises";
import path from "node:path";
import { JobQueue } from "./queue.js";
import { createMainKeyboard } from "./keyboards.js";
import { escapeHtml } from "./telegram.js";
import type { AppContext, BaseServices } from "./context.js";
import { controllerKey } from "./context.js";
import { settingsFor } from "./domain/settings.js";
import { refreshModels } from "./usecases/model-selection.js";
import { enqueueJob } from "./usecases/enqueue.js";
import { runPromptJob } from "./usecases/prompt-job.js";
import { restartNoticePath } from "./usecases/self-update.js";
import { handleUpdate } from "./router/updates.js";
import { cleanupStaleTempFiles } from "./usecases/session-cleanup.js";
import type { TelegramUpdate } from "./types.js";

/**
 * Completes the service graph: creates the job queue wired to the prompt use
 * case and the cancellation hook that aborts in-flight AGY processes.
 */
export function createAppServices(base: BaseServices): AppContext {
  const services = { ...base, controllers: new Map<string, AbortController>(), pendingDangerousCommands: new Map<string, string[]>() } as AppContext;
  const queue = new JobQueue(base.config.queue.maxSize, (job, isCancelled) => runPromptJob(services, job, isCancelled), {
    maxConcurrent: 4,
    onCancel: (chatId) => {
      services.controllers.get(controllerKey("prompt", chatId))?.abort();
      services.controllers.get(controllerKey("custom", chatId))?.abort();
    },
  });
  services.queue = queue;
  return services;
}

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "menu", description: "Show the bottom control keyboard" },
  { command: "new", description: "Start a new AGY conversation" },
  { command: "resume", description: "Resume previous conversation from database" },
  { command: "usage", description: "Check live models & quota via PTY" },
  { command: "credits", description: "Check live AGY credits via PTY" },
  { command: "context", description: "Show active context for current conversation" },
  { command: "tokens", description: "Show token usage and turns" },
  { command: "quota", description: "Alias for /usage" },
  { command: "status", description: "Show current job status" },
  { command: "cancel", description: "Cancel the active or queued job" },
  { command: "model", description: "Show or choose the model" },
  { command: "effort", description: "Show or change reasoning effort" },
  { command: "mode", description: "Show or change plan/edit mode" },
  { command: "sandbox", description: "Show or change sandbox mode" },
  { command: "verbose", description: "Show or change verbose level (detailed, compact, silent)" },
  { command: "session", description: "Show session settings" },
  { command: "learn", description: "Learn reusable rules/skills from recent chat" },
  { command: "compact", description: "Compact context and create state snapshot to save tokens" },
  { command: "help", description: "Show available commands" },
  { command: "agents", description: "List available AGY agents" },
  { command: "agent", description: "Select an AGY agent" },
  { command: "project", description: "Set the AGY project" },
  { command: "add_dir", description: "Add an AGY workspace directory" },
  { command: "output_format", description: "Set AGY output format" },
  { command: "json_schema", description: "Set AGY JSON schema" },
  { command: "log_file", description: "Set AGY log file" },
  { command: "print_timeout", description: "Set AGY print timeout" },
  { command: "continue", description: "Toggle AGY conversation continuation" },
  { command: "new_project", description: "Toggle new AGY project mode" },
  { command: "disable_slash_commands", description: "Toggle AGY slash expansion" },
  { command: "changelog", description: "Show AGY changelog" },
  { command: "plugins", description: "List imported AGY plugins" },
  { command: "cli_help", description: "Show AGY CLI help" },
  { command: "version", description: "Show AGY CLI version" },
  { command: "update", description: "Update Telegram bot from GitHub & restart" },
  { command: "restart", description: "Restart the AGY Telegram service" },
  { command: "agy", description: "Run a custom non-interactive AGY command" },
  { command: "agy_confirm", description: "Confirm a pending AGY command" },
];

export async function announcePendingRestartNotice(context: AppContext): Promise<void> {
  const noticePath = restartNoticePath(context);
  try {
    const noticeRaw = await fs.readFile(noticePath, "utf8");
    const notice = JSON.parse(noticeRaw) as { chatId: string; reason: string; commit?: string };
    await fs.unlink(noticePath).catch(() => undefined);
    if (notice.chatId) {
      if (notice.reason === "update") {
        await context.telegram.sendMessage(
          notice.chatId,
          `🟢 <b>Bot is back online!</b>\n\nUpdate to <code>${escapeHtml(notice.commit || "latest")}</code> completed successfully.`,
          createMainKeyboard(settingsFor(context, notice.chatId)),
          "HTML"
        ).catch(() => undefined);
      } else {
        await context.telegram.sendMessage(
          notice.chatId,
          `🟢 <b>AGY Gateway online!</b>\n\nService restarted successfully and ready to use.`,
          createMainKeyboard(settingsFor(context, notice.chatId)),
          "HTML"
        ).catch(() => undefined);
      }
    }
  } catch {
    // No pending restart notice
  }
}

export async function resumeInterruptedJobs(context: AppContext): Promise<void> {
  const interrupted = { ...context.state.inFlight };
  if (Object.keys(interrupted).length > 0) {
    await context.state.clearAllInFlight();
    for (const [chatId, job] of Object.entries(interrupted)) {
      if (job.prompt || job.kind === "usage" || job.kind === "credits" || job.kind === "context") {
        const promptSnippet = job.prompt ? ` (Prompt: <i>"${escapeHtml(job.prompt.slice(0, 60))}${job.prompt.length > 60 ? "..." : ""}"</i>)` : "";
        await context.telegram.sendMessage(
          chatId,
          `⚡ <b>AGY Gateway restarted</b>\n\nYour previous request was interrupted by a restart${promptSnippet}.\n<i>Resuming execution now...</i>`,
          createMainKeyboard(settingsFor(context, chatId)),
          "HTML"
        ).catch(() => undefined);

        enqueueJob(context, chatId, {
          kind: job.kind || "prompt",
          prompt: job.prompt,
          imagePath: job.imagePath,
          documentPath: job.documentPath,
          documentName: job.documentName,
          mediaPath: job.mediaPath,
          mediaType: job.mediaType,
        });
      } else {
        await context.telegram.sendMessage(
          chatId,
          `⚡ <b>AGY Gateway restarted</b>\n\nI am back online and ready for your next command!`,
          createMainKeyboard(settingsFor(context, chatId)),
          "HTML"
        ).catch(() => undefined);
      }
    }
  }
}

/** Handles a batch of updates, guaranteeing the offset advances even when an individual update fails. */
export async function processUpdates(context: AppContext, updates: TelegramUpdate[]): Promise<void> {
  for (const update of updates) {
    try {
      await handleUpdate(context, update);
    } catch (updateErr) {
      console.error("[polling] handleUpdate error:", updateErr);
    } finally {
      await context.state.setOffset(update.update_id + 1);
    }
  }
}

export function createBot(context: AppContext): { start(): Promise<void>; handleUpdate(update: TelegramUpdate): Promise<void> } {
  async function start(): Promise<void> {
    console.log(`agy-telegram started; workspace=${context.config.agy.workspace}; privateOnly=${context.config.telegram.privateOnly}`);
    await cleanupStaleTempFiles(context.config.tempDir).catch((err) => console.error(`cleanupStaleTempFiles failed: ${(err as Error).message}`));
    await refreshModels(context).catch((error) => console.error(`refreshModels failed: ${(error as Error).message}`));
    await context.telegram.setMyCommands(BOT_COMMANDS).catch((error: unknown) => console.error(`setMyCommands failed: ${(error as Error).message}`));

    // 1. Process pending restart / update notices
    await announcePendingRestartNotice(context);

    // 2. Check for interrupted in-flight jobs
    await resumeInterruptedJobs(context);

    while (true) {
      try {
        const updates = await context.telegram.getUpdates(context.state.offset);
        await processUpdates(context, updates);
      } catch (error) {
        console.error(`[polling] polling error: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  return {
    start,
    handleUpdate: (update: TelegramUpdate) => handleUpdate(context, update),
  };
}
