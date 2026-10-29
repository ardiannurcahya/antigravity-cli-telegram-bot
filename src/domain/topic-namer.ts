import { spawn } from "node:child_process";
import { parseStreamOutput } from "../agy-runner.js";
import { childEnvironment } from "../infra/safe-env.js";
import { parseChatTarget } from "../telegram/client.js";
import type { AppConfig, ChatId } from "../types.js";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function truncateGraphemes(text: string, maxGraphemes: number): string {
  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);
  if (graphemes.length <= maxGraphemes) return text;
  return graphemes.slice(0, maxGraphemes).join("");
}

export function sanitizeTopicName(raw: string): string {
  // Strip quotes, backticks, newlines, markdown
  const cleaned = raw
    .replace(/["`*#_~\[\]]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();

  // Keep emoji + max 4-5 chars (max 6 graphemes total, e.g. 🚀Deploy, 🐛Bugfix)
  return truncateGraphemes(cleaned, 6);
}

export function resolveEffectiveForumThreadId(
  chatId: ChatId,
  enableTopics = false
): { chatId: number | string; threadId?: number } {
  const target = parseChatTarget(chatId);
  if (target.messageThreadId !== undefined) {
    return { chatId: target.chatId, threadId: target.messageThreadId };
  }
  const isGroupChat = String(target.chatId).trim().startsWith("-");
  if (enableTopics && isGroupChat) {
    return { chatId: target.chatId, threadId: 1 };
  }
  return { chatId: target.chatId, threadId: undefined };
}

export function formatDefaultTopicResetName(threadId: number, customPrefix?: string): string {
  const prefix = customPrefix?.trim();
  if (prefix) return `${prefix}${threadId}`;
  return threadId === 1 ? "General" : `Topic ${threadId}`;
}

export function resolveAutoTopicModel(config: AppConfig, sessionModel?: string | null): string {
  return (
    config.telegram?.autoTopicModel?.trim() ||
    config.agy?.model?.trim() ||
    sessionModel?.trim() ||
    config.stt?.agyModel?.trim() ||
    "gemini-3.8-flash-low"
  );
}

export function buildTopicShortNamePrompt(prompt: string, replyText?: string): string {
  const cleanPrompt = prompt.replace(/\s+/g, " ").slice(0, 300);
  const cleanReply = replyText ? replyText.replace(/\s+/g, " ").slice(0, 300) : "";

  return `Generate a 1-emoji plus 4-5 letter ultra-compact topic label for this conversation turn.
Examples: 🚀Deploy, 🐛Bugfix, 🔒Auth, 📦Docker, 💡Idea.
Rule: 1 emoji immediately followed by 3 to 5 characters describing the topic in the user's language. Total max 6 glyphs.
Output ONLY the label (e.g. 🚀Deploy), without any explanations, quotes, or markdown.

User prompt: ${cleanPrompt}
Assistant answer: ${cleanReply}`;
}

export async function generateTopicShortName(
  config: AppConfig,
  prompt: string,
  replyText?: string,
  signal?: AbortSignal,
  sessionModel?: string | null,
  onEphemeralConversation?: (conversationId: string) => void
): Promise<string | null> {
  if (!config.agy?.bin) return null;

  const taskPrompt = buildTopicShortNamePrompt(prompt, replyText);
  const model = resolveAutoTopicModel(config, sessionModel);

  const args = [
    "--print",
    taskPrompt,
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--disable-slash-commands",
  ];

  if (!/-(low|medium|high)$/.test(model)) {
    args.push("--effort", "low");
  }

  if (config.agy.allowDangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  return new Promise((resolve) => {
    let stdout = "";
    const proc = spawn(config.agy.bin, args, {
      env: childEnvironment(),
      signal,
    });

    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(null);
    }, 30_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const parsed = stdout.trim() ? parseStreamOutput(stdout) : null;
      if (parsed?.conversationId) {
        try {
          onEphemeralConversation?.(parsed.conversationId);
        } catch {
          // ignore cleanup callback errors
        }
      }
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      const rawText = parsed && parsed.events.length > 0 ? parsed.text : stdout;
      if (!rawText || rawText === "AGY returned no output.") {
        resolve(null);
        return;
      }
      const rawFirstLine = rawText.trim().split("\n")[0].trim();
      const sanitized = sanitizeTopicName(rawFirstLine);
      resolve(sanitized || null);
    });
  });
}
