import type { AppContext } from "../context.js";
import { formatDefaultTopicResetName, resolveEffectiveForumThreadId } from "../domain/topic-namer.js";
import type { ChatId } from "../types.js";

export async function resetForumTopicNameIfAutoRenamed(
  context: AppContext,
  chatId: ChatId
): Promise<void> {
  const session = context.state.session(chatId);
  const { chatId: targetChatId, threadId: effectiveThreadId } = resolveEffectiveForumThreadId(
    chatId,
    context.config?.telegram?.enableTopics
  );

  // If this topic was auto-renamed and has a valid forum thread ID (including General topic 1 in supergroups)
  if (session?.hasAutoRenamedTopic && effectiveThreadId !== undefined) {
    const defaultTopicName = formatDefaultTopicResetName(
      effectiveThreadId,
      context.config?.telegram?.topicResetPrefix
    );
    try {
      await context.telegram.editForumTopic(targetChatId, effectiveThreadId, defaultTopicName);
    } catch (error) {
      console.debug(`[TopicReset] Failed to reset topic name: ${(error as Error).message}`);
    }
  }
}
