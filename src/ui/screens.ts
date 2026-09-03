import { formatRelativeTime } from "../db.js";
import type { AppContext } from "../context.js";
import { runAgyCommand } from "../agy-runner.js";
import { createMainKeyboard } from "../keyboards.js";
import {
  backKeyboard,
  cliOptionsKeyboard,
  effortKeyboard,
  mainInlineKeyboard,
  modeKeyboard,
  modelKeyboard,
  outputFormatKeyboard,
  resumeKeyboard,
  sandboxKeyboard,
  verboseKeyboard,
} from "./inline-keyboards.js";
import { resumeMessageText, sessionText, settingsText } from "./messages.js";
import { reply, replyWithHtml } from "./reply.js";
import { enqueueJob } from "../usecases/enqueue.js";
import { refreshModels } from "../usecases/model-selection.js";
import { settingsFor } from "../domain/settings.js";
import type { ChatId, InlineKeyboardMarkup } from "../types.js";

export function showMain(context: AppContext, chatId: ChatId, messageId?: number): Promise<void> {
  return showMainInternal(context, chatId, messageId);
}

async function showMainInternal(context: AppContext, chatId: ChatId, messageId?: number): Promise<void> {
  const settings = settingsFor(context, chatId);
  const text = `AGY Telegram\n\n${settingsText(settings)}\n\nUse the two controls beside the input for Model and Mode. Use /menu for the full control panel.`;
  if (messageId) {
    await context.telegram.editMessageText(chatId, messageId, text, mainInlineKeyboard());
    await context.telegram.sendMessage(chatId, "Controls updated.", createMainKeyboard(settings));
  } else {
    await reply(context, chatId, text, mainInlineKeyboard());
    await context.telegram.sendMessage(chatId, "Model and mode controls are ready.", createMainKeyboard(settings));
  }
}

export async function showResumeMenu(context: AppContext, chatId: ChatId, page = 0, messageId?: number): Promise<void> {
  const pageData = context.convDb.getConversations(page, 10);
  const text = resumeMessageText(pageData);
  const keyboard = resumeKeyboard(pageData.page, pageData.totalPages, pageData.items);
  if (messageId) {
    try {
      await context.telegram.editMessageText(chatId, messageId, text, keyboard, "HTML");
    } catch {
      await context.telegram.editMessageText(chatId, messageId, text.replace(/<[^>]+>/g, ""), keyboard).catch(() => undefined);
    }
  } else {
    await replyWithHtml(context, chatId, text, keyboard);
  }
}

export type CliCommand = "models" | "agents" | "changelog" | "plugins" | "help" | "version";
export const CLI_COMMANDS: CliCommand[] = ["models", "agents", "changelog", "plugins", "help", "version"];

export function cliCommandArgs(command: CliCommand): string[] {
  if (command === "models") return ["models"];
  if (command === "agents") return ["agents"];
  if (command === "changelog") return ["changelog"];
  if (command === "plugins") return ["plugins", "list"];
  if (command === "version") return ["--version"];
  return ["--help"];
}

export async function cliOutput(context: AppContext, chatId: ChatId, messageId: number, command: CliCommand): Promise<void> {
  await context.telegram.editMessageText(chatId, messageId, `Running agy ${cliCommandArgs(command).join(" ")}...`);
  try {
    const output = await runAgyCommand(context.config.agy, cliCommandArgs(command));
    const title = command === "help" ? "AGY CLI help" : `AGY ${command}`;
    await reply(context, chatId, `${title}\n\n${output}`, createMainKeyboard(settingsFor(context, chatId)));
  } catch (error) {
    await reply(context, chatId, `Could not read AGY ${command}: ${(error as Error).message}`, createMainKeyboard(settingsFor(context, chatId)));
  }
}

export async function showCliOption(context: AppContext, chatId: ChatId, messageId: number, option: string): Promise<void> {
  const examples: Record<string, string> = {
    project: "/agy --project PROJECT --print \"prompt\"",
    agent: "/agy --agent NAME --print \"prompt\"",
    continue: "/agy --continue --print \"prompt\"",
    "new-project": "/agy --new-project --print \"prompt\"",
    "output-format": "/agy --output-format text --print \"prompt\"",
    "disable-slash": "/agy --disable-slash-commands --print \"prompt\"",
    "add-dir": "/agy --add-dir /path --print \"prompt\"",
    "json-schema": "/agy --json-schema '{\"type\":\"object\"}' --print \"prompt\"",
    "log-file": "/agy --log-file /path/log --print \"prompt\"",
    "print-timeout": "/agy --print-timeout 10m --print \"prompt\"",
    conversation: "/agy --conversation CONVERSATION_ID --print \"prompt\"",
    prompt: "/agy --print \"prompt\" --output-format stream-json",
  };
  await context.telegram.editMessageText(chatId, messageId, `Use this custom command:\n\n${examples[option] || "/agy --help"}`, backKeyboard());
}

export async function showMenu(context: AppContext, chatId: ChatId, messageId: number, kind: string, page = 0): Promise<void> {
  if (kind === "main") return showMain(context, chatId, messageId);
  if (kind === "model" || kind === "models") {
    await refreshModels(context);
    return context.telegram.editMessageText(chatId, messageId, "Select a model:", modelKeyboard(context, chatId, page));
  }
  if (kind === "effort") return context.telegram.editMessageText(chatId, messageId, "Select reasoning effort:", effortKeyboard(context, chatId));
  if (kind === "mode") return context.telegram.editMessageText(chatId, messageId, "Select execution mode:", modeKeyboard(context, chatId));
  if (kind === "sandbox") return context.telegram.editMessageText(chatId, messageId, `Sandbox is ${settingsFor(context, chatId).sandbox ? "enabled" : "disabled"}.`, sandboxKeyboard(context, chatId));
  if (kind === "verbose") return context.telegram.editMessageText(chatId, messageId, "Select progress verbosity during execution:", verboseKeyboard(context, chatId));
  if (kind === "session") return context.telegram.editMessageText(chatId, messageId, sessionText(context, chatId), backKeyboard());
  if (kind === "resume") return showResumeMenu(context, chatId, page, messageId);
  if (kind === "usage") { enqueueJob(context, chatId, { kind: "usage" }); return; }
  if (kind === "credits") { enqueueJob(context, chatId, { kind: "credits" }); return; }
  if (kind === "cli") return context.telegram.editMessageText(chatId, messageId, "All AGY CLI flags are available with /agy. Common session flags can be set here; options that need a path or value have a command example.", cliOptionsKeyboard(context, chatId));
  if (kind === "output") return context.telegram.editMessageText(chatId, messageId, "Select the output format used by future normal prompts:", outputFormatKeyboard(context, chatId));
  if (kind === "custom") return context.telegram.editMessageText(chatId, messageId, "Custom AGY command\n\nUse /agy followed by any non-interactive AGY arguments. Example:\n/agy --print \"Explain this project\" --output-format text\n\nInteractive TTY mode is unavailable through Telegram.", backKeyboard());
  if (kind === "plugins") return context.telegram.editMessageText(chatId, messageId, "Plugin commands\n\nRead-only:\n/agy plugin list\n\nMutating commands require /agy-confirm after the bot asks for confirmation:\n/agy plugin install NAME\n/agy plugin uninstall NAME\n/agy plugin enable NAME\n/agy plugin disable NAME\n/agy update", backKeyboard());
}
