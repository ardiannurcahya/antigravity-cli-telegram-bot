import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatId, InlineKeyboardMarkup, ReplyMarkup, TelegramUpdate } from "../types.js";

const API_ROOT = (token: string): string => `https://api.telegram.org/bot${token}`;
export type TelegramParseMode = "HTML";

export class TelegramApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof TelegramApiError) {
    if (error.statusCode === 429) return true;
    if (error.statusCode && error.statusCode >= 500 && error.statusCode <= 599) return true;
    return false;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    const msg = error.message.toLowerCase();
    if (
      msg.includes("fetch failed") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound") ||
      msg.includes("ehostunreach") ||
      msg.includes("enetunreach") ||
      msg.includes("eai_again") ||
      msg.includes("socket hang up") ||
      msg.includes("timeout") ||
      msg.includes("und_err")
    ) {
      return true;
    }
    if (error.name === "TypeError" && msg.includes("fetch")) return true;
  }
  return false;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const signal = options.signal;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw new Error("Request cancelled");
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (signal?.aborted) {
        throw error;
      }

      if (attempt === maxRetries || !isRetryableNetworkError(error)) {
        throw error;
      }

      let delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt) + Math.floor(Math.random() * 150);
      if (error instanceof TelegramApiError && typeof error.retryAfter === "number" && error.retryAfter > 0) {
        delayMs = Math.min(maxDelayMs, error.retryAfter * 1000);
      }

      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

/** True when the failure looks like a transient transport problem worth retrying. */
export function isRetryableTransportErrorMessage(message: string): boolean {
  // Telegram answers stale inline-button presses with a *permanent* Bad Request
  // whose text mentions "timeout"; retrying those only spams the journal.
  if (message.includes("query is too old") || message.includes("message is not modified")) return false;
  return message.includes("fetch failed") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNRESET") ||
    message.includes("ENETUNREACH") ||
    message.includes("timeout") ||
    message.includes("TimeoutError") ||
    false;
}

export function parseChatTarget(chatId: ChatId): { chatId: number | string; messageThreadId?: number } {
  if (typeof chatId === "string" && chatId.includes(":")) {
    const [rawChat, rawThread] = chatId.split(":");
    const threadId = parseInt(rawThread, 10);
    if (!isNaN(threadId)) {
      return { chatId: isNaN(Number(rawChat)) ? rawChat : Number(rawChat), messageThreadId: threadId };
    }
  }
  return { chatId };
}

export class TelegramClient {
  private readonly root: string;
  public constructor(private readonly token: string) { this.root = API_ROOT(token); }
  public async call<T>(method: string, payload: Record<string, unknown> = {}, signal?: AbortSignal, maxRetries = 4): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const timeoutMs = method === "getUpdates" ? 45_000 : 25_000;
        const callSignal = signal || AbortSignal.timeout(timeoutMs);
        const response = await fetch(`${this.root}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: callSignal,
        });

        const body = await response.json() as {
          ok: boolean;
          result?: T;
          description?: string;
          error_code?: number;
          parameters?: { retry_after?: number };
        };

        if (response.ok && body.ok) return body.result as T;

        const retryAfter = body.parameters?.retry_after ?? (
          typeof body.description === "string" && /retry after (\d+)/i.test(body.description)
            ? parseInt(body.description.match(/retry after (\d+)/i)![1], 10)
            : null
        );

        if (response.status === 429 || body.error_code === 429 || retryAfter !== null) {
          const waitSec = retryAfter ?? 2;
          if (waitSec > 30 || attempt >= maxRetries) {
            throw new TelegramApiError(
              `Telegram ${method} failed: Too Many Requests: retry after ${waitSec}`,
              429,
              waitSec
            );
          }
          console.warn(`[telegram] ${method} rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${waitSec}s...`);
          await new Promise((resolve) => setTimeout(resolve, (waitSec + 0.5) * 1000));
          continue;
        }

        if (response.status >= 500 && attempt < maxRetries) {
          const waitMs = Math.min(10000, 1000 * Math.pow(2, attempt));
          console.warn(`[telegram] ${method} server error ${response.status} (attempt ${attempt + 1}/${maxRetries}), waiting ${waitMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        throw new TelegramApiError(`Telegram ${method} failed: ${body.description || response.status}`, body.error_code ?? response.status, retryAfter ?? undefined);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (signal?.aborted) throw lastError;
        if (lastError instanceof TelegramApiError) throw lastError;

        const isNetworkErr = isRetryableTransportErrorMessage(lastError.message) || lastError.name === "TimeoutError";

        if (isNetworkErr && attempt < maxRetries) {
          const waitMs = Math.min(8000, 1000 * Math.pow(2, attempt));
          console.warn(`[telegram] ${method} network error: ${lastError.message} (attempt ${attempt + 1}/${maxRetries}), retrying in ${waitMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error(`Telegram ${method} failed: max retries reached`);
  }
  public getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> { return this.call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, signal); }
  public sendMessage(chatId: ChatId, text: string, replyMarkup?: ReplyMarkup, parseMode?: TelegramParseMode): Promise<{ message_id: number }> {
    const target = parseChatTarget(chatId);
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: target.chatId,
      ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
  public async editMessageText(
    chatId: ChatId,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    parseMode?: TelegramParseMode
  ): Promise<void> {
    const target = parseChatTarget(chatId);
    try {
      await this.call("editMessageText", {
        chat_id: target.chatId,
        message_id: messageId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }, undefined, 0);
    } catch (error) {
      if (error instanceof Error && (error.message.includes("message is not modified") || error.message.includes("Too Many Requests"))) return;
      throw error;
    }
  }
  public async deleteMessage(chatId: ChatId, messageId: number): Promise<boolean> {
    const target = parseChatTarget(chatId);
    try {
      return await this.call<boolean>("deleteMessage", { chat_id: target.chatId, message_id: messageId }, undefined, 0);
    } catch {
      return false;
    }
  }
  public answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> { return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }, undefined, 0).catch(() => false); }
  public setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> { return this.call<boolean>("setMyCommands", { commands }); }
  public async editForumTopic(chatId: number | string, messageThreadId: number, name: string): Promise<boolean> {
    try {
      if (messageThreadId === 1) {
        return await this.call<boolean>("editGeneralForumTopic", {
          chat_id: chatId,
          name: name.slice(0, 128),
        }, undefined, 0);
      }
      return await this.call<boolean>("editForumTopic", {
        chat_id: chatId,
        message_thread_id: messageThreadId,
        name: name.slice(0, 128),
      }, undefined, 0);
    } catch (error) {
      try {
        return await this.call<boolean>("editGeneralForumTopic", {
          chat_id: chatId,
          name: name.slice(0, 128),
        }, undefined, 0);
      } catch {
        console.warn("[telegram] Failed to edit forum topic %s: %s", String(messageThreadId), (error as Error).message);
        return false;
      }
    }
  }
  public sendChatAction(chatId: ChatId, action = "typing"): Promise<boolean> {
    const target = parseChatTarget(chatId);
    return this.call<boolean>("sendChatAction", {
      chat_id: target.chatId,
      ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
      action,
    }, undefined, 0).catch(() => false);
  }
  public async sendDocument(chatId: ChatId, filename: string, content: string, _signal?: AbortSignal, maxRetries = 3): Promise<unknown> {
    const target = parseChatTarget(chatId);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const form = new FormData();
        form.append("chat_id", String(target.chatId));
        if (target.messageThreadId !== undefined) {
          form.append("message_thread_id", String(target.messageThreadId));
        }
        form.append("document", new Blob([content], { type: "text/markdown" }), filename);
        const response = await fetch(`${this.root}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(45000) });
        const body = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
        if (response.ok && body.ok) return body.result;
        const retryAfter = body.parameters?.retry_after;
        if (retryAfter && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
          continue;
        }
        throw new TelegramApiError(`Telegram sendDocument failed: ${body.description || response.status}`, body.error_code ?? response.status, retryAfter);
      } catch (err) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Telegram sendDocument failed: max retries reached");
  }
  public async sendPhoto(chatId: ChatId, photoPath: string | Buffer, caption?: string, parseMode?: TelegramParseMode, mimeType?: string, replyMarkup?: ReplyMarkup, _signal?: AbortSignal, maxRetries = 3): Promise<unknown> {
    const target = parseChatTarget(chatId);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const form = new FormData();
        form.append("chat_id", String(target.chatId));
        if (target.messageThreadId !== undefined) {
          form.append("message_thread_id", String(target.messageThreadId));
        }
        if (typeof photoPath === "string") {
          const fileBuffer = await fs.readFile(photoPath);
          const filename = path.basename(photoPath);
          const ext = path.extname(photoPath).toLowerCase();
          const detectedMime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
          form.append("photo", new Blob([new Uint8Array(fileBuffer)], { type: detectedMime }), filename);
        } else {
          const mime = mimeType || "image/png";
          form.append("photo", new Blob([new Uint8Array(photoPath)], { type: mime }), `image.${mime.split("/")[1] || "png"}`);
        }
        if (caption) {
          form.append("caption", caption.slice(0, 1024));
          if (parseMode) form.append("parse_mode", parseMode);
        }
        if (replyMarkup) {
          form.append("reply_markup", JSON.stringify(replyMarkup));
        }
        const response = await fetch(`${this.root}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(45000) });
        const body = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
        if (response.ok && body.ok) return body.result;
        const retryAfter = body.parameters?.retry_after;
        if (retryAfter && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
          continue;
        }
        throw new TelegramApiError(`Telegram sendPhoto failed: ${body.description || response.status}`, body.error_code ?? response.status, retryAfter);
      } catch (err) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Telegram sendPhoto failed: max retries reached");
  }
  public async sendDocumentFile(chatId: ChatId, filePath: string, caption?: string, replyMarkup?: ReplyMarkup, _signal?: AbortSignal, maxRetries = 3): Promise<unknown> {
    const target = parseChatTarget(chatId);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const fileBuffer = await fs.readFile(filePath);
        const form = new FormData();
        form.append("chat_id", String(target.chatId));
        if (target.messageThreadId !== undefined) {
          form.append("message_thread_id", String(target.messageThreadId));
        }
        form.append("document", new Blob([fileBuffer]), path.basename(filePath));
        if (caption) {
          form.append("caption", caption.slice(0, 1024));
          form.append("parse_mode", "HTML");
        }
        if (replyMarkup) {
          form.append("reply_markup", JSON.stringify(replyMarkup));
        }
        const response = await fetch(`${this.root}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
        const body = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
        if (response.ok && body.ok) return body.result;
        const retryAfter = body.parameters?.retry_after;
        if (retryAfter && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
          continue;
        }
        throw new TelegramApiError(`Telegram sendDocument failed: ${body.description || response.status}`, body.error_code ?? response.status, retryAfter);
      } catch (err) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Telegram sendDocument failed: max retries reached");
  }
  public getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    return this.call("getFile", { file_id: fileId });
  }
  public async downloadFile(filePath: string, destination: string, signal?: AbortSignal): Promise<string> {
    const fileUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    return executeWithRetry(
      async () => {
        const response = await fetch(fileUrl, { signal: signal || AbortSignal.timeout(60000) });
        if (!response.ok) throw new TelegramApiError(`Download file failed: ${response.statusText}`, response.status);
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer);
        return destination;
      },
      { maxRetries: 3, initialDelayMs: 500, signal }
    );
  }
}

