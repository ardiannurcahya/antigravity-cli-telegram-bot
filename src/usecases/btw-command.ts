import type { AppContext } from "../context.js";
import { createMainKeyboard } from "../keyboards.js";
import { modelLabel } from "../models.js";
import type { QueueJob } from "../queue.js";
import { escapeHtml } from "../telegram.js";
import { formatStepUpdate, runAgy } from "../agy-runner.js";
import { settingsFor } from "../domain/settings.js";
import { reply, replyWithFormattedResponse, replyWithHtml } from "../ui/reply.js";
import { enqueueJob } from "./enqueue.js";
import type { ChatId, StreamEvent } from "../types.js";

/**
 * Handles the `/btw <question>` command by validating the query and enqueueing
 * an isolated side-question job that leaves the active session untouched.
 */
export async function handleBtwCommand(
  context: AppContext,
  chatId: ChatId,
  rawQuery: string
): Promise<void> {
  const settings = settingsFor(context, chatId);
  const query = rawQuery.trim();

  if (!query) {
    await replyWithHtml(
      context,
      chatId,
      "Usage: <code>/btw &lt;question&gt;</code>\n\nAsk a side question without altering or polluting the active conversation history.",
      createMainKeyboard(settings)
    );
    return;
  }

  void context.telegram.sendChatAction(chatId, "typing").catch(() => undefined);
  enqueueJob(context, chatId, {
    kind: "btw",
    prompt: query,
  });
}

/**
 * Executes an isolated `/btw` side question in one-shot mode (`conversationId = null`,
 * `continueSession = false`), cleans up any temporary conversation record created
 * by AGY CLI, and preserves the chat's active session state unaltered.
 */
export async function runBtwJob(
  context: AppContext,
  job: QueueJob,
  controller: AbortController,
  isCancelled: () => boolean
): Promise<void> {
  let progressMessage: { message_id: number } | null = null;
  let typingInterval: NodeJS.Timeout | null = null;
  const settings = settingsFor(context, job.chatId);
  const session = context.state.session(job.chatId);
  const effectiveWorkspace = settings.workspace || context.config.agy.workspace;
  const effectiveAgyConfig = effectiveWorkspace === context.config.agy.workspace
    ? context.config.agy
    : { ...context.config.agy, workspace: effectiveWorkspace };

  try {
    await context.telegram.sendChatAction(job.chatId, "typing").catch(() => undefined);
    typingInterval = setInterval(() => {
      context.telegram.sendChatAction(job.chatId, "typing").catch(() => undefined);
    }, 4000);

    progressMessage = await context.telegram.sendMessage(
      job.chatId,
      `💬 <b>Side question (/btw):</b> thinking... (${escapeHtml(modelLabel(settings.model))})`,
      undefined,
      "HTML"
    );

    const queryText = (job.prompt || "").trim();
    const activeContextHint = session?.conversationTitle
      ? `[Side question (/btw) — Active session topic: "${session.conversationTitle}". Answer this side question concisely without modifying project files.]\n\n`
      : "[Side question (/btw) — Answer this question concisely without modifying project files.]\n\n";
    const fullPrompt = `${activeContextHint}${queryText}`;

    let lastEditAt = Date.now();
    const result = await runAgy(effectiveAgyConfig, fullPrompt, null, {
      ...settings,
      continueSession: false,
      signal: controller.signal,
      onEvent: (event: StreamEvent) => {
        if (!progressMessage || settings.verbose === "silent") return;
        const step = event.step_update as Record<string, unknown> | undefined;
        const stepDesc = formatStepUpdate(step);
        if (stepDesc && Date.now() - lastEditAt >= 4500) {
          lastEditAt = Date.now();
          void context.telegram.editMessageText(
            job.chatId,
            progressMessage.message_id,
            `💬 <b>Side question (/btw):</b> ${escapeHtml(stepDesc)}`,
            undefined,
            "HTML"
          ).catch(() => undefined);
        }
      },
    });

    // Clean up the ephemeral conversation created by AGY CLI so it never pollutes /resume
    if (result.conversationId && result.conversationId !== session?.conversationId) {
      context.convDb.deleteConversation(result.conversationId);
    }

    if (isCancelled() || controller.signal.aborted) {
      if (progressMessage) {
        await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      }
      return;
    }

    if (progressMessage) {
      await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
    }

    const answerBody = (result.text || "").trim() || "(No output returned)";
    const formattedOutput = `**💬 Side question (/btw)** *(main session untouched)*\n\n${answerBody}`;
    await replyWithFormattedResponse(
      context,
      job.chatId,
      formattedOutput,
      createMainKeyboard(settings)
    );
  } catch (error) {
    if (!isCancelled() && !controller.signal.aborted) {
      const errorMsg = (error as Error).message;
      if (progressMessage) {
        await context.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
      }
      await reply(
        context,
        job.chatId,
        `Side question (/btw) failed: ${errorMsg}`,
        createMainKeyboard(settings)
      );
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
}
