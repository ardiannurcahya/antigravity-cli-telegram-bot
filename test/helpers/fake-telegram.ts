import { TelegramApiError } from "../../src/telegram.js";
import type { ChatId, InlineKeyboardMarkup, ReplyMarkup, TelegramUpdate } from "../../src/types.js";

type CallRecord = { method: string; payload: Record<string, unknown> };

/**
 * Test double mirroring the public surface of TelegramClient used by the bot.
 * Records every outgoing API call so tests can assert exact user-visible text.
 */
export class FakeTelegramClient {
  public calls: CallRecord[] = [];
  public failures = new Map<string, Error>();
  private nextMessageId = 1000;
  private files = new Map<string, { file_path: string }>();

  public assertNeverCalled(method: string): void {
    const found = this.calls.find((call) => call.method === method);
    if (found) throw new Error(`Unexpected ${method} call: ${JSON.stringify(found.payload)}`);
  }

  public sentTexts(): string[] {
    return this.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  }

  public editedTexts(): string[] {
    return this.calls.filter((c) => c.method === "editMessageText").map((c) => String(c.payload.text));
  }

  public lastPayload(method: string): Record<string, unknown> | undefined {
    const matching = this.calls.filter((c) => c.method === method);
    return matching[matching.length - 1]?.payload;
  }

  public failNext(method: string, error: Error): void {
    this.failures.set(method, error);
  }

  private recordAndMaybeFail(method: string, payload: Record<string, unknown>): void {
    this.calls.push({ method, payload });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async call<T>(method: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    this.recordAndMaybeFail("call", { method, ...payload });
    if (method === "getUpdates") return [] as T;
    return {} as T;
  }

  public async getUpdates(_offset: number, _signal?: AbortSignal): Promise<TelegramUpdate[]> {
    this.recordAndMaybeFail("getUpdates", {});
    return [];
  }

  public async sendMessage(chatId: ChatId, text: string, replyMarkup?: ReplyMarkup, parseMode?: "HTML"): Promise<{ message_id: number }> {
    this.recordAndMaybeFail("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup, parse_mode: parseMode });
    return { message_id: ++this.nextMessageId };
  }

  public async editMessageText(chatId: ChatId, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup, parseMode?: "HTML"): Promise<void> {
    this.recordAndMaybeFail("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup, parse_mode: parseMode });
  }

  public async deleteMessage(chatId: ChatId, messageId: number): Promise<boolean> {
    this.recordAndMaybeFail("deleteMessage", { chat_id: chatId, message_id: messageId });
    return true;
  }

  public async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    this.recordAndMaybeFail("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    return true;
  }

  public async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    this.recordAndMaybeFail("setMyCommands", { commands });
    return true;
  }

  public async sendChatAction(chatId: ChatId, action = "typing"): Promise<boolean> {
    this.recordAndMaybeFail("sendChatAction", { chat_id: chatId, action });
    return true;
  }

  public async sendDocument(chatId: ChatId, filename: string, content: string, signal?: AbortSignal): Promise<unknown> {
    this.recordAndMaybeFail("sendDocument", { chat_id: chatId, filename, bytes: content.length, signal: signal?.aborted ?? null });
    return {};
  }

  public async sendPhoto(chatId: ChatId, photoPath: string | Buffer, caption?: string, parseMode?: "HTML", mimeType?: string, replyMarkup?: ReplyMarkup, signal?: AbortSignal): Promise<unknown> {
    this.recordAndMaybeFail("sendPhoto", {
      chat_id: chatId,
      photo: typeof photoPath === "string" ? photoPath : `Buffer(${photoPath.length})`,
      caption,
      parse_mode: parseMode,
      mime_type: mimeType,
      reply_markup: replyMarkup,
    });
    return {};
  }

  public async sendDocumentFile(chatId: ChatId, filePath: string, caption?: string, replyMarkup?: ReplyMarkup, signal?: AbortSignal): Promise<unknown> {
    this.recordAndMaybeFail("sendDocumentFile", { chat_id: chatId, file_path: filePath, caption, reply_markup: replyMarkup });
    return {};
  }

  public async sendVoice(chatId: ChatId, voicePath: string | Buffer, caption?: string, replyMarkup?: ReplyMarkup, duration?: number, signal?: AbortSignal): Promise<unknown> {
    this.recordAndMaybeFail("sendVoice", {
      chat_id: chatId,
      voice: typeof voicePath === "string" ? voicePath : `Buffer(${voicePath.length})`,
      caption,
      reply_markup: replyMarkup,
      duration,
    });
    return {};
  }

  public getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    this.recordAndMaybeFail("getFile", { file_id: fileId });
    return Promise.resolve(this.files.get(fileId) || { file_id: fileId });
  }

  public registerFile(fileId: string, filePath: string): void {
    this.files.set(fileId, { file_id: fileId, file_path: filePath });
  }

  public async downloadFile(filePath: string, destination: string, signal?: AbortSignal): Promise<string> {
    this.recordAndMaybeFail("downloadFile", { file_path: filePath, destination, signal: signal?.aborted ?? null });
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from("fake-download"), { mode: 0o600 });
    return destination;
  }
}

export { TelegramApiError };
