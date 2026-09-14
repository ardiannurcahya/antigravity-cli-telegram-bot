import type { AppContext } from "../context.js";
import type { QueueJob } from "../queue.js";
import type { AgyResult, ChatId, StreamEvent } from "../types.js";
import { settingsFor } from "../domain/settings.js";
import { formatTokenCount } from "../domain/usage-math.js";
import { formatStepUpdate, runAgy } from "../agy-runner.js";
import { cleanupSessionTempFiles } from "./session-cleanup.js";
import { createMainKeyboard } from "../keyboards.js";
import { reply, replyWithHtml, replyWithFormattedResponse } from "../ui/reply.js";
import { escapeHtml } from "../telegram.js";
import { getActiveModels } from "../models.js";

function createCompactionProgressReporter(
  context: AppContext,
  chatId: ChatId,
  progressMessage: { message_id: number } | null
) {
  let isEditing = false;
  let lastEditAt = 0;
  let timer: NodeJS.Timeout | null = null;
  let currentStageText = "";
  let currentDetail = "";
  let startedAt = Date.now();
  let stopped = false;

  const flush = async () => {
    if (!progressMessage || stopped) return;
    const now = Date.now();
    if (now - lastEditAt < 4000) {
      if (!timer && !stopped) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, Math.max(500, 4000 - (now - lastEditAt)));
      }
      return;
    }
    if (isEditing) return;
    isEditing = true;
    lastEditAt = now;
    const elapsed = Math.floor((now - startedAt) / 1000);
    const detail = currentDetail ? ` · ${escapeHtml(currentDetail)}` : "";
    const text = `${currentStageText} (${elapsed}s${detail})`;
    try {
      await context.telegram.editMessageText(chatId, progressMessage.message_id, text, undefined, "HTML");
    } catch {
      // Ignore transient errors or rate limits
    } finally {
      isEditing = false;
    }
  };

  const ticker = setInterval(() => {
    void flush();
  }, 2500);

  return {
    setStage(stageText: string, detail = "") {
      currentStageText = stageText;
      currentDetail = detail;
      startedAt = Date.now();
      void flush();
    },
    setDetail(detail: string) {
      currentDetail = detail;
      void flush();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      clearInterval(ticker);
    },
  };
}

/**
 * Executes orchestrator-level 3-phase context compaction:
 * 1. Handover Snapshot Synthesis (in-session extraction)
 * 2. Automated Clean Reset (preserves workspace & settings, resets context to 0)
 * 3. Seamless Re-hydration (seeds new conversation turn with the handover note)
 */
export async function runCompactionJob(
  context: AppContext,
  job: QueueJob,
  controller: AbortController,
  isCancelled: () => boolean
): Promise<void> {
  const session = context.state.session(job.chatId);
  if (!session?.conversationId) {
    await reply(
      context,
      job.chatId,
      "No active AGY conversation to compact. Start or resume a conversation first.",
      createMainKeyboard(settingsFor(context, job.chatId))
    );
    return;
  }

  const originalSession = {
    ...session,
    settings: { ...session.settings },
  };

  let progressMessage: { message_id: number } | null = null;
  let reporter: ReturnType<typeof createCompactionProgressReporter> | null = null;
  const settings = settingsFor(context, job.chatId);
  const effectiveWorkspace = settings.workspace || context.config.agy.workspace;
  const effectiveAgyConfig = effectiveWorkspace === context.config.agy.workspace
    ? context.config.agy
    : { ...context.config.agy, workspace: effectiveWorkspace };

  try {
    await context.telegram.sendChatAction(job.chatId);
    progressMessage = await context.telegram.sendMessage(
      job.chatId,
      "⏳ <b>Compacting context:</b> generating task snapshot...",
      undefined,
      "HTML"
    );
    reporter = createCompactionProgressReporter(context, job.chatId, progressMessage);
    reporter.setStage("⏳ <b>Compacting context:</b> generating task snapshot...");

    // Phase 1: Handover Snapshot Synthesis
    const focusArea = job.prompt?.trim();
    const synthesisPrompt = [
      "Synthesize our active task state for a handover snapshot:",
      "1. Current Objective & Scope",
      "2. Modified Files & Key Decisions made",
      "3. Pending Next Steps",
      focusArea ? `\nFocus area requested: ${focusArea}` : "",
      "\nFormat concisely in Markdown. Discard historical intermediate tool outputs and debugging logs.",
    ].filter(Boolean).join("\n");

    let snapshotResult: AgyResult;
    try {
      snapshotResult = await runAgy(
        effectiveAgyConfig,
        synthesisPrompt,
        session.conversationId,
        {
          ...settings,
          signal: controller.signal,
          onEvent: (event: StreamEvent) => {
            const step = event.step_update as Record<string, unknown> | undefined;
            const update = formatStepUpdate(step);
            if (update) reporter?.setDetail(update);
          },
        }
      );
    } catch (error) {
      reporter?.stop();
      if (isCancelled() || controller.signal.aborted) {
        if (progressMessage) await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
        return;
      }
      // Fail-safe abort: preserve existing session intact
      const errorMsg = (error as Error).message;
      if (progressMessage) {
        await context.telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          `⚠️ <b>Compaction aborted:</b> failed to generate task snapshot (${escapeHtml(errorMsg)}).\nCurrent session preserved intact.`,
          undefined,
          "HTML"
        ).catch(() => undefined);
      } else {
        await replyWithHtml(
          context,
          job.chatId,
          `⚠️ <b>Compaction aborted:</b> failed to generate task snapshot (${escapeHtml(errorMsg)}).\nCurrent session preserved intact.`,
          createMainKeyboard(settings)
        );
      }
      return;
    }

    if (isCancelled() || controller.signal.aborted) {
      reporter?.stop();
      if (progressMessage) await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      return;
    }

    const snapshotText = snapshotResult.text?.trim();
    if (!snapshotText) {
      reporter?.stop();
      if (progressMessage) {
        await context.telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          "⚠️ <b>Compaction aborted:</b> model returned an empty snapshot.\nCurrent session preserved intact.",
          undefined,
          "HTML"
        ).catch(() => undefined);
      }
      return;
    }

    const beforeTokens = session.contextTokens
      || (snapshotResult.usage?.input_tokens ? formatTokenCount(snapshotResult.usage.input_tokens) : null)
      || (session.lastRun?.usage?.total_tokens ? formatTokenCount(session.lastRun.usage.total_tokens) : null);

    // Phase 2: Automated Clean Reset preparation
    reporter?.setStage("🔄 <b>Compacting context:</b> preparing clean session reset...");
    const preservedSettings = { ...session.settings };
    const freshSettings = {
      ...preservedSettings,
      continueSession: false,
      newProject: false,
    };

    // Phase 3: Seamless Re-hydration
    reporter?.setStage("⚡ <b>Compacting context:</b> re-hydrating new session...");

    const rehydrationPrompt = [
      "Resuming task from handover snapshot:",
      "",
      snapshotText,
      "",
      "Acknowledge the restored context concisely in 1-2 sentences with the active objective and indicate that you are ready for the user's next instruction.",
      "Do not include any token metrics, context size estimates, or performance statistics in your response.",
      "Do not invoke tools or start executing actions until requested.",
    ].join("\n");

    let rehydrationResult: AgyResult;
    try {
      rehydrationResult = await runAgy(
        effectiveAgyConfig,
        rehydrationPrompt,
        null,
        {
          ...freshSettings,
          signal: controller.signal,
          onEvent: (event: StreamEvent) => {
            const step = event.step_update as Record<string, unknown> | undefined;
            const update = formatStepUpdate(step);
            if (update) reporter?.setDetail(update);
          },
        }
      );
    } catch (error) {
      reporter?.stop();
      // Rollback to original session in case of re-hydration failure
      await context.state.setSession(job.chatId, originalSession);
      const errorMsg = (error as Error).message;
      if (progressMessage) {
        await context.telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          `⚠️ <b>Compaction aborted:</b> re-hydration failed (${escapeHtml(errorMsg)}).\nOriginal session preserved intact.`,
          undefined,
          "HTML"
        ).catch(() => undefined);
      }
      if (snapshotText) {
        await replyWithFormattedResponse(
          context,
          job.chatId,
          `📋 <b>Handover snapshot note:</b>\n\n${escapeHtml(snapshotText)}`
        ).catch(() => undefined);
      }
      return;
    }

    reporter?.stop();

    if (isCancelled() || controller.signal.aborted) {
      // Restore original session when cancelled
      await context.state.setSession(job.chatId, originalSession);
      if (progressMessage) await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      return;
    }

    const newConvId = rehydrationResult.conversationId;
    if (!newConvId) {
      // Abort and rollback if no conversation ID was generated
      await context.state.setSession(job.chatId, originalSession);
      if (progressMessage) {
        await context.telegram.editMessageText(
          job.chatId,
          progressMessage.message_id,
          "⚠️ <b>Compaction aborted:</b> re-hydration did not return a valid conversation ID.\nOriginal session preserved intact.",
          undefined,
          "HTML"
        ).catch(() => undefined);
      }
      return;
    }

    const initialTitle = (snapshotText.split(/\r?\n/).find((l) => l.trim().length > 0) || "Compacted Task")
      .replace(/^[#*\s-]+/, "")
      .slice(0, 60)
      .trim();

    const lastRun = {
      model: rehydrationResult.model || freshSettings.model || null,
      usage: rehydrationResult.usage,
      durationMs: rehydrationResult.durationMs,
      numTurns: rehydrationResult.numTurns,
      toolCalls: rehydrationResult.toolCalls,
      status: rehydrationResult.status || "SUCCESS",
      completedAt: new Date().toISOString(),
    };

    const afterTokensCount = rehydrationResult.usage?.input_tokens ?? rehydrationResult.usage?.total_tokens;
    const afterTokensStr = formatTokenCount(afterTokensCount);
    const maxTokens = getActiveModels().find((m) => m.id === (rehydrationResult.model || freshSettings.model))?.maxContextWindow || 1_000_000;
    const newPercentage = afterTokensCount ? Math.min(100, Math.round((afterTokensCount / maxTokens) * 100)) : undefined;

    // Atomic commit: reset previous session artifacts and activate new conversation
    await cleanupSessionTempFiles(context.config.tempDir, job.chatId);
    await context.state.resetSession(job.chatId, false);
    await context.state.setSession(job.chatId, {
      conversationId: newConvId,
      conversationTitle: initialTitle,
      conversationStepCount: rehydrationResult.numTurns || 1,
      conversationLastModifiedAt: Date.now(),
      settings: freshSettings,
      lastRun,
      usageTotals: rehydrationResult.usage,
      contextTokens: afterTokensStr || undefined,
      contextPercentage: newPercentage,
      updatedAt: new Date().toISOString(),
    });

    context.convDb.upsertConversation({
      conversation_id: newConvId,
      preview: initialTitle,
      title: initialTitle,
      step_count: rehydrationResult.numTurns || 1,
      last_modified_time: Date.now(),
      project_id: freshSettings.project || "default-cli-project",
      workspace_uris: `["file://${effectiveWorkspace}"]`,
    });

    const reductionText = beforeTokens && afterTokensStr ? `from ~${beforeTokens} to ${afterTokensStr} tokens` : "";
    const header = [
      "🗜️ <b>Context compacted successfully</b>",
      reductionText ? `Reduced ${reductionText}` : "",
      "",
      `📌 <b>Active goal:</b> <i>${escapeHtml(initialTitle)}</i>`,
      "➜ Fresh session initialized with full model attention.",
    ].filter(Boolean).join("\n");

    if (progressMessage) {
      await context.telegram.editMessageText(
        job.chatId,
        progressMessage.message_id,
        header,
        undefined,
        "HTML"
      ).catch(() => undefined);
    }
    // Avoid sending ackText separately to keep the chat history clean and prevent visual clutter.
    // The progress message is edited in place with the summary header (active goal and token reduction).
    if (!progressMessage) {
      await replyWithHtml(
        context,
        job.chatId,
        header,
        createMainKeyboard(settingsFor(context, job.chatId))
      ).catch(() => undefined);
    }
  } catch (error) {
    await context.state.setSession(job.chatId, originalSession);
    const errorMsg = (error as Error).message;
    if (progressMessage) {
      await context.telegram.editMessageText(
        job.chatId,
        progressMessage.message_id,
        `⚠️ <b>Compaction error:</b> ${escapeHtml(errorMsg)}\nOriginal session preserved intact.`,
        undefined,
        "HTML"
      ).catch(() => undefined);
    }
  } finally {
    reporter?.stop();
  }
}
