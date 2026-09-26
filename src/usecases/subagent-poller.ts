import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../context.js";
import { controllerKey } from "../context.js";
import { isWaitingResponseText, runAgy } from "../agy-runner.js";
import { settingsFor } from "../domain/settings.js";
import { addUsage, formatTokenCount } from "../domain/usage-math.js";
import { buildTelemetryQuoteBlock } from "../domain/telemetry.js";
import { createMainKeyboard } from "../keyboards.js";
import { getActiveModels } from "../models.js";
import { parseContextMetrics, parseTokenValue, runPtyCommand } from "../pty-runner.js";
import { findReferencedMediaFiles } from "../telegram.js";
import { replyWithFormattedResponse, replyWithHtml } from "../ui/reply.js";
import { refreshActiveMenu } from "../ui/screens.js";
import { detectAndSendGeneratedImages } from "./image-detection.js";
import type { AgyResult, ChatId, SessionSettings } from "../types.js";

export const PROBE_PROMPT =
  "Please check if the delegated subagent has completed its task. If the results are ready, formulate and provide the complete final response and synthesis for the user. If the subagent is still working and results are not ready yet, reply strictly with '[SUBAGENT_IN_PROGRESS]'.";

export const DEFAULT_POLL_INTERVALS_MS = [10_000, 15_000, 15_000, 20_000, 20_000, 30_000];
export const DEFAULT_MAX_POLL_DURATION_MS = 300_000; // 5 minutes

export interface SubagentPollParams {
  chatId: ChatId;
  conversationId: string;
  subagentRole?: string | null;
  subagentName?: string | null;
  effectiveWorkspace: string;
  settings: Partial<SessionSettings>;
  wasVoiceInput?: boolean;
  pollIntervalsMs?: number[];
  maxDurationMs?: number;
}

/**
 * Inspects Antigravity CLI's internal message directory to see if unread
 * messages from a subagent have been delivered to the conversation inbox.
 */
export function checkForSubagentMessages(dbPath: string, conversationId: string): boolean {
  try {
    const appDataDir = path.dirname(dbPath);
    const messagesDir = path.join(appDataDir, "brain", conversationId, ".system_generated", "messages");
    if (!fs.existsSync(messagesDir)) return false;

    const files = fs.readdirSync(messagesDir);
    let readIds = new Set<string>();
    const readPath = path.join(messagesDir, "read.json");
    if (fs.existsSync(readPath)) {
      try {
        const readData = JSON.parse(fs.readFileSync(readPath, "utf8")) as Record<string, unknown>;
        if (readData && typeof readData === "object") {
          readIds = new Set(Object.keys(readData));
        }
      } catch {
        // Fall back to empty readIds on parse error
      }
    }

    for (const file of files) {
      if (file.endsWith(".json") && file !== "read.json") {
        const msgId = file.slice(0, -5);
        if (!readIds.has(msgId)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Checks whether an AGY probe result indicates the subagent is still working.
 */
export function isStillWaitingTurn(result: AgyResult): boolean {
  if (result.subagentState?.isWaitingTurn) return true;
  const clean = result.text.trim();
  if (clean.includes("[SUBAGENT_IN_PROGRESS]")) return true;
  if (isWaitingResponseText(clean) && clean.length < 500) return true;
  return false;
}

/**
 * Manages background auto-polling for headless subagents (Option 1 RFC #49).
 */
export class SubagentPoller {
  private readonly activePolls = new Map<string, AbortController>();

  /**
   * Starts a background polling loop for the specified chat and conversation.
   */
  public async startPolling(context: AppContext, params: SubagentPollParams): Promise<void> {
    const chatKey = String(params.chatId);
    this.cancelPolling(params.chatId);

    const controller = new AbortController();
    this.activePolls.set(chatKey, controller);
    context.controllers.set(controllerKey("subagent_poller", params.chatId), controller);

    const startedAt = Date.now();
    const intervals = params.pollIntervalsMs || DEFAULT_POLL_INTERVALS_MS;
    const maxDurationMs = params.maxDurationMs || DEFAULT_MAX_POLL_DURATION_MS;

    await context.state.setInFlight(params.chatId, {
      kind: "subagent_poll",
      conversationId: params.conversationId,
      subagentRole: params.subagentRole,
      startedAt,
    });

    await context.state.setSession(params.chatId, {
      pendingSubagentPoll: {
        conversationId: params.conversationId,
        subagentRole: params.subagentRole,
        subagentName: params.subagentName,
        startedAt,
        lastPollAt: startedAt,
        attempts: 0,
      },
    });

    // Execute the polling loop asynchronously without blocking the caller
    void (async () => {
      let attempt = 0;
      let completedSuccessfully = false;

      try {
        while (Date.now() - startedAt < maxDurationMs) {
          if (controller.signal.aborted) break;

          const interval = intervals[Math.min(attempt, intervals.length - 1)];
          const hasMessageEarly = await this.waitForIntervalOrMessage(
            context,
            params.conversationId,
            interval,
            controller.signal
          );

          if (controller.signal.aborted) break;

          attempt++;

          try {
            const effectiveAgyConfig =
              params.effectiveWorkspace === context.config.agy.workspace
                ? context.config.agy
                : { ...context.config.agy, workspace: params.effectiveWorkspace };

            const probeResult = await runAgy(
              effectiveAgyConfig,
              PROBE_PROMPT,
              params.conversationId,
              {
                ...params.settings,
                signal: controller.signal,
              }
            );

            if (controller.signal.aborted) break;

            const stillWaiting = isStillWaitingTurn(probeResult);
            if (!stillWaiting && probeResult.text && probeResult.text.trim()) {
              completedSuccessfully = true;
              await this.deliverFinalResponse(context, params, probeResult);
              break;
            }

            await context.state.setSession(params.chatId, {
              pendingSubagentPoll: {
                conversationId: params.conversationId,
                subagentRole: params.subagentRole,
                subagentName: params.subagentName,
                startedAt,
                lastPollAt: Date.now(),
                attempts: attempt,
              },
            });
          } catch (pollError) {
            if (controller.signal.aborted) break;
            console.warn(`[SubagentPoller] Poll probe attempt ${attempt} failed: ${(pollError as Error).message}`);
          }
        }

        if (!completedSuccessfully && !controller.signal.aborted) {
          const timeoutHtml =
            `⏱️ <b>Subagent analysis timeout</b> (5 min)\n` +
            `<i>The background task is taking longer than expected. You can check status or resume with <code>/resume</code>.</i>`;
          await replyWithHtml(context, params.chatId, timeoutHtml, createMainKeyboard(settingsFor(context, params.chatId)));
        }
      } catch (loopError) {
        if (!controller.signal.aborted) {
          console.error(`[SubagentPoller] Unexpected error in polling loop: ${(loopError as Error).message}`);
        }
      } finally {
        if (this.activePolls.get(chatKey) === controller) {
          this.activePolls.delete(chatKey);
        }
        context.controllers.delete(controllerKey("subagent_poller", params.chatId));
        await context.state.clearInFlight(params.chatId);
        await context.state.setSession(params.chatId, { pendingSubagentPoll: null });
      }
    })();
  }

  /**
   * Cancels any active polling loop for the specified chat.
   */
  public cancelPolling(chatId: ChatId): boolean {
    const key = String(chatId);
    const existing = this.activePolls.get(key);
    if (existing) {
      existing.abort();
      this.activePolls.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Checks whether polling is active for the specified chat.
   */
  public isPolling(chatId: ChatId): boolean {
    return this.activePolls.has(String(chatId));
  }

  /**
   * Waits for the given delay, checking periodically for unread subagent messages.
   * Resolves early if an unread message file is detected.
   */
  private async waitForIntervalOrMessage(
    context: AppContext,
    conversationId: string,
    intervalMs: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const startTime = Date.now();
    const checkCadenceMs = 2000;

    while (Date.now() - startTime < intervalMs) {
      if (signal.aborted) return false;

      if (checkForSubagentMessages(context.config.agy.dbPath, conversationId)) {
        return true;
      }

      const remaining = intervalMs - (Date.now() - startTime);
      const sleepTime = Math.min(checkCadenceMs, remaining);
      if (sleepTime <= 0) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, sleepTime);
        const onAbort = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    return checkForSubagentMessages(context.config.agy.dbPath, conversationId);
  }

  /**
   * Delivers the finalized response and telemetry to Telegram once subagent completes.
   */
  private async deliverFinalResponse(
    context: AppContext,
    params: SubagentPollParams,
    result: AgyResult
  ): Promise<void> {
    const latestSession = context.state.session(params.chatId);
    const stepCount = (latestSession?.conversationStepCount || 0) + (result.numTurns || 1);
    const cumulativeUsage = addUsage(latestSession?.usageTotals, result.usage);

    const localPromptTokens = (result.usage?.cache_read_tokens ?? 0) + (result.usage?.input_tokens ?? 0);
    const initialActiveTokens =
      localPromptTokens > 0
        ? localPromptTokens
        : (result.activeInputTokens ?? result.usage?.input_tokens ?? result.usage?.total_tokens);
    const formattedTokens = formatTokenCount(initialActiveTokens);
    const maxTokens =
      getActiveModels().find((m) => m.id === (result.model || params.settings.model))?.maxContextWindow || 1_000_000;
    const initialContextPct = initialActiveTokens
      ? Math.min(100, Math.round((initialActiveTokens / maxTokens) * 100))
      : undefined;

    await context.state.setSession(params.chatId, {
      conversationStepCount: stepCount,
      conversationLastModifiedAt: Date.now(),
      lastRun: {
        model: result.model || params.settings.model || null,
        usage: result.usage,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        toolCalls: result.toolCalls,
        status: result.status || "SUCCESS",
        completedAt: new Date().toISOString(),
      },
      usageTotals: cumulativeUsage,
      ...(formattedTokens ? { contextTokens: formattedTokens, contextPercentage: initialContextPct } : {}),
      updatedAt: new Date().toISOString(),
    });

    await refreshActiveMenu(context, params.chatId);

    if (params.conversationId) {
      context.convDb.upsertConversation({
        conversation_id: params.conversationId,
        title: latestSession?.conversationTitle || "Conversation",
        preview: latestSession?.conversationTitle || "Conversation",
        step_count: stepCount,
        last_modified_time: Date.now(),
        project_id: params.settings.project || "default-cli-project",
        workspace_uris: `["file://${params.effectiveWorkspace}"]`,
      });
    }

    // Media & images detection
    await detectAndSendGeneratedImages(
      context,
      params.chatId,
      result,
      params.conversationId,
      Date.now() - (result.durationMs || 0)
    );

    const mediaFiles = await findReferencedMediaFiles(result.text, params.effectiveWorkspace);
    for (const mediaPath of mediaFiles) {
      const ext = path.extname(mediaPath).toLowerCase();
      const isPhoto = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
      try {
        if (isPhoto) {
          await context.telegram.sendPhoto(params.chatId, mediaPath);
        } else {
          await context.telegram.sendDocumentFile(params.chatId, mediaPath);
        }
      } catch (error) {
        console.error(`[SubagentPoller] Failed to send media file ${mediaPath}: ${(error as Error).message}`);
      } finally {
        if (mediaPath.startsWith(os.tmpdir()) || mediaPath.startsWith("/tmp/")) {
          await fsPromises.unlink(mediaPath).catch(() => undefined);
        }
      }
    }

    // Clean any residual prompt artifacts from final text
    let cleanText = result.text.replace(/\[SUBAGENT_IN_PROGRESS\]/g, "").trim();

    const telemetryMode =
      params.settings.telemetryPostPrompt || context.config.telegram.telemetryPostPrompt || "message";

    let liveContextTokens: number | null = null;
    let liveMaxTokens: number = maxTokens;
    let livePercentage: number | undefined = undefined;

    const probeContext = async (): Promise<void> => {
      try {
        const effectiveAgyConfig =
          params.effectiveWorkspace === context.config.agy.workspace
            ? context.config.agy
            : { ...context.config.agy, workspace: params.effectiveWorkspace };

        const output = await runPtyCommand(effectiveAgyConfig, "/context", {
          conversationId: params.conversationId,
          timeoutMs: 4_000,
        });
        const metrics = parseContextMetrics(output);
        if (metrics.tokens) {
          if (metrics.currentTokens != null) liveContextTokens = metrics.currentTokens;
          if (metrics.maxTokens != null) liveMaxTokens = metrics.maxTokens;
          if (typeof metrics.percentage === "number") livePercentage = metrics.percentage;
          await context.state.setSession(params.chatId, {
            contextTokens: metrics.tokens,
            contextPercentage: metrics.percentage,
          });
          await refreshActiveMenu(context, params.chatId);
        }
      } catch (err) {
        console.debug(`[SubagentPoller] Context probe failed: ${(err as Error).message}`);
      }
    };

    const previousContextTokens = latestSession?.contextTokens
      ? parseTokenValue(latestSession.contextTokens)
      : null;

    const getResolvedActiveMetrics = (): {
      tokens: number | null;
      max: number;
      pct: number | undefined;
      growthTokens: number | null;
    } => {
      let resolvedTokens: number | null = null;
      let resolvedMax = maxTokens;
      let resolvedPct: number | undefined = undefined;

      if (liveContextTokens != null) {
        resolvedTokens = liveContextTokens;
        resolvedMax = liveMaxTokens;
        resolvedPct = livePercentage;
      } else {
        const priorTokens = latestSession?.contextTokens ? parseTokenValue(latestSession.contextTokens) : null;
        if (priorTokens != null && priorTokens > 0) {
          resolvedTokens = priorTokens;
          resolvedMax = maxTokens;
          resolvedPct = latestSession?.contextPercentage;
        } else {
          resolvedTokens = initialActiveTokens ?? null;
          resolvedMax = maxTokens;
          resolvedPct = initialContextPct;
        }
      }

      const growthTokens =
        resolvedTokens != null
          ? previousContextTokens != null && previousContextTokens > 0
            ? resolvedTokens - previousContextTokens
            : resolvedTokens
          : null;

      return { tokens: resolvedTokens, max: resolvedMax, pct: resolvedPct, growthTokens };
    };

    if (telemetryMode === "inline" && cleanText) {
      await probeContext();
      const resolved = getResolvedActiveMetrics();
      const telemetryBlock = buildTelemetryQuoteBlock({
        contextGrowthTokens: resolved.growthTokens,
        activeTokens: resolved.tokens,
        maxTokens: resolved.max,
        contextPercentage: resolved.pct,
        sessionUsageTotals: cumulativeUsage,
        sessionTurns: stepCount,
        inputTokens: result.usage?.input_tokens,
        cacheReadTokens: result.usage?.cache_read_tokens,
        thinkingTokens: result.usage?.thinking_tokens,
        outputTokens: result.usage?.output_tokens,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs || 0,
        sessionDurationMs: result.sessionDurationMs,
        model: result.model || params.settings.model || "",
      });
      cleanText = `${cleanText}\n\n${telemetryBlock}`;
    }

    const isSeparateTelemetry =
      (telemetryMode === "message" || telemetryMode === "separate") && Boolean(cleanText);

    await replyWithFormattedResponse(
      context,
      params.chatId,
      cleanText,
      isSeparateTelemetry ? undefined : createMainKeyboard(settingsFor(context, params.chatId))
    );

    if (isSeparateTelemetry) {
      await probeContext();
      const resolved = getResolvedActiveMetrics();
      const telemetryBlock = buildTelemetryQuoteBlock({
        contextGrowthTokens: resolved.growthTokens,
        activeTokens: resolved.tokens,
        maxTokens: resolved.max,
        contextPercentage: resolved.pct,
        sessionUsageTotals: cumulativeUsage,
        sessionTurns: stepCount,
        inputTokens: result.usage?.input_tokens,
        cacheReadTokens: result.usage?.cache_read_tokens,
        thinkingTokens: result.usage?.thinking_tokens,
        outputTokens: result.usage?.output_tokens,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs || 0,
        sessionDurationMs: result.sessionDurationMs,
        model: result.model || params.settings.model || "",
      });
      await replyWithFormattedResponse(
        context,
        params.chatId,
        telemetryBlock,
        createMainKeyboard(settingsFor(context, params.chatId))
      );
    }
  }
}

export const defaultSubagentPoller = new SubagentPoller();
