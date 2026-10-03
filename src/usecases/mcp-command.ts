import { runAgyCommand } from "../agy-runner.js";
import type { AppContext } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { backKeyboard } from "../ui/inline-keyboards.js";
import { settingsFor } from "../domain/settings.js";
import { escapeHtml } from "../telegram.js";
import { reply, replyWithHtml } from "../ui/reply.js";
import type { ChatId } from "../types.js";

export interface McpServerItem {
  name: string;
  type: string;
  status: string;
  commandOrUrl: string;
}

export function sanitizeSecrets(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]{35,}/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/(?:api[_-]?key|secret|token|password|bearer)[=:\s]+["']?([A-Za-z0-9_-]{16,})["']?/gi, (match, secret) => match.replace(secret, "[REDACTED]"));
}

export function parseMcpList(rawOutput: string): McpServerItem[] {
  const lines = rawOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = lines[0].toLowerCase();
  if (!header.includes("name") || !header.includes("status")) {
    return [];
  }
  const items: McpServerItem[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(/\s+/);
    if (parts.length >= 3) {
      const name = parts[0];
      const type = parts[1];
      const status = parts[2];
      const commandOrUrl = parts.slice(3).join(" ");
      items.push({ name, type, status, commandOrUrl });
    }
  }
  return items;
}

export function formatMcpHtml(rawOutput: string): string {
  const servers = parseMcpList(rawOutput);
  if (!servers.length) {
    if (rawOutput.trim().length === 0 || rawOutput.includes("NAME")) {
      return "🛠️ <b>AGY MCP Servers</b>\n\nNo configured MCP servers.";
    }
    return `🛠️ <b>AGY MCP Servers</b>\n\n<pre>${escapeHtml(sanitizeSecrets(rawOutput))}</pre>`;
  }

  const header = `🛠️ <b>Configured MCP Servers (${servers.length})</b>\n\n`;
  const list = servers.map((s) => {
    const statusLower = s.status.toLowerCase();
    const statusIcon = statusLower === "enabled" ? "🟢" : "🔴";
    const statusText = `<i>${escapeHtml(s.status)}</i>`;
    const cleanDetails = sanitizeSecrets(s.commandOrUrl);
    const details = cleanDetails ? `\n  <code>${escapeHtml(cleanDetails)}</code>` : "";
    return `• <b>${escapeHtml(s.name)}</b> (${escapeHtml(s.type)}) — ${statusIcon} ${statusText}${details}`;
  }).join("\n\n");

  return `${header}${list}`;
}

export async function handleMcpCommand(context: AppContext, chatId: ChatId, messageId?: number): Promise<void> {
  const settings = settingsFor(context, chatId);
  const workspacePath = settings.workspace || context.config.agy.workspace;
  const effectiveAgyConfig = workspacePath === context.config.agy.workspace
    ? context.config.agy
    : { ...context.config.agy, workspace: workspacePath };

  try {
    const output = await runAgyCommand(effectiveAgyConfig, ["mcp", "list"], context.config.agy.timeoutMs);
    const html = formatMcpHtml(output);
    if (messageId) {
      try {
        await context.telegram.editMessageText(chatId, messageId, html, backKeyboard(), "HTML");
      } catch {
        await context.telegram.editMessageText(chatId, messageId, html.replace(/<[^>]+>/g, ""), backKeyboard()).catch(() => undefined);
      }
    } else {
      await replyWithHtml(context, chatId, html, createMainKeyboard(settingsFor(context, chatId)));
    }
  } catch (error) {
    const errorText = `Could not read AGY MCP servers: ${(error as Error).message}`;
    if (messageId) {
      await context.telegram.editMessageText(chatId, messageId, errorText, backKeyboard()).catch(() => undefined);
    } else {
      await reply(context, chatId, errorText, createMainKeyboard(settingsFor(context, chatId)));
    }
  }
}
