import type { ModelOption } from "./types.js";

export const DEFAULT_MODELS: ModelOption[] = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)", maxContextWindow: 1_000_000 },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)", maxContextWindow: 2_000_000 },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", maxContextWindow: 2_000_000 },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", maxContextWindow: 200_000 },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", maxContextWindow: 200_000 },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", maxContextWindow: 128_000 },
];

let activeModels: ModelOption[] = [...DEFAULT_MODELS];

export function getActiveModels(): ModelOption[] {
  return activeModels;
}

export function setActiveModels(models: ModelOption[]): void {
  if (models && models.length > 0) {
    activeModels = models;
  }
}

export function parseAgyModelsOutput(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  const lines = output.split(/\r?\n/);
  for (const rawLine of lines) {
    const cleaned = rawLine.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+/g, "").trim();
    if (!cleaned || /fetching available models/i.test(cleaned)) continue;
    const match = cleaned.match(/^([a-z0-9_.-]+)\s+(.+)$/i);
    if (match) {
      const id = match[1].trim();
      const label = match[2].trim();
      if (id && label && !id.includes(" ")) {
        const lower = id.toLowerCase();
        let maxContextWindow = 1_000_000;
        if (lower.includes("pro")) maxContextWindow = 2_000_000;
        else if (lower.includes("claude")) maxContextWindow = 200_000;
        else if (lower.includes("gpt")) maxContextWindow = 128_000;
        models.push({ id, label, maxContextWindow });
      }
    }
  }
  return models;
}

export function modelLabel(id: string | null): string {
  if (!id) return "AGY default";
  return getActiveModels().find((model) => model.id === id)?.label || id;
}

export function getModelMaxContext(id: string | null): number {
  if (!id) return 1_000_000;
  const match = getActiveModels().find((model) => model.id === id);
  if (match?.maxContextWindow) return match.maxContextWindow;
  const lower = id.toLowerCase();
  if (lower.includes("gemini")) return 1_000_000;
  if (lower.includes("claude")) return 200_000;
  if (lower.includes("gpt")) return 128_000;
  return 1_000_000;
}

export function renderContextProgressBar(activeTokens: number, maxTokens: number, barLength = 10): string {
  if (maxTokens <= 0) return `${activeTokens.toLocaleString()} tokens`;
  if (activeTokens > maxTokens) {
    return `${activeTokens.toLocaleString()} tokens (Session Total)`;
  }
  const percentage = Math.min(100, Math.max(0, (activeTokens / maxTokens) * 100));
  const filledLength = Math.min(barLength, Math.round((percentage / 100) * barLength));
  const emptyLength = Math.max(0, barLength - filledLength);
  const bar = "█".repeat(filledLength) + "░".repeat(emptyLength);
  const maxLabel = maxTokens >= 1_000_000 ? `${(maxTokens / 1_000_000).toFixed(0)}M` : `${(maxTokens / 1_000).toFixed(0)}K`;
  return `[${bar}] ${percentage.toFixed(1)}% (${activeTokens.toLocaleString()} / ${maxLabel})`;
}
