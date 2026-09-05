import type { AppContext } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { settingsFor } from "../domain/settings.js";
import { reply } from "../ui/reply.js";
import type { QueueJob } from "../queue.js";
import type { ChatId } from "../types.js";

export function enqueueJob(context: AppContext, chatId: ChatId, job: Partial<QueueJob>): void {
  const status = context.queue.statusForChat(chatId);
  let effectivePrompt = job.prompt;
  if (context.config.telegram.autoInterrupt) {
    const queuedPrompts = context.queue.pendingForChat(chatId)
      .map((j) => j.prompt)
      .filter(Boolean) as string[];

    const parts: string[] = [];
    if (status.active?.prompt && (job.kind === "prompt" || !job.kind)) {
      parts.push(status.active.prompt);
    }
    if (queuedPrompts.length > 0) {
      parts.push(...queuedPrompts);
    }
    if (job.prompt) {
      parts.push(parts.length > 0 ? `[Update / Follow-up]: ${job.prompt}` : job.prompt);
    }
    if (parts.length > 0) {
      effectivePrompt = parts.join("\n\n");
    }
    if (status.active || status.queued > 0) {
      context.queue.cancelForChat(chatId);
    }
  }
  const result = context.queue.enqueue({
    chatId,
    kind: job.kind || "prompt",
    prompt: effectivePrompt,
    imagePath: job.imagePath,
    documentPath: job.documentPath,
    documentName: job.documentName,
    mediaPath: job.mediaPath,
    mediaType: job.mediaType,
    wasVoiceInput: job.wasVoiceInput,
  });
  if (!result.accepted) {
    void reply(context, chatId, "Queue is full. Try again shortly.", createMainKeyboard(settingsFor(context, chatId)));
  } else if (result.position !== undefined && result.position > 1) {
    void reply(context, chatId, `⏳ Queued at position #${result.position}.`, createMainKeyboard(settingsFor(context, chatId)));
  }
}
