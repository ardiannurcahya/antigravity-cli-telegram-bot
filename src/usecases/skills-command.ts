import { runAgyCommand } from "../agy-runner.js";
import type { AppContext } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { backKeyboard } from "../ui/inline-keyboards.js";
import { settingsFor } from "../domain/settings.js";
import { escapeHtml } from "../telegram.js";
import { reply, replyWithHtml } from "../ui/reply.js";
import type { ChatId } from "../types.js";

export interface SkillItem {
  name: string;
  description: string;
  path: string;
  builtin?: boolean;
  model_invocable?: boolean;
}

export type SkillScope = "project" | "global" | "builtin";

export interface CategorizedSkill extends SkillItem {
  scope: SkillScope;
}

export function categorizeSkill(skill: SkillItem, workspacePath?: string): SkillScope {
  if (skill.builtin) return "builtin";
  if (skill.path) {
    if (skill.path.includes("/.agents/skills/") || skill.path.includes("/_agents/skills/")) {
      return "project";
    }
    if (workspacePath && skill.path.startsWith(workspacePath)) {
      return "project";
    }
    if (skill.path.includes("/.gemini/config/skills/")) {
      return "global";
    }
  }
  return "global";
}

export function parseSkillsJson(rawOutput: string, workspacePath?: string): CategorizedSkill[] | null {
  try {
    const data = JSON.parse(rawOutput);
    const skillsList: SkillItem[] = data?.command?.data?.skills || data?.skills;
    if (!Array.isArray(skillsList)) return null;
    return skillsList.map((skill) => ({
      ...skill,
      scope: categorizeSkill(skill, workspacePath),
    }));
  } catch {
    return null;
  }
}

export function formatSkillsHtml(skills: CategorizedSkill[], filterName?: string): string {
  if (filterName) {
    const cleanFilter = filterName.trim().toLowerCase();
    const matched = skills.find((s) => s.name.toLowerCase() === cleanFilter);
    if (!matched) {
      return `⚡ <b>AGY Skills</b>\n\nSkill "<b>${escapeHtml(filterName)}</b>" not found. Use <code>/skills</code> to view all available skills.`;
    }
    const scopeLabel = matched.scope === "project" ? "📁 Project" : matched.scope === "global" ? "🌐 Global" : "📦 Built-in";
    return [
      `⚡ <b>Skill: ${escapeHtml(matched.name)}</b> (${scopeLabel})`,
      `${escapeHtml(matched.description || "No description provided.")}`,
      `<b>Path:</b> <code>${escapeHtml(matched.path)}</code>`,
    ].join("\n\n");
  }

  if (!skills.length) {
    return "⚡ <b>AGY Skills</b>\n\nNo skills available.";
  }

  const projectSkills = skills.filter((s) => s.scope === "project").sort((a, b) => a.name.localeCompare(b.name));
  const globalSkills = skills.filter((s) => s.scope === "global").sort((a, b) => a.name.localeCompare(b.name));
  const builtinSkills = skills.filter((s) => s.scope === "builtin").sort((a, b) => a.name.localeCompare(b.name));

  const sections: string[] = [];
  sections.push(`⚡ <b>AGY Skills (${skills.length} available)</b>`);

  const formatList = (items: CategorizedSkill[]) =>
    items.map((item) => `• <b>${escapeHtml(item.name)}</b>: ${escapeHtml(item.description || "No description")}`).join("\n");

  if (projectSkills.length > 0) {
    sections.push(`📁 <b>Project Skills (${projectSkills.length})</b>\n${formatList(projectSkills)}`);
  }
  if (globalSkills.length > 0) {
    sections.push(`🌐 <b>Global Skills (${globalSkills.length})</b>\n${formatList(globalSkills)}`);
  }
  if (builtinSkills.length > 0) {
    sections.push(`📦 <b>Built-in Skills (${builtinSkills.length})</b>\n${formatList(builtinSkills)}`);
  }

  return sections.join("\n\n");
}

export async function handleSkillsCommand(context: AppContext, chatId: ChatId, filterName?: string, messageId?: number): Promise<void> {
  const settings = settingsFor(context, chatId);
  const workspacePath = settings.workspace || context.config.agy.workspace;
  const effectiveAgyConfig = workspacePath === context.config.agy.workspace
    ? context.config.agy
    : { ...context.config.agy, workspace: workspacePath };

  try {
    const output = await runAgyCommand(
      effectiveAgyConfig,
      ["--print", "/skills", "--output-format", "json", "--dangerously-skip-permissions"],
      context.config.agy.timeoutMs
    );

    const parsedSkills = parseSkillsJson(output, workspacePath);
    if (parsedSkills) {
      const html = formatSkillsHtml(parsedSkills, filterName);
      if (messageId) {
        try {
          await context.telegram.editMessageText(chatId, messageId, html, backKeyboard(), "HTML");
        } catch {
          await context.telegram.editMessageText(chatId, messageId, html.replace(/<[^>]+>/g, ""), backKeyboard()).catch(() => undefined);
        }
      } else {
        await replyWithHtml(context, chatId, html, createMainKeyboard(settingsFor(context, chatId)));
      }
    } else {
      const text = `AGY skills\n\n${output || "No skills found."}`;
      if (messageId) {
        await context.telegram.editMessageText(chatId, messageId, text, backKeyboard()).catch(() => undefined);
      } else {
        await reply(context, chatId, text, createMainKeyboard(settingsFor(context, chatId)));
      }
    }
  } catch (error) {
    const errorText = `Could not read AGY skills: ${(error as Error).message}`;
    if (messageId) {
      await context.telegram.editMessageText(chatId, messageId, errorText, backKeyboard()).catch(() => undefined);
    } else {
      await reply(context, chatId, errorText, createMainKeyboard(settingsFor(context, chatId)));
    }
  }
}
