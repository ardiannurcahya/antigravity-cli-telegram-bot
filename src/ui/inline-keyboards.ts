import type { AppContext } from "../context.js";
import { getActiveModels } from "../models.js";
import { settingsFor } from "../domain/settings.js";
import { listAvailableWorkspaces } from "../domain/workspace.js";
import type { ChatId, InlineKeyboardMarkup, InlineButton, ConversationSummary } from "../types.js";

export function button(text: string, callback_data: string): { text: string; callback_data: string } { return { text, callback_data }; }

export function backKeyboard(): InlineKeyboardMarkup { return { inline_keyboard: [[button("‹ Back", "menu:main")]] }; }

export function resumeKeyboard(page = 0, totalPages = 1, items: ConversationSummary[] = []): InlineKeyboardMarkup {
  const rows: InlineButton[][] = items.map((item) => [
    button(
      item.display_title.length > 40 ? `${item.display_title.slice(0, 37)}...` : item.display_title,
      `resume:use:${item.conversation_id}`
    ),
  ]);
  const navigation: InlineButton[] = [];
  if (page > 0) navigation.push(button("‹ Previous", `resume:page:${page - 1}`));
  navigation.push(button(`Page ${page + 1}/${totalPages}`, "noop"));
  if (page < totalPages - 1) navigation.push(button("Next ›", `resume:page:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([button("‹ Back", "menu:main")]);
  return { inline_keyboard: rows };
}

export function modelKeyboard(context: AppContext, chatId: ChatId, page = 0): InlineKeyboardMarkup {
  const pageSize = 5;
  const models = getActiveModels();
  const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
  const normalizedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const selected = settingsFor(context, chatId).model;
  const rows = models.slice(normalizedPage * pageSize, normalizedPage * pageSize + pageSize).map((model) => [button(`${model.id === selected ? "✅ " : ""}${model.label}`, `set:model:${model.id}`)]);
  const navigation = [];
  if (normalizedPage > 0) navigation.push(button("‹", `menu:models:${normalizedPage - 1}`));
  navigation.push(button(`${normalizedPage + 1}/${totalPages}`, "noop"));
  if (normalizedPage < totalPages - 1) navigation.push(button("›", `menu:models:${normalizedPage + 1}`));
  rows.push(navigation);
  rows.push([button("‹ Back", "menu:main")]);
  return { inline_keyboard: rows };
}

export function effortKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).effort;
  const choices = ["low", "medium", "high"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:effort:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

export function modeKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).mode;
  const choices = ["plan", "accept-edits"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:mode:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

export function sandboxKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).sandbox;
  const disableAllowed = context.config.agy.allowSandboxDisable || !context.config.agy.sandbox;
  return { inline_keyboard: [[button(`${selected ? "✅ " : ""}On`, "set:sandbox:on"), button(`${!selected ? "✅ " : ""}Off${disableAllowed ? "" : " (locked)"}`, disableAllowed ? "set:sandbox:off" : "noop")], [button("‹ Back", "menu:main")]] };
}

export function verboseKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).verbose || "detailed";
  const choices = ["detailed", "compact", "silent"].map((value) => button(`${value === selected ? "✅ " : ""}${value}`, `set:verbose:${value}`));
  return { inline_keyboard: [choices, [button("‹ Back", "menu:main")]] };
}

export function workspaceKeyboard(context: AppContext, chatId: ChatId, page = 0): InlineKeyboardMarkup {
  const pageSize = 6;
  const currentSettings = settingsFor(context, chatId);
  const activeWs = currentSettings.workspace;
  const workspaces = listAvailableWorkspaces(context.config.agy.projectsRoot, context.config.agy.workspace);
  const totalPages = Math.max(1, Math.ceil(workspaces.length / pageSize));
  const normalizedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = workspaces.slice(normalizedPage * pageSize, normalizedPage * pageSize + pageSize);

  const rows: InlineButton[][] = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row: InlineButton[] = [];
    const item1 = slice[i];
    const isSelected1 = activeWs === item1.path;
    row.push(button(`${isSelected1 ? "✅ " : "📁 "}${item1.name}`, `set:ws:${item1.name}`));
    if (slice[i + 1]) {
      const item2 = slice[i + 1];
      const isSelected2 = activeWs === item2.path;
      row.push(button(`${isSelected2 ? "✅ " : "📁 "}${item2.name}`, `set:ws:${item2.name}`));
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const navigation: InlineButton[] = [];
    if (normalizedPage > 0) navigation.push(button("‹", `menu:workspace:${normalizedPage - 1}`));
    navigation.push(button(`${normalizedPage + 1}/${totalPages}`, "noop"));
    if (normalizedPage < totalPages - 1) navigation.push(button("›", `menu:workspace:${normalizedPage + 1}`));
    rows.push(navigation);
  }

  const actionsRow: InlineButton[] = [];
  if (activeWs) {
    actionsRow.push(button("🔄 Reset default", "set:ws:clear"));
  }
  actionsRow.push(button("‹ Back", "menu:main"));
  rows.push(actionsRow);

  return { inline_keyboard: rows };
}

export function mainInlineKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("Models", "menu:models"), button("Effort", "menu:effort")],
      [button("Mode", "menu:mode"), button("Sandbox", "menu:sandbox")],
      [button("Workspace", "menu:workspace"), button("Resume session", "menu:resume")],
      [button("Verbose", "menu:verbose"), button("Session", "menu:session")],
      [button("Usage / Quota", "action:usage"), button("Active Context", "action:context")],
      [button("CLI options", "menu:cli"), button("AGY models", "cli:models")],
      [button("AGY agents", "cli:agents"), button("Plugins", "cli:plugins")],
      [button("Changelog", "cli:changelog"), button("CLI help", "cli:help")],
      [button("CLI version", "cli:version"), button("Custom /agy", "menu:custom")],
      [button("Plugin actions", "menu:plugins"), button("Update CLI", "cli:update")],
      [button("💾 Set as Default", "action:setdefault"), button("New session", "action:new")],
      [button("🔄 Update Bot", "action:update_bot"), button("Cancel", "action:cancel")],
    ],
  };
}

export function cliOptionsKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const settings = settingsFor(context, chatId);
  return {
    inline_keyboard: [
      [button("Project", "cli:project"), button("Agent", "cli:agent")],
      [button(`Continue: ${settings.continueSession ? "on" : "off"}`, "toggle:continue"), button(`New project: ${settings.newProject ? "on" : "off"}`, "toggle:new-project")],
      [button(`Output: ${settings.outputFormat}`, "menu:output"), button(`Slash cmds: ${settings.disableSlashCommands ? "off" : "on"}`, "toggle:disable-slash")],
      [button("Add directory", "cli:add-dir"), button("JSON schema", "cli:json-schema")],
      [button("Log file", "cli:log-file"), button("Print timeout", "cli:print-timeout")],
      [button("Conversation ID", "cli:conversation"), button("Prompt flags", "cli:prompt")],
      [button("‹ Back", "menu:main")],
    ],
  };
}

export function outputFormatKeyboard(context: AppContext, chatId: ChatId): InlineKeyboardMarkup {
  const selected = settingsFor(context, chatId).outputFormat;
  return {
    inline_keyboard: [
      ["text", "json", "stream-json"].map((value) => button(`${selected === value ? "✅ " : ""}${value}`, `set:output:${value}`)),
      [button("‹ Back", "menu:cli")],
    ],
  };
}
