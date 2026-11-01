import type { AppContext } from "../context.js";
import { settingsFor } from "../domain/settings.js";
import { createMainKeyboard } from "../keyboards.js";
import { escapeHtml } from "../telegram.js";
import type { ChatId } from "../types.js";
import { replyWithHtml } from "../ui/reply.js";
import { refreshActiveMenu } from "../ui/screens.js";

/**
 * Rolls back the active AGY conversation by N user turns (default: 1) in the
 * SQLite store and JSONL transcripts, updating the active session state.
 */
export async function handleRewindCommand(
  context: AppContext,
  chatId: ChatId,
  rawArg: string
): Promise<void> {
  const settings = settingsFor(context, chatId);
  const trimmed = rawArg.trim();

  let turns = 1;
  if (trimmed.length > 0) {
    if (!/^\d+$/.test(trimmed)) {
      await replyWithHtml(
        context,
        chatId,
        "Usage: <code>/rewind [turns]</code> or <code>/undo [turns]</code>\n\nExample: <code>/rewind</code> (roll back 1 turn) or <code>/rewind 2</code>.",
        createMainKeyboard(settings)
      );
      return;
    }
    turns = Number(trimmed);
    if (!Number.isSafeInteger(turns) || turns < 1 || turns > 50) {
      await replyWithHtml(
        context,
        chatId,
        "⚠️ Please specify a valid number of turns between 1 and 50 (e.g. <code>/rewind 1</code>).",
        createMainKeyboard(settings)
      );
      return;
    }
  }

  const session = context.state.session(chatId);
  const conversationId = session?.conversationId;
  if (!conversationId) {
    await replyWithHtml(
      context,
      chatId,
      "⚠️ <b>No active conversation to rewind.</b>\n\nStart a conversation or resume one with <code>/resume</code> first.",
      createMainKeyboard(settings)
    );
    return;
  }

  const result = context.convDb.rewindConversation(conversationId, turns);
  if (!result.ok) {
    if (result.reason === "cannot_rewind_initial_turn") {
      const available = result.totalTurns && result.totalTurns > 1
        ? `Only ${result.totalTurns - 1} turn(s) can be rewound while keeping the initial prompt.`
        : "Cannot rewind past the initial turn of the conversation.";
      await replyWithHtml(
        context,
        chatId,
        `⚠️ <b>Cannot rewind ${turns} turn${turns === 1 ? "" : "s"}.</b>\n\n${escapeHtml(available)} Use <code>/new</code> if you want to start a fresh session.`,
        createMainKeyboard(settings)
      );
      return;
    }

    await replyWithHtml(
      context,
      chatId,
      "⚠️ <b>Could not rewind the active conversation.</b>\n\nThe conversation history could not be found in the local store.",
      createMainKeyboard(settings)
    );
    return;
  }

  const remainingSteps = result.remainingSteps ?? Math.max(1, (session?.conversationStepCount || 1) - (result.removedSteps || turns));

  await context.state.setSession(chatId, {
    ...(session || {}),
    conversationStepCount: remainingSteps,
    contextTokens: undefined,
    contextPercentage: undefined,
    conversationLastModifiedAt: Date.now(),
    updatedAt: new Date().toISOString(),
  });

  await refreshActiveMenu(context, chatId);

  const lines = [
    "⏪ <b>Conversation rewound</b>\n",
    `• <b>Rolled back:</b> ${result.removedTurns} turn${result.removedTurns === 1 ? "" : "s"} (${result.removedSteps} step${result.removedSteps === 1 ? "" : "s"} removed)`,
    `• <b>Remaining history:</b> ${remainingSteps} step${remainingSteps === 1 ? "" : "s"}`,
  ];
  if (result.rewoundPromptPreview) {
    lines.push(`• <b>Rewound prompt:</b> <i>"${escapeHtml(result.rewoundPromptPreview)}"</i>`);
  }
  lines.push("\nFuture prompts will continue from this earlier checkpoint.");

  await replyWithHtml(context, chatId, lines.join("\n"), createMainKeyboard(settings));
}
