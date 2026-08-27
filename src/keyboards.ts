import type { ReplyKeyboardMarkup, SessionSettings } from "./types.js";

/** Persistent keyboard shown immediately above Telegram's input field. */
export function createMainKeyboard(_settings?: SessionSettings): ReplyKeyboardMarkup {
  return {
    keyboard: [
      ["✨ New", "🛑 Stop", "🤖 Model", "📊 Quota"],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Send a prompt to AGY...",
  };
}
