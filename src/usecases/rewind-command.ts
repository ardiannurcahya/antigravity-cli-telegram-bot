import type { AppContext } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { settingsFor } from "../domain/settings.js";
import { escapeHtml } from "../telegram.js";
import { replyWithHtml } from "../ui/reply.js";
import type { ChatId } from "../types.js";

export interface RewindResult {
  /** Conversation id to make active, or null when the history is exhausted. */
  targetId: string | null;
  /** History remaining after the rewind. */
  remaining: string[];
  /** How many snapshots were actually stepped back. */
  steps: number;
}

/**
 * Pop up to `requested` ids from the rewind history. Pure so it can be unit
 * tested without a session or the conversation database.
 */
export function computeRewind(history: string[] | undefined, requested: number): RewindResult {
  const stack = [...(history ?? [])];
  const steps = Math.min(Math.max(Math.trunc(requested) || 1, 1), stack.length);
  let targetId: string | null = null;
  for (let i = 0; i < steps; i += 1) {
    targetId = stack.pop() ?? targetId;
  }
  return { targetId, remaining: stack, steps };
}

/** Parse the `/rewind [n]` argument into a positive turn count (defaults to 1). */
export function parseRewindCount(arg: string): number {
  const n = Number.parseInt(arg.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export async function handleRewindCommand(context: AppContext, chatId: ChatId, arg: string): Promise<void> {
  const keyboard = createMainKeyboard(settingsFor(context, chatId));
  const session = context.state.session(chatId);
  if (!session?.conversationId) {
    await replyWithHtml(context, chatId, "No active conversation to rewind. Send a prompt first.", keyboard);
    return;
  }

  const history = session.conversationHistory ?? [];
  if (history.length === 0) {
    await replyWithHtml(context, chatId, "Nothing to rewind — this is the first turn. Use <code>/new</code> to start fresh.", keyboard);
    return;
  }

  const requested = parseRewindCount(arg);
  const { targetId, remaining, steps } = computeRewind(history, requested);
  if (!targetId) {
    await replyWithHtml(context, chatId, "Nothing to rewind — this is the first turn. Use <code>/new</code> to start fresh.", keyboard);
    return;
  }

  const summary = context.convDb.getConversationById(targetId);
  await context.state.setSession(chatId, {
    conversationId: targetId,
    conversationHistory: remaining,
    ...(summary ? {
      conversationTitle: summary.display_title,
      conversationStepCount: summary.step_count,
      conversationLastModifiedAt: summary.last_modified_time,
    } : {}),
    updatedAt: new Date().toISOString(),
  });

  const title = summary?.display_title ? `\n\n<b>${escapeHtml(summary.display_title)}</b>` : "";
  const stepNote = summary?.step_count !== undefined ? ` · ${summary.step_count} steps` : "";
  const turnWord = steps === 1 ? "turn" : "turns";
  const atStart = remaining.length === 0 ? "\n\nYou are back at the start of this conversation." : "";
  await replyWithHtml(
    context,
    chatId,
    `⏪ Rewound ${steps} ${turnWord}. Future prompts resume from here.${title}${stepNote}${atStart}`,
    keyboard
  );
}
