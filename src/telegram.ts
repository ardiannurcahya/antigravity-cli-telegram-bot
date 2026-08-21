import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatId, InlineKeyboardMarkup, ReplyMarkup, TelegramUpdate } from "./types.js";

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

export class TelegramClient {
  private readonly root: string;
  public constructor(private readonly token: string) { this.root = API_ROOT(token); }
  public async call<T>(method: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    return executeWithRetry(async () => {
      const response = await fetch(`${this.root}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal });
      const body = await response.json() as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
      if (!response.ok || !body.ok) {
        throw new TelegramApiError(
          `Telegram ${method} failed: ${body.description || response.status}`,
          body.error_code || response.status,
          body.parameters?.retry_after
        );
      }
      return body.result as T;
    }, { signal });
  }
  public getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> { return this.call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, signal); }
  public sendMessage(chatId: ChatId, text: string, replyMarkup?: ReplyMarkup, parseMode?: TelegramParseMode): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }
  public async editMessageText(
    chatId: ChatId,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    parseMode?: TelegramParseMode
  ): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("message is not modified")) return;
      throw error;
    }
  }
  public async deleteMessage(chatId: ChatId, messageId: number): Promise<boolean> {
    try {
      return await this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      return false;
    }
  }
  public answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> { return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }); }
  public setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> { return this.call<boolean>("setMyCommands", { commands }); }
  public sendChatAction(chatId: ChatId, action = "typing"): Promise<boolean> { return this.call<boolean>("sendChatAction", { chat_id: chatId, action }); }
  public async sendDocument(chatId: ChatId, filename: string, content: string, signal?: AbortSignal): Promise<unknown> {
    return executeWithRetry(async () => {
      const form = new FormData(); form.append("chat_id", String(chatId)); form.append("document", new Blob([content], { type: "text/markdown" }), filename);
      const response = await fetch(`${this.root}/sendDocument`, { method: "POST", body: form, signal });
      const body = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
      if (!response.ok || !body.ok) {
        throw new TelegramApiError(
          `Telegram sendDocument failed: ${body.description || response.status}`,
          body.error_code || response.status,
          body.parameters?.retry_after
        );
      }
      return body.result;
    }, { signal });
  }
  public async sendPhoto(chatId: ChatId, photoPath: string | Buffer, caption?: string, parseMode?: TelegramParseMode, mimeType?: string, replyMarkup?: ReplyMarkup, signal?: AbortSignal): Promise<unknown> {
    return executeWithRetry(async () => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
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
      const response = await fetch(`${this.root}/sendPhoto`, { method: "POST", body: form, signal });
      const body = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
      if (!response.ok || !body.ok) {
        throw new TelegramApiError(
          `Telegram sendPhoto failed: ${body.description || response.status}`,
          body.error_code || response.status,
          body.parameters?.retry_after
        );
      }
      return body.result;
    }, { signal });
  }
  public async sendDocumentFile(chatId: ChatId, filePath: string, caption?: string, replyMarkup?: ReplyMarkup, signal?: AbortSignal): Promise<unknown> {
    return executeWithRetry(async () => {
      const fileBuffer = await fs.readFile(filePath);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("document", new Blob([new Uint8Array(fileBuffer)]), path.basename(filePath));
      if (caption) {
        form.append("caption", caption.slice(0, 1024));
        form.append("parse_mode", "HTML");
      }
      if (replyMarkup) {
        form.append("reply_markup", JSON.stringify(replyMarkup));
      }
      const response = await fetch(`${this.root}/sendDocument`, { method: "POST", body: form, signal });
      const body = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
      if (!response.ok || !body.ok) {
        throw new TelegramApiError(
          `Telegram sendDocument failed: ${body.description || response.status}`,
          body.error_code || response.status,
          body.parameters?.retry_after
        );
      }
      return body.result;
    }, { signal });
  }
  public getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    return this.call("getFile", { file_id: fileId });
  }
  public async downloadFile(filePath: string, destination: string, signal?: AbortSignal): Promise<string> {
    return executeWithRetry(async () => {
      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
      const response = await fetch(fileUrl, { signal });
      if (!response.ok) throw new TelegramApiError(`Download file failed: ${response.statusText}`, response.status);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, buffer);
      return destination;
    }, { signal });
  }
}

export function splitMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = []; let rest = text;
  while (rest.length > maxChars) { let cut = rest.lastIndexOf("\n", maxChars); if (cut < Math.floor(maxChars * 0.5)) cut = maxChars; chunks.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n+/, ""); }
  if (rest) chunks.push(rest); return chunks;
}

/** Splits pre-formatted HTML text without re-escaping HTML tags. */
export function splitPreformattedHtml(htmlText: string, maxChars: number): string[] {
  if (maxChars < 1) return [];
  const normalized = htmlText.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const blocks = normalized.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (!block.trim()) continue;
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (block.length <= maxChars) {
        current = block;
      } else {
        const lineParts = splitMessage(block, maxChars);
        chunks.push(...lineParts);
        current = "";
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Converts the Markdown-like output AGY commonly produces to safe Telegram HTML. */
export function formatTelegramHtml(text: string): string {
  return renderTelegramBlocks(text).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Formats a response into valid Telegram HTML messages under the size limit. */
export function formatTelegramHtmlChunks(text: string, maxChars: number): string[] {
  if (maxChars < 1) return [];
  const blocks = renderTelegramBlocks(text);
  const chunks: string[] = [];
  let current = "";
  const append = (piece: string): void => {
    if (!piece) {
      if (current && !current.endsWith("\n")) {
        current += "\n";
      }
      return;
    }
    const candidate = current ? `${current}\n${piece}` : piece;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }
    if (current) chunks.push(current.trimEnd());
    current = "";
    if (piece.length <= maxChars) current = piece;
    else chunks.push(...splitOversizedHtmlBlock(piece, maxChars));
  };
  for (const block of blocks) append(block);
  if (current) chunks.push(current.trimEnd());
  return chunks;
}

function renderTelegramBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const output: string[] = [];
  let codeLines: string[] | null = null;
  let codeLanguage = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (codeLines) {
        const language = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
        output.push(`<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = null;
        codeLanguage = "";
      } else {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        codeLines = [];
        codeLanguage = fence[1] || "";
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    // Blockquote & GitHub Alerts
    if (line.match(/^\s*>/)) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*>/)) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      i--; // loop will increment i

      let alertHeader = "";
      if (quoteLines.length > 0) {
        const alertMatch = quoteLines[0].match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
        if (alertMatch) {
          const type = alertMatch[1].toUpperCase();
          const rest = alertMatch[2];
          const iconMap: Record<string, string> = {
            NOTE: "ℹ️ <b>Note</b>",
            TIP: "💡 <b>Tip</b>",
            IMPORTANT: "📌 <b>Important</b>",
            WARNING: "⚠️ <b>Warning</b>",
            CAUTION: "🚨 <b>Caution</b>",
          };
          alertHeader = iconMap[type] || `📌 <b>${type}</b>`;
          quoteLines.shift();
          if (rest.trim()) {
            quoteLines.unshift(rest.trim());
          }
        }
      }

      const formattedQuote = quoteLines.map((q) => formatInlineHtml(q)).join("\n");
      const finalQuoteHtml = alertHeader
        ? `<blockquote>${alertHeader}\n${formattedQuote}</blockquote>`
        : `<blockquote>${formattedQuote}</blockquote>`;

      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push(finalQuoteHtml);
      if (i + 1 < lines.length && lines[i + 1].trim() !== "") {
        output.push("");
      }
      continue;
    }

    // Fallback: Deterministic Markdown Table Parser
    if (isPotentialTableRow(line) && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const tableLines: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isPotentialTableRow(lines[j]) && !lines[j].match(/^\s*```/)) {
        tableLines.push(lines[j]);
        j++;
      }
      const renderedTable = formatMarkdownTable(tableLines);
      if (renderedTable) {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        output.push(renderedTable);
        if (j < lines.length && lines[j].trim() !== "") {
          output.push("");
        }
        i = j - 1;
        continue;
      }
    }

    const divider = line.match(/^\s*[-*_]{3,}\s*$/);
    if (divider) {
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push("───────────────");
      if (i + 1 < lines.length && lines[i + 1].trim() !== "") {
        output.push("");
      }
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push(`<b>${formatInlineHtml(heading[1])}</b>`);
      continue;
    }

    const checkbox = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) {
      const indentLevel = Math.min(3, Math.floor(checkbox[1].length / 2));
      const indent = "  ".repeat(indentLevel);
      const icon = checkbox[2].trim() ? "✅" : "⬜";
      output.push(`${indent}${icon} ${formatInlineHtml(checkbox[3])}`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      const indentSpaces = bullet[1].length;
      if (indentSpaces >= 4) {
        output.push(`    – ${formatInlineHtml(bullet[2])}`);
      } else if (indentSpaces >= 2) {
        output.push(`  ▫️ ${formatInlineHtml(bullet[2])}`);
      } else {
        output.push(`• ${formatInlineHtml(bullet[2])}`);
      }
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      const indentSpaces = numbered[1].length;
      const indent = indentSpaces >= 2 ? "  " : "";
      output.push(`${indent}${numbered[1]}. ${formatInlineHtml(numbered[2])}`);
      continue;
    }
    output.push(formatInlineHtml(line));
  }
  if (codeLines) output.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  return output;
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(trimmed);
}

function isPotentialTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("```") || trimmed.startsWith("#")) return false;
  return trimmed.includes("|");
}

function parseMarkdownTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function cleanCellText(cell: string): string {
  return cell
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function formatMarkdownTable(tableLines: string[]): string | null {
  if (tableLines.length < 2) return null;

  let sepIndex = -1;
  for (let i = 0; i < tableLines.length; i++) {
    if (isTableSeparatorLine(tableLines[i])) {
      sepIndex = i;
      break;
    }
  }
  if (sepIndex < 1) return null;

  const rawRows = tableLines.filter((_, idx) => idx !== sepIndex).map(parseMarkdownTableCells);
  if (rawRows.length === 0) return null;

  const headerRow = rawRows[0];
  const colCount = Math.max(...rawRows.map((r) => r.length));
  if (colCount === 0) return null;

  const cardBlocks: string[] = [];

  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (row.every((c) => !c.trim())) continue;

    if (colCount === 2) {
      const key = formatInlineHtml(cleanCellText(row[0] || ""));
      const val = formatInlineHtml(row[1] || "");
      cardBlocks.push(`• <b>${key}:</b> ${val}`);
    } else {
      const primaryTitle = formatInlineHtml(cleanCellText(row[0] || (headerRow[0] ? `${headerRow[0]} ${r}` : `Item ${r}`)));
      const lines: string[] = [`🔹 <b>${primaryTitle}</b>`];
      for (let c = 1; c < colCount; c++) {
        const colHeader = formatInlineHtml(cleanCellText(headerRow[c] || `Field ${c + 1}`));
        const cellVal = formatInlineHtml(row[c] || "—");
        lines.push(`  ▫️ <i>${colHeader}:</i> ${cellVal}`);
      }
      cardBlocks.push(lines.join("\n"));
    }
  }

  return cardBlocks.join("\n\n");
}

function splitOversizedHtmlBlock(block: string, maxChars: number): string[] {
  const code = block.match(/^<pre><code( class="[^"]+")?>([\s\S]*)<\/code><\/pre>$/);
  if (code) {
    const open = `<pre><code${code[1] || ""}>`;
    const close = "</code></pre>";
    const contentLimit = Math.max(1, maxChars - open.length - close.length);
    return splitMessage(code[2], contentLimit).map((part) => `${open}${part}${close}`);
  }
  const quote = block.match(/^<blockquote>([\s\S]*)<\/blockquote>$/);
  if (quote) {
    const open = "<blockquote>";
    const close = "</blockquote>";
    const contentLimit = Math.max(1, maxChars - open.length - close.length);
    return splitMessage(quote[1], contentLimit).map((part) => `${open}${part}${close}`);
  }
  return splitMessage(stripHtmlTags(block), maxChars).map(escapeHtml);
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function formatInlineHtml(value: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };

  let escaped = escapeHtml(value);
  // Parse markdown image embeds FIRST to prevent local paths from leaking into chat or colliding with link parsing
  escaped = escaped.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const cleanLabel = label.replace(/^`+|`+$/g, "").trim();
    return token(cleanLabel ? `🖼 <a href="${url}">${cleanLabel}</a>` : `<a href="${url}">🖼 Image</a>`);
  });
  escaped = escaped.replace(/!\[([^\]]*)\]\((?:file:\/\/)?([^\s)]+)\)/g, (_match, label: string) => {
    const cleanLabel = label.replace(/^`+|`+$/g, "").trim();
    return token(cleanLabel ? `🖼 <i>${cleanLabel}</i>` : "");
  });

  // Parse markdown links FIRST before inline code tokens to prevent [`file`](file://...) nesting bugs
  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const cleanLabel = label.replace(/^`+|`+$/g, "");
    return token(`<a href="${url}">${cleanLabel}</a>`);
  });
  escaped = escaped.replace(/\[([^\]]+)\]\(file:\/\/\/[^\s)]+\)/g, (_match, label: string) => {
    const cleanLabel = label.replace(/^`+|`+$/g, "");
    return token(`<code>${cleanLabel}</code>`);
  });
  escaped = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${code}</code>`));
  escaped = escaped.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_match, boldA: string | undefined, boldB: string | undefined) => `<b>${boldA || boldB}</b>`);
  escaped = escaped.replace(/~~(.+?)~~/g, "<s>$1</s>");
  escaped = escaped.replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, (_match, italicA: string | undefined, italicB: string | undefined) => `<i>${italicA || italicB}</i>`);
  return escaped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] || "");
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [b0, b1] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (b0 === 127) return true;
    if (b0 === 10) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 0) return true;
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc00:") || host.startsWith("fd")) {
    return true;
  }
  return false;
}

export async function findReferencedMediaFiles(text: string, workspaceDir?: string): Promise<string[]> {
  const candidates = new Set<string>();

  // 1. Markdown image embeds: ![caption](/path/to/img.png) or ![caption](file:///path/to/img.png)
  const mdImgRegex = /!\[.*?\]\((?:file:\/\/)?([^\s)]+?\.(?:png|jpe?g|webp|gif|svg))\)/gi;
  for (const match of text.matchAll(mdImgRegex)) {
    const rawPath = match[1].trim();
    candidates.add(rawPath);
  }

  // 2. HTML img tags: <img src="/path/to/img.png">
  const htmlImgRegex = /<img[^>]+src=["'](?:file:\/\/)?([^"']+\.(?:png|jpe?g|webp|gif|svg))["']/gi;
  for (const match of text.matchAll(htmlImgRegex)) {
    const rawPath = match[1].trim();
    candidates.add(rawPath);
  }

  // 3. Temporary / preview images (e.g. /tmp/preview_*.jpg or /tmp/*.png)
  const mediaPathRegex = /(?:^|[\s"'`(\[])(\/(?:tmp|var\/tmp)[^\s"'`)\]]+\.(?:png|jpe?g|webp|gif|svg))/gi;
  for (const match of text.matchAll(mediaPathRegex)) {
    candidates.add(match[1].trim());
  }

  const validFiles: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) continue;
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : (workspaceDir ? path.resolve(workspaceDir, candidate) : path.resolve(candidate));
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile() && stat.size > 0 && stat.size < 50 * 1024 * 1024) {
        if (!validFiles.includes(resolved)) {
          validFiles.push(resolved);
        }
      }
    } catch {
      // file does not exist locally, skip
    }
  }

  // 4. Public Web Images: ![caption](https://example.com/image.png) or https://.../img.jpg
  const webImgRegex = /!?\[.*?\]\((https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif|svg))\)|(?:^|[\s"'`(\[])(https?:\/\/[^\s"'`)\]]+?\.(?:png|jpe?g|webp|gif|svg))/gi;
  for (const match of text.matchAll(webImgRegex)) {
    const webUrl = (match[1] || match[2] || "").trim();
    if (!webUrl) continue;
    try {
      const parsedUrl = new URL(webUrl);
      if (isPrivateOrReservedHost(parsedUrl.hostname)) continue;

      const ext = path.extname(parsedUrl.pathname).toLowerCase() || ".jpg";
      const hash = Buffer.from(webUrl).toString("base64url").slice(0, 24);
      const targetPath = path.join(os.tmpdir(), `web_media_${hash}${ext}`);
      const stat = await fs.stat(targetPath).catch(() => null);
      if (!stat || stat.size === 0) {
        const res = await fetch(webUrl, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length < 20 * 1024 * 1024) { // max 20MB
            await fs.writeFile(targetPath, buffer);
          }
        }
      }
      const finalStat = await fs.stat(targetPath).catch(() => null);
      if (finalStat && finalStat.size > 0 && !validFiles.includes(targetPath)) {
        validFiles.push(targetPath);
      }
    } catch {
      // ignore download failure
    }
  }

  return validFiles;
}
