import { runAgyCommand, validateCustomArgs, TOP_LEVEL_COMMANDS } from "../agy-runner.js";
import type { AppContext } from "../context.js";
import { controllerKey } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { settingsFor } from "../domain/settings.js";
import { reply } from "../ui/reply.js";
import type { ChatId } from "../types.js";

export function isDangerousCustomCommand(args: string[]): boolean {
  const subcommand = args[0];
  const pluginAction = ["install", "uninstall", "enable", "disable", "import", "link"].includes(args[1] || "");
  return args.includes("--dangerously-skip-permissions") || subcommand === "update" || subcommand === "install" ||
    ((subcommand === "plugin" || subcommand === "plugins") && pluginAction);
}

function customArgsForExecution(context: AppContext, args: string[]): string[] {
  let isPrintCommand = args.includes("--print") || args.includes("-p") || args.includes("--prompt");
  let executionArgs = [...args];
  const first = args[0] || "";
  if (!isPrintCommand && !TOP_LEVEL_COMMANDS.has(first) && !["--help", "-h", "--version", "-v"].includes(first)) {
    executionArgs = ["--print", args.join(" ")];
    isPrintCommand = true;
  }
  if (isPrintCommand && context.config.agy.sandbox && !context.config.agy.allowSandboxDisable && !executionArgs.includes("--sandbox")) executionArgs.push("--sandbox");
  return executionArgs;
}

export async function runCustomAgy(context: AppContext, chatId: ChatId, args: string[], confirmed = false): Promise<void> {
  const validation = validateCustomArgs(args);
  if (validation) { await reply(context, chatId, validation, createMainKeyboard(settingsFor(context, chatId))); return; }
  if (args.includes("--dangerously-skip-permissions") && !context.config.agy.allowDangerouslySkipPermissions) {
    await reply(context, chatId, "--dangerously-skip-permissions is disabled by server policy.", createMainKeyboard(settingsFor(context, chatId))); return;
  }
  if (isDangerousCustomCommand(args) && !confirmed) {
    context.pendingDangerousCommands.set(String(chatId), args);
    await reply(context, chatId, `This command can change the AGY installation, plugins, or permission policy:\n\nagy ${args.join(" ")}\n\nSend /agy-confirm to execute it, or /cancel to discard it.`, createMainKeyboard(settingsFor(context, chatId)));
    return;
  }
  const executionArgs = customArgsForExecution(context, args);
  context.pendingDangerousCommands.delete(String(chatId));
  await reply(context, chatId, `Running agy ${executionArgs.join(" ")}...`, createMainKeyboard(settingsFor(context, chatId)));
  const controller = new AbortController();
  context.controllers.set(controllerKey("custom", chatId), controller);
  try {
    const output = await runAgyCommand(context.config.agy, executionArgs, context.config.agy.timeoutMs, controller.signal);
    await reply(context, chatId, `AGY command result\n\n${output}`, createMainKeyboard(settingsFor(context, chatId)));
  } catch (error) {
    if (!controller.signal.aborted) await reply(context, chatId, `AGY command failed: ${(error as Error).message}`, createMainKeyboard(settingsFor(context, chatId)));
  } finally {
    if (context.controllers.get(controllerKey("custom", chatId)) === controller) context.controllers.delete(controllerKey("custom", chatId));
  }
}
