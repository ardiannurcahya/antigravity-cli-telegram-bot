import { modelLabel } from "../models.js";
import type { ModelOption, SessionSettings } from "../types.js";

export type OrchestratorEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type OrchestratorRole = "planner" | "executor";

export interface ModelFamilyVariant {
  effort: OrchestratorEffort;
  id: string;
  label: string;
}

export interface ModelFamily {
  familyId: string;
  displayName: string;
  shortName: string;
  variants: ModelFamilyVariant[];
}

export interface OrchestratorSelection {
  planner: string | null;
  executor: string | null;
}

export const EFFORT_ORDER: readonly OrchestratorEffort[] = ["low", "medium", "high", "xhigh", "max"];

const PLANNER_PATTERNS: readonly RegExp[] = [
  /^gemini-4-neon$/i,
  /^gemini-4-carbon$/i,
  /^gemini-4-argon$/i,
  /^claude-opus/i,
];

const EXECUTOR_PATTERNS: readonly RegExp[] = [
  /^gemini-4-hydrogen$/i,
  /^claude-sonnet/i,
];

export function isOrchestratorModel(modelId: string | null | undefined): boolean {
  return Boolean(modelId && /orchestrator/i.test(modelId));
}

export function splitModelEffort(
  model: Pick<ModelOption, "id" | "label">
): { familyId: string; displayName: string; effort: OrchestratorEffort } | null {
  const trimmedId = model.id.trim();
  const match = trimmedId.match(/^(.+)-(low|medium|high|xhigh|max)$/i);
  if (!match) return null;
  const familyId = match[1];
  const effort = match[2].toLowerCase() as OrchestratorEffort;
  const displayName = model.label.replace(/\s*\((low|medium|high|xhigh|extra|max)\)\s*$/i, "").trim() || familyId;
  return { familyId, displayName, effort };
}

export function shortFamilyName(displayName: string): string {
  return displayName.replace(/^(?:Gemini\s+4|Claude)\s+/i, "").trim() || displayName;
}

export function formatEffortLabel(effort: OrchestratorEffort): string {
  if (effort === "xhigh") return "XHigh";
  if (effort === "max") return "Max";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function rolePriority(familyId: string, role: OrchestratorRole): number {
  const patterns = role === "planner" ? PLANNER_PATTERNS : EXECUTOR_PATTERNS;
  return patterns.findIndex((pattern) => pattern.test(familyId));
}

export function getOrchestratorFamilies(availableModels: ModelOption[], role: OrchestratorRole): ModelFamily[] {
  const byFamily = new Map<string, { priority: number; family: ModelFamily }>();

  for (const model of availableModels) {
    if (isOrchestratorModel(model.id)) continue;
    const split = splitModelEffort(model);
    if (!split) continue;
    const priority = rolePriority(split.familyId, role);
    if (priority < 0) continue;

    const key = split.familyId.toLowerCase();
    let entry = byFamily.get(key);
    if (!entry) {
      entry = {
        priority,
        family: {
          familyId: split.familyId,
          displayName: split.displayName,
          shortName: shortFamilyName(split.displayName),
          variants: [],
        },
      };
      byFamily.set(key, entry);
    }

    if (!entry.family.variants.some((variant) => variant.effort === split.effort)) {
      entry.family.variants.push({
        effort: split.effort,
        id: model.id,
        label: model.label,
      });
    }
  }

  return [...byFamily.values()]
    .sort((a, b) => a.priority - b.priority || a.family.displayName.localeCompare(b.family.displayName))
    .map(({ family }) => ({
      ...family,
      variants: [...family.variants].sort(
        (a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort)
      ),
    }));
}

export function primaryOrchestratorModelId(
  availableModels: ModelOption[],
  preferredModelId?: string | null
): string | null {
  const orchestrators = availableModels.filter((model) => isOrchestratorModel(model.id));
  if (orchestrators.length === 0) return null;

  if (preferredModelId && isOrchestratorModel(preferredModelId)) {
    const preferred = orchestrators.find((model) => model.id === preferredModelId);
    if (preferred) return preferred.id;
  }

  return (
    orchestrators.find((model) => model.id === "gemini-pro-orchestrator-neon")?.id ||
    orchestrators.find((model) => model.id === "gemini-pro-orchestrator")?.id ||
    orchestrators[0].id
  );
}

export function findFamilyAndEffort(
  families: ModelFamily[],
  modelId: string | null | undefined
): { family: ModelFamily; variant: ModelFamilyVariant } | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const family of families) {
    for (const variant of family.variants) {
      if (variant.id.toLowerCase() === lower || variant.label.toLowerCase() === lower) {
        return { family, variant };
      }
    }
  }
  return null;
}

export function pickVariantForFamily(
  family: ModelFamily,
  preferredEffort?: OrchestratorEffort | null
): ModelFamilyVariant {
  if (preferredEffort) {
    const exact = family.variants.find((variant) => variant.effort === preferredEffort);
    if (exact) return exact;
    if (preferredEffort === "max" || preferredEffort === "xhigh") {
      return family.variants[family.variants.length - 1];
    }
  }

  return (
    family.variants.find((variant) => variant.effort === "high") ||
    family.variants.find((variant) => variant.effort === "xhigh") ||
    family.variants.find((variant) => variant.effort === "medium") ||
    family.variants[family.variants.length - 1]
  );
}

export function buildOrchestratorCliSettings(
  modelId: string | null | undefined,
  plannerId: string | null | undefined,
  executorId: string | null | undefined,
  labelResolver: (id: string) => string = (id) => modelLabel(id)
): string | null {
  if (!isOrchestratorModel(modelId)) return null;
  const orch: Record<string, string> = {};
  if (plannerId?.trim()) {
    orch.planner = labelResolver(plannerId.trim());
  }
  if (executorId?.trim()) {
    orch.executor = labelResolver(executorId.trim());
  }
  if (Object.keys(orch).length === 0) return null;
  return JSON.stringify({ orchestrator: orch });
}

export function formatShortModelName(modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  const label = modelLabel(trimmed);
  const split = splitModelEffort({ id: trimmed, label });
  if (!split) return label;
  return `${shortFamilyName(split.displayName)} ${formatEffortLabel(split.effort)}`;
}

export function formatOrchestratorPairing(
  plannerId: string | null | undefined,
  executorId: string | null | undefined
): string {
  const plannerShort = formatShortModelName(plannerId);
  const executorShort = formatShortModelName(executorId);
  if (!plannerShort && !executorShort) return "";
  return `${plannerShort || "Default"} → ${executorShort || "Default"}`;
}

export function formatModelDisplay(
  settings: Pick<SessionSettings, "model" | "orchestratorPlanner" | "orchestratorExecutor">
): string {
  if (isOrchestratorModel(settings.model)) {
    const pairing = formatOrchestratorPairing(settings.orchestratorPlanner, settings.orchestratorExecutor);
    return pairing ? `Orchestrator (${pairing})` : modelLabel(settings.model);
  }
  return modelLabel(settings.model);
}
