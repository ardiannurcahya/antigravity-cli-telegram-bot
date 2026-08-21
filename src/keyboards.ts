import type { ReplyKeyboardMarkup, SessionSettings } from "./types.js";

function verboseLabel(verbose: SessionSettings["verbose"]): string {
  if (verbose === "compact") return "comp";
  if (verbose === "silent") return "sil";
  return "det";
}

/** Persistent keyboard shown immediately above Telegram's input field. */
export function createMainKeyboard(_settings?: SessionSettings): ReplyKeyboardMarkup {
  return {
    keyboard: [
      ["✨ New session", "🤖 Model", "📊 Quota"],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Send a prompt to AGY...",
  };
}
