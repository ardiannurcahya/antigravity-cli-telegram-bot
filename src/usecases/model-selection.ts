import { parseAgyModelsOutput, setActiveModels, modelLabel } from "../models.js";
import { runAgyCommand } from "../agy-runner.js";
import type { AppContext } from "../context.js";
import { isEffort } from "../config.js";
import { escapeHtml } from "../telegram.js";
import { getAvailableModels, isModelAllowed, saveSettings, settingsFor } from "../domain/settings.js";
import {
  findFamilyAndEffort,
  getOrchestratorFamilies,
  isOrchestratorModel,
  pickVariantForFamily,
  primaryOrchestratorModelId,
  type OrchestratorEffort,
} from "../domain/orchestrator.js";
import { button } from "../ui/inline-keyboards.js";
import type { ChatId, InlineKeyboardMarkup, SessionSettings } from "../types.js";

export async function refreshModels(context: AppContext): Promise<void> {
  try {
    const output = await runAgyCommand(context.config.agy, ["models"], 15_000);
    const parsed = parseAgyModelsOutput(output);
    if (parsed.length > 0) {
      setActiveModels(parsed);
    }
  } catch {
    // Keep fallback models if agy models is unavailable
  }
}

export interface ModelSelectionOutcome {
  settings: SessionSettings;
  text: string;
  defaultOfferKeyboard: InlineKeyboardMarkup;
}

/**
 * Shared by the `/model` command and the `set:model:*` callback: validates the
 * model, derives effort suffixes, persists settings and builds the
 * "set as permanent default?" prompt.
 */
export async function selectModel(context: AppContext, chatId: ChatId, modelId: string): Promise<ModelSelectionOutcome | null> {
  if (!isModelAllowed(context, modelId)) return null;
  const settings = settingsFor(context, chatId);
  settings.model = modelId;
  const match = modelId.match(/-(low|medium|high)$/i);
  if (match) {
    const eff = match[1].toLowerCase();
    if (isEffort(eff)) settings.effort = eff;
  }
  await saveSettings(context, chatId, settings);
  const text = `Model set to <b>${escapeHtml(modelLabel(modelId))}</b>.\n\nWould you like to set this as your permanent default?`;
  const defaultOfferKeyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [button("⭐ Yes, set as Default", "action:setdefault"), button("👌 Only this session", "menu:main")],
    ],
  };
  return { settings, text, defaultOfferKeyboard };
}

/** Activates the Orchestrator model for the session using the primary allowed orchestrator ID. */
export async function activateOrchestrator(context: AppContext, chatId: ChatId): Promise<SessionSettings | null> {
  const settings = settingsFor(context, chatId);
  const available = getAvailableModels(context, chatId);
  const orchId = primaryOrchestratorModelId(available, settings.model);
  if (!orchId) return null;
  if (!isOrchestratorModel(settings.model)) {
    settings.model = orchId;
    await saveSettings(context, chatId, settings);
  }
  return settings;
}

export type OrchestratorUpdateAction = "pf" | "pe" | "ef" | "ee" | "p" | "e" | "reset";

export interface OrchestratorUpdateResult {
  settings: SessionSettings;
  changed: boolean;
  error?: string;
}

/** Updates Orchestrator planner/executor family, effort, explicit model, or pairing reset. */
export async function updateOrchestratorSetting(
  context: AppContext,
  chatId: ChatId,
  action: OrchestratorUpdateAction,
  value: string
): Promise<OrchestratorUpdateResult> {
  const settings = settingsFor(context, chatId);
  const available = getAvailableModels(context, chatId);
  const orchId = primaryOrchestratorModelId(available, settings.model);
  if (!orchId) {
    return { settings, changed: false, error: "Orchestrator is not allowed by AGY_ALLOWED_MODELS." };
  }

  let changed = false;
  if (!isOrchestratorModel(settings.model)) {
    settings.model = orchId;
    changed = true;
  }

  const plannerFamilies = getOrchestratorFamilies(available, "planner");
  const executorFamilies = getOrchestratorFamilies(available, "executor");

  if (action === "reset") {
    if (settings.orchestratorPlanner !== null || settings.orchestratorExecutor !== null) {
      settings.orchestratorPlanner = null;
      settings.orchestratorExecutor = null;
      changed = true;
    }
    if (changed) await saveSettings(context, chatId, settings);
    return { settings, changed };
  }

  if (action === "pf") {
    const family = plannerFamilies.find((f) => f.familyId.toLowerCase() === value.trim().toLowerCase());
    if (!family) return { settings, changed: false, error: `Unknown or disallowed planner family: ${value}` };
    const currentEffort = findFamilyAndEffort(plannerFamilies, settings.orchestratorPlanner)?.variant.effort || null;
    const nextVariant = pickVariantForFamily(family, currentEffort);
    if (settings.orchestratorPlanner !== nextVariant.id) {
      settings.orchestratorPlanner = nextVariant.id;
      changed = true;
    }
  } else if (action === "pe") {
    const activeFamily = findFamilyAndEffort(plannerFamilies, settings.orchestratorPlanner)?.family || plannerFamilies[0];
    if (!activeFamily) return { settings, changed: false, error: "No allowed planner models available." };
    const effort = value.trim().toLowerCase() as OrchestratorEffort;
    const nextVariant = activeFamily.variants.find((v) => v.effort === effort);
    if (!nextVariant) return { settings, changed: false, error: `Effort "${value}" is not supported for ${activeFamily.displayName}.` };
    if (settings.orchestratorPlanner !== nextVariant.id) {
      settings.orchestratorPlanner = nextVariant.id;
      changed = true;
    }
  } else if (action === "ef") {
    const family = executorFamilies.find((f) => f.familyId.toLowerCase() === value.trim().toLowerCase());
    if (!family) return { settings, changed: false, error: `Unknown or disallowed executor family: ${value}` };
    const currentEffort = findFamilyAndEffort(executorFamilies, settings.orchestratorExecutor)?.variant.effort || null;
    const nextVariant = pickVariantForFamily(family, currentEffort);
    if (settings.orchestratorExecutor !== nextVariant.id) {
      settings.orchestratorExecutor = nextVariant.id;
      changed = true;
    }
  } else if (action === "ee") {
    const activeFamily = findFamilyAndEffort(executorFamilies, settings.orchestratorExecutor)?.family || executorFamilies[0];
    if (!activeFamily) return { settings, changed: false, error: "No allowed executor models available." };
    const effort = value.trim().toLowerCase() as OrchestratorEffort;
    const nextVariant = activeFamily.variants.find((v) => v.effort === effort);
    if (!nextVariant) return { settings, changed: false, error: `Effort "${value}" is not supported for ${activeFamily.displayName}.` };
    if (settings.orchestratorExecutor !== nextVariant.id) {
      settings.orchestratorExecutor = nextVariant.id;
      changed = true;
    }
  } else if (action === "p") {
    const matched = findFamilyAndEffort(plannerFamilies, value);
    if (!matched) {
      const allowedIds = plannerFamilies.flatMap((f) => f.variants.map((v) => v.id));
      return {
        settings,
        changed: false,
        error: `Invalid or disallowed planner model: ${value}${allowedIds.length ? `\nAllowed: ${allowedIds.join(", ")}` : ""}`,
      };
    }
    if (settings.orchestratorPlanner !== matched.variant.id) {
      settings.orchestratorPlanner = matched.variant.id;
      changed = true;
    }
  } else if (action === "e") {
    const matched = findFamilyAndEffort(executorFamilies, value);
    if (!matched) {
      const allowedIds = executorFamilies.flatMap((f) => f.variants.map((v) => v.id));
      return {
        settings,
        changed: false,
        error: `Invalid or disallowed executor model: ${value}${allowedIds.length ? `\nAllowed: ${allowedIds.join(", ")}` : ""}`,
      };
    }
    if (settings.orchestratorExecutor !== matched.variant.id) {
      settings.orchestratorExecutor = matched.variant.id;
      changed = true;
    }
  }

  if (changed) await saveSettings(context, chatId, settings);
  return { settings, changed };
}
