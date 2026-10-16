import type { AppContext } from "../context.js";
import { settingsFor } from "../domain/settings.js";
import { createMainKeyboard } from "../keyboards.js";
import { escapeHtml } from "../telegram.js";
import type { ChatId } from "../types.js";
import { replyWithHtml } from "../ui/reply.js";
import { refreshActiveMenu } from "../ui/screens.js";

/**
 * Clones the active AGY conversation into a new independent branch in SQLite
 * and switches the chat's active session to the newly created fork.
 */
export async function handleForkCommand(
  context: AppContext,
  chatId: ChatId,
  rawCustomTitle: string
): Promise<void> {
  const settings = settingsFor(context, chatId);
  const session = context.state.session(chatId);
  const sourceId = session?.conversationId;

  if (!sourceId) {
    await replyWithHtml(
      context,
      chatId,
      "⚠️ <b>No active conversation to fork.</b>\n\nStart a conversation or resume one with <code>/resume</code> first.",
      createMainKeyboard(settings)
    );
    return;
  }

  const effectiveWorkspace = settings.workspace || context.config.agy.workspace;
  const customTitle = rawCustomTitle.trim() || undefined;
  const forked = context.convDb.forkConversation(sourceId, customTitle, {
    title: session?.conversationTitle || "Conversation",
    stepCount: session?.conversationStepCount || 1,
    workspace: effectiveWorkspace,
    projectId: settings.project || "default-cli-project",
  });

  if (!forked) {
    await replyWithHtml(
      context,
      chatId,
      "⚠️ <b>Failed to fork the active conversation.</b>\n\nVerify that the conversation database is accessible and try again.",
      createMainKeyboard(settings)
    );
    return;
  }

  await context.state.setSession(chatId, {
    ...(session || {}),
    conversationId: forked.conversationId,
    conversationTitle: forked.title,
    conversationStepCount: forked.stepCount,
    conversationLastModifiedAt: Date.now(),
    updatedAt: new Date().toISOString(),
  });

  await refreshActiveMenu(context, chatId);

  const lines = [
    "🔀 <b>Conversation forked</b>\n",
    `• <b>New branch:</b> <b>${escapeHtml(forked.title)}</b> (<code>${escapeHtml(forked.conversationId.slice(0, 8))}…</code>)`,
    `• <b>Parent session:</b> <code>${escapeHtml(forked.parentConversationId.slice(0, 8))}…</code> (${forked.stepCount} step${forked.stepCount === 1 ? "" : "s"} preserved)\n`,
    "Future prompts will continue on this new branch. Use <code>/resume</code> anytime to switch back to the original session.",
  ];

  await replyWithHtml(context, chatId, lines.join("\n"), createMainKeyboard(settings));
}
