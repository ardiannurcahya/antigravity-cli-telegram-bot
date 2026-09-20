import type { AppContext } from "../context.js";
import { settingsFor } from "../domain/settings.js";
import { createMainKeyboard } from "../keyboards.js";
import { escapeHtml } from "../telegram.js";
import type { ChatId } from "../types.js";
import { replyWithHtml } from "../ui/reply.js";

export async function handleTitleCommand(
  context: AppContext,
  chatId: ChatId,
  rawTitle: string
): Promise<void> {
  const settings = settingsFor(context, chatId);
  const title = rawTitle.trim();

  if (!title) {
    await replyWithHtml(
      context,
      chatId,
      "Usage: <code>/title &lt;session title&gt;</code> or <code>/rename &lt;session title&gt;</code>\n\nSets a custom name for the active conversation.",
      createMainKeyboard(settings)
    );
    return;
  }

  const session = context.state.session(chatId);
  const conversationId = session?.conversationId;

  if (conversationId) {
    context.convDb.updateConversationTitle(conversationId, title);
  }

  await context.state.setSession(chatId, {
    ...(session || {}),
    conversationTitle: title,
    conversationLastModifiedAt: Date.now(),
    updatedAt: new Date().toISOString(),
  });

  await replyWithHtml(
    context,
    chatId,
    `✅ Active session title updated to:\n<b>${escapeHtml(title)}</b>`,
    createMainKeyboard(settings)
  );
}
