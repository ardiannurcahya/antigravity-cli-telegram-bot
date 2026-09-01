import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../context.js";
import { controllerKey } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { modelLabel } from "../models.js";
import type { QueueJob } from "../queue.js";
import { escapeHtml, findReferencedMediaFiles } from "../telegram.js";
import { formatStepUpdate, runAgy } from "../agy-runner.js";
import { parseContext, parseCredits, parseUsageQuota, runPtyCommand } from "../pty-runner.js";
import { settingsFor } from "../domain/settings.js";
import { addUsage } from "../domain/usage-math.js";
import { reply, replyWithFormattedResponse, replyWithHtml } from "../ui/reply.js";
import { usageText } from "../ui/messages.js";
import { clearSentImagePaths, detectAndSendGeneratedImages } from "./image-detection.js";
import { generateShortTopicName } from "../domain/topic-namer.js";
import { parseChatTarget } from "../telegram/client.js";
import type { StreamEvent } from "../types.js";

type PtyReportKind = "usage" | "credits" | "context";

interface PtyReportSpec {
  ptyCommand: "/usage" | "/credits" | "/context";
  startingMessage: string;
  doneMessage: string;
  errorPrefix: string;
  format: (rawOutput: string) => string;
  conversationId?: (session: { conversationId?: string } | null) => string | undefined;
  missingConversationMessage?: string;
}

const PTY_REPORTS: Record<PtyReportKind, PtyReportSpec> = {
  usage: {
    ptyCommand: "/usage",
    startingMessage: "Checking AGY models & quota via PTY...",
    doneMessage: "Quota check complete.",
    errorPrefix: "Could not read AGY quota:",
    format: parseUsageQuota,
  },
  credits: {
    ptyCommand: "/credits",
    startingMessage: "Checking AGY credits via PTY...",
    doneMessage: "Credits check complete.",
    errorPrefix: "Could not read AGY credits:",
    format: parseCredits,
  },
  context: {
    ptyCommand: "/context",
    startingMessage: "Reading Active Context from the current AGY conversation via PTY...",
    doneMessage: "Active Context check complete.",
    errorPrefix: "Could not read Active Context:",
    format: parseContext,
    conversationId: (session) => session?.conversationId,
    missingConversationMessage: "No active AGY conversation. Resume or start a conversation first.",
  },
};

async function runPtyReportJob(context: AppContext, job: QueueJob & { kind: PtyReportKind }, controller: AbortController, isCancelled: () => boolean): Promise<void> {
  const spec = PTY_REPORTS[job.kind];
  let progressMessage: { message_id: number } | null = null;
  try {
    const session = context.state.session(job.chatId);
    if (spec.missingConversationMessage && !spec.conversationId?.(session)) {
      await reply(context, job.chatId, spec.missingConversationMessage, createMainKeyboard(settingsFor(context, job.chatId)));
      return;
    }
    await context.telegram.sendChatAction(job.chatId);
    progressMessage = await context.telegram.sendMessage(job.chatId, spec.startingMessage);
    const output = await runPtyCommand(context.config.agy, spec.ptyCommand, {
      conversationId: spec.conversationId?.(session),
      timeoutMs: 15_000,
      signal: controller.signal,
    });
    if (isCancelled()) return;
    const formatted = spec.format(output);
    if (progressMessage) await context.telegram.editMessageText(job.chatId, progressMessage.message_id, spec.doneMessage).catch(() => undefined);
    await replyWithHtml(context, job.chatId, formatted, createMainKeyboard(settingsFor(context, job.chatId)));
  } catch (error) {
    if (!isCancelled()) {
      const errorMsg = (error as Error).message;
      if (progressMessage) await context.telegram.editMessageText(job.chatId, progressMessage.message_id, `${spec.errorPrefix} ${errorMsg}`).catch(() => undefined);
      await reply(context, job.chatId, `${spec.errorPrefix} ${errorMsg}`, createMainKeyboard(settingsFor(context, job.chatId)));
    }
  }
}

export async function runPromptJob(context: AppContext, job: QueueJob, isCancelled: () => boolean): Promise<void> {
  const controller = new AbortController();
  context.controllers.set(controllerKey("prompt", job.chatId), controller);
  let progressMessage: { message_id: number } | null = null;

  if (job.kind === "usage" || job.kind === "credits" || job.kind === "context") {
    await runPtyReportJob(context, job as QueueJob & { kind: PtyReportKind }, controller, isCancelled);
    context.controllers.delete(controllerKey("prompt", job.chatId));
    return;
  }

  let lastProgressAt = 0;
  let responseDraft = "";
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let typingInterval: NodeJS.Timeout | null = null;
  let isEditing = false;
  let pendingEditContent: string | null = null;
  let disableProgressEdits = false;
  let progressTimeout: NodeJS.Timeout | null = null;
  try {
    await context.telegram.sendChatAction(job.chatId);
    typingInterval = setInterval(() => {
      context.telegram.sendChatAction(job.chatId).catch(() => undefined);
    }, 4000);
    const session = context.state.session(job.chatId);
    const settings = settingsFor(context, job.chatId);
    progressMessage = await context.telegram.sendMessage(job.chatId, `⏳ AGY is starting... (${modelLabel(settings.model)})`);
    const startedAt = Date.now();
    const recentSteps: string[] = [];

    const flushProgress = async (): Promise<void> => {
      if (isEditing || !progressMessage || disableProgressEdits || !pendingEditContent) return;
      if (Date.now() - lastProgressAt < 4500) {
        if (!progressTimeout && !disableProgressEdits) {
          const delay = Math.max(500, 4500 - (Date.now() - lastProgressAt));
          progressTimeout = setTimeout(() => {
            progressTimeout = null;
            void flushProgress();
          }, delay);
        }
        return;
      }

      const content = pendingEditContent;
      pendingEditContent = null;
      isEditing = true;
      lastProgressAt = Date.now();

      try {
        await context.telegram.editMessageText(job.chatId, progressMessage.message_id, content);
      } catch (err) {
        if (err instanceof Error && (err.message.includes("429") || err.message.includes("Too Many Requests") || err.message.includes("Bad Request"))) {
          disableProgressEdits = true;
        }
      } finally {
        isEditing = false;
        if (pendingEditContent && !disableProgressEdits && !progressTimeout) {
          progressTimeout = setTimeout(() => {
            progressTimeout = null;
            void flushProgress();
          }, 4500);
        }
      }
    };

    const updateProgress = (stepDesc: string | null): void => {
      if (!progressMessage || disableProgressEdits) return;
      if (stepDesc && !recentSteps.includes(stepDesc)) {
        recentSteps.push(stepDesc);
        if (recentSteps.length > 4) recentSteps.shift();
      }

      const verbose = settings.verbose || "detailed";
      if (verbose === "silent") return;

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      const stepsDisplay = recentSteps.map((s, idx) => {
        const isLatest = idx === recentSteps.length - 1;
        return `${isLatest ? "➜" : "✓"} ${s}`;
      });
      const body = stepsDisplay.length ? `\n\n${stepsDisplay.join("\n")}` : "\n\nInitializing...";
      pendingEditContent = `⏳ AGY is working... (${elapsed}s · ${modelLabel(settings.model)})${body}`;

      void flushProgress();
    };

    let lastEventReceivedAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (isCancelled() || controller.signal.aborted) return;
      const idleSec = Math.floor((Date.now() - lastEventReceivedAt) / 1000);
      if (idleSec >= 6) {
        updateProgress(null);
      }
    }, 6000);

    const progressTicker = setInterval(() => {
      updateProgress(null);
    }, 6000);

    let result;
    try {
      await context.state.setInFlight(job.chatId, {
        prompt: job.prompt,
        kind: job.kind,
        imagePath: job.imagePath,
        documentPath: job.documentPath,
        documentName: job.documentName,
        startedAt: Date.now(),
      });
      result = await runAgy(context.config.agy, job.prompt || "", session?.conversationId || null, {
        ...settings,
        signal: controller.signal,
        imagePath: job.imagePath,
        documentPath: job.documentPath,
        documentName: job.documentName,
        onEvent: (event: StreamEvent) => {
          lastEventReceivedAt = Date.now();
          const step = event.step_update as Record<string, unknown> | undefined;
          const update = formatStepUpdate(step);
          updateProgress(update);
        },
      });
    } finally {
      disableProgressEdits = true;
      pendingEditContent = null;
      if (progressTimeout) {
        clearTimeout(progressTimeout);
        progressTimeout = null;
      }
      clearInterval(progressTicker);
      clearInterval(heartbeatTimer);
      await context.state.clearInFlight(job.chatId);
    }
    if (isCancelled() || controller.signal.aborted) {
      if (progressMessage) await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      return;
    }
    const latestSession = context.state.session(job.chatId);
    const lastRun = { model: result.model || settings.model, usage: result.usage, durationMs: result.durationMs, numTurns: result.numTurns, toolCalls: result.toolCalls, status: result.status || "SUCCESS", completedAt: new Date().toISOString() };
    const effectiveConvId = result.conversationId || session?.conversationId;
    const initialTitle = (job.prompt ? job.prompt.replace(/\s+/g, " ").slice(0, 60).trim() : "") || "Conversation";
    const convTitle = latestSession?.conversationTitle || initialTitle;
    const stepCount = (latestSession?.conversationStepCount || 0) + (result.numTurns || 1);

    let topicRenamed = latestSession?.topicRenamed || false;
    const target = parseChatTarget(job.chatId);
    if (target.messageThreadId && !topicRenamed) {
      const shortTopicName = generateShortTopicName(job.prompt || "", result.text);
      if (shortTopicName) {
        try {
          const ok = await context.telegram.editForumTopic(target.chatId, target.messageThreadId, shortTopicName);
          if (ok) topicRenamed = true;
        } catch (err) {
          console.warn("[prompt-job] Failed to rename forum topic %s: %s", String(target.messageThreadId), (err as Error).message);
        }
      }
    }

    await context.state.setSession(job.chatId, {
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      conversationTitle: convTitle,
      conversationStepCount: stepCount,
      conversationLastModifiedAt: Date.now(),
      topicRenamed,
      settings: latestSession?.settings || settings,
      lastRun,
      usageTotals: addUsage(latestSession?.usageTotals, result.usage),
      updatedAt: new Date().toISOString(),
    });

    if (effectiveConvId) {
      context.convDb.upsertConversation({
        conversation_id: effectiveConvId,
        preview: convTitle,
        title: convTitle,
        step_count: stepCount,
        last_modified_time: Date.now(),
        project_id: settings.project || "default-cli-project",
        workspace_uris: `["file://${context.config.agy.workspace}"]`,
      });
    }

    if (progressMessage) {
      const mode = context.config.telegram.progressMode || "full";
      if (mode === "delete") {
        await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      } else if (mode === "compact") {
        const duration = ((result.durationMs || Date.now() - startedAt) / 1000).toFixed(1);
        const tokens = result.usage?.total_tokens ? ` · ${result.usage.total_tokens.toLocaleString()} tok` : "";
        await context.telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          `⚡ ${duration}s${tokens} · ${modelLabel(result.model || settings.model)}`
        ).catch(() => undefined);
      } else {
        const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
        const usageBlock = usageText(result.usage, result.model || settings.model);
        await context.telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          `AGY completed in ${duration}s.\nModel: ${modelLabel(result.model || settings.model)}\n${usageBlock}`
        ).catch(() => undefined);
      }
    }
    await detectAndSendGeneratedImages(context, job.chatId, result, effectiveConvId, startedAt);
    const mediaFiles = await findReferencedMediaFiles(result.text, context.config.agy.workspace);
    for (const mediaPath of mediaFiles) {
      const ext = path.extname(mediaPath).toLowerCase();
      const isPhoto = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
      try {
        if (isPhoto) {
          await context.telegram.sendPhoto(job.chatId, mediaPath);
        } else {
          await context.telegram.sendDocumentFile(job.chatId, mediaPath);
        }
      } catch (error) {
        console.error(`Failed to send media file ${mediaPath}: ${(error as Error).message}`);
      } finally {
        if (mediaPath.startsWith(os.tmpdir()) || mediaPath.startsWith("/tmp/")) {
          await fs.unlink(mediaPath).catch(() => undefined);
        }
      }
    }

    if (result.text.length > context.config.telegram.maxMessageChars * 2) await context.telegram.sendDocument(job.chatId, `agy-${job.id}.md`, result.text);
    else await replyWithFormattedResponse(context, job.chatId, result.text, createMainKeyboard(settingsFor(context, job.chatId)));
  } catch (error) {
    if (isCancelled() || controller.signal.aborted || (error instanceof Error && error.message.includes("cancelled"))) {
      if (progressMessage) await context.telegram.editMessageText(job.chatId, progressMessage.message_id, "⛔ Request cancelled by user.").catch(() => undefined);
    } else {
      if (progressMessage) await context.telegram.editMessageText(job.chatId, progressMessage.message_id, `AGY failed: ${(error as Error).message}`).catch(() => undefined);
      await reply(context, job.chatId, `AGY failed: ${(error as Error).message}`, createMainKeyboard(settingsFor(context, job.chatId))).catch((err) => {
        console.error(`[processJob] Failed to send error message to ${job.chatId}:`, (err as Error).message);
      });
    }
  } finally {
    disableProgressEdits = true;
    pendingEditContent = null;
    if (progressTimeout) {
      clearTimeout(progressTimeout);
      progressTimeout = null;
    }
    if (typingInterval) clearInterval(typingInterval);
    clearInterval(heartbeatTimer);
    context.controllers.delete(controllerKey("prompt", job.chatId));
    clearSentImagePaths(job.chatId);
    if (job.imagePath) {
      await fs.unlink(job.imagePath).catch(() => undefined);
    }
    if (job.documentPath) {
      await fs.unlink(job.documentPath).catch(() => undefined);
    }
  }
}
