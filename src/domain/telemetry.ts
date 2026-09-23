import type { Usage } from "../types.js";
import { modelLabel } from "../models.js";
import { formatTokenCount } from "./usage-math.js";

export interface TelemetryData {
  title?: string;
  contextGrowthTokens?: number | null;
  activeTokens?: number | null;
  maxTokens: number;
  contextPercentage?: number | null;
  sessionUsageTotals?: Usage | null;
  sessionTurns?: number | null;
  sessionDurationMs?: number | null;
  inputTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
  outputTokens?: number;
  toolCalls: number;
  durationMs?: number | null;
  model: string;
}

export type HealthStatus = "nominal" | "vigilance" | "alert";

export interface MetricDiagnostic {
  label: string;
  value: string;
  status: HealthStatus;
  comment: string;
  hasWarning?: boolean;
}

export function evaluateActiveContext(
  activeTokens: number | null | undefined,
  maxTokens: number,
  explicitPercentage?: number | null
): { formatted: string; status: HealthStatus; comment: string; hasWarning: boolean; pct: number } {
  const safeMax = maxTokens > 0 ? maxTokens : 1_000_000;
  if (activeTokens != null && activeTokens > 0) {
    const calculatedPct = Math.min(100, Math.round((activeTokens / safeMax) * 100));
    const pct = typeof explicitPercentage === "number" && !Number.isNaN(explicitPercentage)
      ? Math.min(100, Math.max(0, Math.round(explicitPercentage)))
      : calculatedPct;
    let status: HealthStatus = "nominal";
    let comment = "Nominal";
    let hasWarning = false;

    if (pct > 70) {
      status = "alert";
      comment = "Alert (run /compact or /new)";
      hasWarning = true;
    } else if (pct >= 40) {
      status = "vigilance";
      comment = "Vigilance (consider compaction or archiving)";
    }

    return {
      formatted: `${activeTokens.toLocaleString("en-US")} / ${safeMax.toLocaleString("en-US")} tokens (${pct}%)`,
      status,
      comment,
      hasWarning,
      pct,
    };
  }

  return {
    formatted: "N/A",
    status: "nominal",
    comment: "Not reported",
    hasWarning: false,
    pct: 0,
  };
}

export function evaluatePromptCache(
  cacheReadTokens: number | undefined,
  inputTokens: number | undefined
): { formatted: string; status: HealthStatus; comment: string; hitRate: number } {
  const cacheRead = cacheReadTokens ?? 0;
  const input = inputTokens ?? 0;
  const total = cacheRead + input;

  if (total > 0) {
    const hitRate = Math.round((cacheRead / total) * 100);
    let status: HealthStatus = "nominal";
    let comment = "Warm cache (optimal)";

    if (hitRate >= 80) {
      status = "nominal";
      comment = "Warm cache (optimal)";
    } else if (hitRate >= 30) {
      status = "vigilance";
      comment = "Moderate hit rate";
    } else {
      status = "alert";
      comment = "Cold cache / cache miss";
    }

    return {
      formatted: `${hitRate}% hit rate`,
      status,
      comment,
      hitRate,
    };
  }

  return {
    formatted: "0% hit rate",
    status: "alert",
    comment: "Cold cache / cache miss",
    hitRate: 0,
  };
}

export function evaluateThinkingTokens(
  thinkingTokens: number | undefined
): { formatted: string; status: HealthStatus; comment: string } {
  if (thinkingTokens != null && thinkingTokens > 0) {
    let status: HealthStatus = "nominal";
    let comment = "Balanced reasoning";

    if (thinkingTokens > 4000) {
      status = "alert";
      comment = "Extended reasoning (check prompt ambiguity)";
    } else if (thinkingTokens > 2500) {
      status = "vigilance";
      comment = "Deep reasoning";
    } else if (thinkingTokens >= 500) {
      status = "nominal";
      comment = "Balanced reasoning";
    } else {
      status = "vigilance";
      comment = "Fast / minimal reasoning";
    }

    return {
      formatted: `${thinkingTokens.toLocaleString("en-US")} tokens`,
      status,
      comment,
    };
  }

  return {
    formatted: "0 tokens",
    status: "nominal",
    comment: "Minimal / fast reasoning",
  };
}

export function evaluateToolCalls(
  toolCalls: number
): { formatted: string; status: HealthStatus; comment: string; hasWarning: boolean; collapsedLabel: string } {
  if (toolCalls === 0) {
    return {
      formatted: "0 executions",
      status: "nominal",
      comment: "Conceptual answer (no files or commands checked on server)",
      hasWarning: false,
      collapsedLabel: "0 tools",
    };
  }

  if (toolCalls <= 4) {
    return {
      formatted: `${toolCalls} execution${toolCalls > 1 ? "s" : ""}`,
      status: "nominal",
      comment: "Nominal (verified on server)",
      hasWarning: false,
      collapsedLabel: `${toolCalls} tool${toolCalls > 1 ? "s" : ""}`,
    };
  }

  if (toolCalls <= 10) {
    return {
      formatted: `${toolCalls} executions`,
      status: "vigilance",
      comment: "High tool activity",
      hasWarning: false,
      collapsedLabel: `${toolCalls} tools`,
    };
  }

  return {
    formatted: `${toolCalls} executions ⚠️`,
    status: "alert",
    comment: "Heavy tool chain (verify loop)",
    hasWarning: true,
    collapsedLabel: `${toolCalls} tools ⚠️`,
  };
}

export function evaluateResponseSize(
  outputTokens: number | undefined
): { formatted: string; status: HealthStatus; comment: string } {
  if (outputTokens != null && outputTokens > 0) {
    let status: HealthStatus = "nominal";
    let comment = "Concise output";

    if (outputTokens > 1200) {
      status = "alert";
      comment = "Verbose output (consider asking for summary)";
    } else if (outputTokens >= 600) {
      status = "vigilance";
      comment = "Detailed output";
    }

    return {
      formatted: `${outputTokens.toLocaleString("en-US")} tokens`,
      status,
      comment,
    };
  }

  return {
    formatted: "N/A",
    status: "nominal",
    comment: "Output size not reported",
  };
}

export function formatSessionDuration(durationMs: number): string {
  const totalSec = Math.round(durationMs / 1000);
  if (totalSec < 60) {
    const secStr = (durationMs / 1000).toFixed(1);
    return `${secStr}s total`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s total`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m total`;
}

/**
 * Builds the native Telegram markdown expandable blockquote footer for telemetry.
 * Output format:
 * **> 📊 Telemetry: 45k ctx (5%) · 2 tools · 1.4s
 * **>
 * **> • **Active context:** 45,120 / 1,000,000 tokens (5%) — Nominal
 * **> • **Prompt cache:** 92% hit rate — Warm cache (optimal)
 * **> • **Thinking tokens:** 1,240 tokens — Balanced reasoning
 * **> • **Tool calls:** 2 executions — Nominal (verified on server)
 * **> • **Response size:** 280 tokens — Concise output
 * **> • **Model & duration:** Gemini 3.8 Flash · 1.4s
 */
export function buildTelemetryQuoteBlock(data: TelemetryData): string {
  const durationSec = data.durationMs != null ? `${(data.durationMs / 1000).toFixed(1)}s` : "0.0s";
  const contextEval = evaluateActiveContext(data.activeTokens, data.maxTokens, data.contextPercentage);
  const cacheEval = evaluatePromptCache(data.cacheReadTokens, data.inputTokens);
  const thinkingEval = evaluateThinkingTokens(data.thinkingTokens);
  const toolEval = evaluateToolCalls(data.toolCalls);
  const responseEval = evaluateResponseSize(data.outputTokens);

  // Net context delta added to active context this turn
  const growthTokens = data.contextGrowthTokens != null
    ? data.contextGrowthTokens
    : (data.activeTokens ?? 0);

  const growthLabel = growthTokens > 0
    ? `+${formatTokenCount(growthTokens)} ctx`
    : (growthTokens < 0 ? `-${formatTokenCount(Math.abs(growthTokens))} ctx` : "0 ctx");

  const collapsedTools = toolEval.collapsedLabel;
  const collapsedCtx = `${contextEval.pct}% ctx${contextEval.hasWarning ? " ⚠️" : ""}`;

  const title = data.title || "Run";
  const headerLine = `⚡ ${title}: ${growthLabel} · ${collapsedTools} · ${durationSec} · ${collapsedCtx}`;

  // Section 1: This turn
  const growthDetail = growthTokens >= 0
    ? `+${growthTokens.toLocaleString("en-US")} tokens (feeds active context)`
    : `${growthTokens.toLocaleString("en-US")} tokens (pruned / compacted)`;

  const thisTurnLines = [
    `⏱️ **This turn**`,
    `• **Context growth:** ${growthDetail}`,
    `• **Thinking tokens:** ${thinkingEval.formatted} — ${thinkingEval.comment}`,
    `• **Tool calls:** ${toolEval.formatted} — ${toolEval.comment}`,
    `• **Model & duration:** ${modelLabel(data.model)} · ${durationSec}`,
  ];

  // Section 2: Session totals
  const sessionLines = [
    `📊 **Session totals**`,
    `• **Active context:** ${contextEval.formatted} — ${contextEval.comment}`,
  ];

  if (data.sessionUsageTotals?.total_tokens || data.sessionTurns || data.sessionDurationMs) {
    const parts: string[] = [];
    if (data.sessionUsageTotals?.total_tokens) {
      parts.push(`${formatTokenCount(data.sessionUsageTotals.total_tokens)} tokens consumed`);
    }
    if (data.sessionTurns) {
      parts.push(`${data.sessionTurns} ${data.sessionTurns === 1 ? "turn" : "turns"}`);
    }
    if (data.sessionDurationMs != null && data.sessionDurationMs > 0) {
      parts.push(formatSessionDuration(data.sessionDurationMs));
    }
    sessionLines.push(`• **Cumulative usage:** ${parts.join(" · ")}`);
  }

  sessionLines.push(`• **Prompt cache:** ${cacheEval.formatted} — ${cacheEval.comment}`);

  return [
    `**> ${headerLine}`,
    "**>",
    ...thisTurnLines.map((line) => `**> ${line}`),
    "**>",
    ...sessionLines.map((line) => `**> ${line}`),
  ].join("\n");
}
