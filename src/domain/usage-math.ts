import type { Usage } from "../types.js";

export function addUsage(previous: Usage | null | undefined, current: Usage | null): Usage | null {
  if (!current) return previous || null;
  const total: Usage = { ...(previous || {}) };
  for (const [key, value] of Object.entries(current) as Array<[keyof Usage, number]>) total[key] = (total[key] || 0) + value;
  return total;
}

export function formatTokenCount(tokens?: number | null): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k >= 100 || k % 1 === 0 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(tokens);
}

