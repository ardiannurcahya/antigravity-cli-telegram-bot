import { formatRelativeTime, type ConversationPage } from "../db.js";
import type { AppContext } from "../context.js";
import { getModelMaxContext, modelLabel, renderContextProgressBar } from "../models.js";
import { escapeHtml } from "../telegram.js";
import { settingsFor } from "../domain/settings.js";
import type { ChatId, SessionSettings, Usage } from "../types.js";

export function settingsText(settings: SessionSettings): string {
  return [
    `Model: ${modelLabel(settings.model)}`, `Effort: ${settings.effort}`, `Mode: ${settings.mode}`,
    `Verbose: ${settings.verbose || "detailed"}`, `Agent: ${settings.agent || "default"}`, `Project: ${settings.project || "default"}`,
    `Sandbox: ${settings.sandbox ? "enabled" : "disabled"}`, `Output: ${settings.outputFormat}`,
    settings.workspace ? `Workspace: ${settings.workspace}` : null,
    `Add dirs: ${settings.addDirs?.length || 0}`, `Slash commands: ${settings.disableSlashCommands ? "disabled" : "enabled"}`,
  ].filter(Boolean).join("\n");
}

export function sessionInfoHtml(context: AppContext, chatId: ChatId): string {
  const settings = settingsFor(context, chatId);
  const maxContext = getModelMaxContext(settings.model);
  const contextStr = maxContext ? `${maxContext.toLocaleString()} tokens` : "Default";
  const modeStr = settings.mode === "accept-edits" ? "edit (accept-edits)" : (settings.mode || "accept-edits");

  return [
    "✨ <b>New AGY conversation started.</b>\n",
    `• <b>Model:</b> <code>${escapeHtml(modelLabel(settings.model))}</code>`,
    `• <b>Effort:</b> <code>${escapeHtml(settings.effort || "high")}</code>`,
    `• <b>Mode:</b> <code>${escapeHtml(modeStr)}</code>`,
    `• <b>Verbose:</b> <code>${escapeHtml(settings.verbose || "detailed")}</code>`,
    `• <b>Context Limit:</b> <code>${escapeHtml(contextStr)}</code>`,
    `• <b>Sandbox:</b> <code>${settings.sandbox ? "Enabled" : "Disabled"}</code>`,
    settings.workspace ? `• <b>Workspace:</b> <code>${escapeHtml(settings.workspace)}</code>` : null,
    context.config.agy.project ? `• <b>Project:</b> <code>${escapeHtml(context.config.agy.project)}</code>` : null,
  ].filter(Boolean).join("\n");
}

export function usageText(usage: Usage | null | undefined, modelId: string | null = null, isAccumulated = false): string {
  if (!usage) return "Usage data was not provided by AGY.";
  const activeInputContext = (usage.input_tokens || 0) + (usage.cache_read_tokens || 0);
  const maxContext = getModelMaxContext(modelId);
  const lines: string[] = [];
  if (!isAccumulated && activeInputContext > 0) {
    if (activeInputContext <= maxContext) {
      lines.push(`Active Context: ${renderContextProgressBar(activeInputContext, maxContext)}`);
    } else {
      lines.push(`Context reported by AGY: ${activeInputContext.toLocaleString()} tokens (Session Total; active context unavailable)`);
    }
  }
  const labels: Array<[keyof Usage, string]> = [["input_tokens", "Input (New)"], ["output_tokens", "Output"], ["thinking_tokens", "Thinking"], ["cache_read_tokens", "Cache-read"], ["total_tokens", "Total Billed"]];
  for (const [key, label] of labels) {
    if (usage[key] !== undefined) {
      lines.push(`${label}: ${usage[key]!.toLocaleString()}`);
    }
  }
  return lines.join("\n") || "Usage data was not provided by AGY.";
}

export function sessionText(context: AppContext, chatId: ChatId): string {
  const session = context.state.session(chatId);
  const status = context.queue.statusForChat(chatId);
  const title = session?.conversationTitle || (session?.conversationId ? "Untitled session" : "new");
  const lines = [
    "Session\n",
    `Active: ${title}`,
    `Conversation: ${session?.conversationId || "new"}`,
  ];
  if (session?.conversationStepCount) {
    const relative = formatRelativeTime(session.conversationLastModifiedAt || session.updatedAt);
    lines.push(`Steps: ${session.conversationStepCount} · Last active: ${relative}`);
  }
  const customWs = settingsFor(context, chatId).workspace;
  lines.push(`Workspace: ${customWs || context.config.agy.workspace}${customWs ? " (custom)" : " (default)"}`);
  lines.push(settingsText(settingsFor(context, chatId)));
  lines.push(`Status: ${status.active ? "running" : "idle"}`);
  return lines.join("\n");
}

export function resumeMessageText(pageData: ConversationPage): string {
  if (pageData.total === 0 || pageData.items.length === 0) {
    return "<b>AGY Sessions</b>\n\nNo saved conversations found in AGY database.";
  }
  const list = pageData.items
    .map((item) => {
      const time = formatRelativeTime(item.last_modified_time);
      return `<b>${escapeHtml(item.display_title)}</b>\n${item.step_count} steps · ${time}`;
    })
    .join("\n\n");
  return `<b>AGY Sessions</b>\nPage ${pageData.page + 1}/${pageData.totalPages}\n\n${list}`;
}

export function usageReport(context: AppContext, chatId: ChatId): string {
  const session = context.state.session(chatId);
  const last = session?.lastRun;
  const modelId = last?.model || settingsFor(context, chatId).model;
  const lastText = last ? [`Last run: ${last.status}`, last.model ? `Model: ${modelLabel(last.model)}` : null, last.durationMs ? `Duration: ${(last.durationMs / 1000).toFixed(1)}s` : null, last.numTurns !== null ? `Turns: ${last.numTurns}` : null, last.toolCalls ? `Tool calls: ${last.toolCalls}` : null, usageText(last.usage, modelId)].filter(Boolean).join("\n") : "Last run: no completed run yet.";
  return `Usage / Quota\n\n${lastText}\n\nAccumulated usage:\n${usageText(session?.usageTotals, modelId, true)}\n\nSubscription quota is not exposed by AGY stream-json.`;
}

export function sessionOptionUsage(option: string): string {
  return [
    `/project ID|clear`, `/add-dir PATH|clear`, `/output-format text|json|stream-json`,
    `/json-schema JSON_OR_PATH|clear`, `/log-file PATH|clear`, `/print-timeout DURATION|clear`,
    `/continue on|off`, `/new-project on|off`, `/disable-slash-commands on|off`,
  ].find((line) => line.startsWith(`/${option} `)) || `Usage: /${option} VALUE`;
}
