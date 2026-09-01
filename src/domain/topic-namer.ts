/**
 * Generates ultra-short topic names (max ~16 characters) optimized for smartphone screens in Telegram forum topics.
 */
export function generateShortTopicName(prompt: string, responseText?: string): string {
  const cleanInput = (prompt || "").trim();
  if (!cleanInput) return "💬 Chat";

  const lower = cleanInput.toLowerCase();

  // 1. Direct Pattern / Category Matching
  if (/(\btest\b|testen|testing)/i.test(lower)) return "🧪 Test";
  if (/(avatar|profilbild|gruppenbild|gruppenfoto|gruppe.*(bild|foto)|(bild|foto).*gruppe)/i.test(lower)) return "🖼️ Avatar";
  if (/(bild|foto|image|grafik|photo|icon|zeichnung)/i.test(lower)) return "🖼️ Bild";
  if (/(logo|design|mockup|ui|ux|layout)/i.test(lower)) return "🎨 Design";
  if (/(tesla|supercharger|akkustand|ladestand|soc)/i.test(lower)) return "🚗 Tesla";
  if (/(wetter|weather|regen|sonne|vorhersage|forecast)/i.test(lower)) return "☀️ Wetter";
  if (/(docker|container|compose)/i.test(lower)) return "🐳 Docker";
  if (/(git|github|pr\b|pull request|commit|repo)/i.test(lower)) return "🐙 GitHub";
  if (/(bug|fix|fehler|error|crash|exception|kaputt)/i.test(lower)) return "🐛 Bugfix";
  if (/(deploy|release|publishing|ci\/cd|pipeline)/i.test(lower)) return "🚀 Deploy";
  if (/(server|linux|cachyos|arch|ubuntu|ssh|systemd)/i.test(lower)) return "🖥️ Server";
  if (/(kauf|kaufen|preis|shopping|shop|bestell)/i.test(lower)) return "🛒 Shopping";
  if (/(aktie|krypto|crypto|btc|eth|invest|finanz|portfolio|kurs)/i.test(lower)) return "📈 Finanzen";
  if (/(garmin|fitness|lauf|schlaf|sleep|puls|training|workout)/i.test(lower)) return "🏃 Fitness";
  if (/(smart\s*home|home\s*assistant|\bha\b|licht|lampe|heizung)/i.test(lower)) return "🏠 Smart Home";
  if (/(mail|email|e-mail|inbox|postfach|gmail|imap)/i.test(lower)) return "✉️ E-Mail";
  if (/(flug|flight|reise|hotel|urlaub|trip)/i.test(lower)) return "✈️ Reise";
  if (/(musik|music|song|audio|track)/i.test(lower)) return "🎵 Musik";
  if (/(video|clip|aufnahme)/i.test(lower)) return "🎬 Video";
  if (/(doku|dokument|pdf|docx|xlsx|excel|tabelle)/i.test(lower)) return "📄 Dokument";
  if (/(datei|file|ordner|folder)/i.test(lower)) return "📁 Dateien";
  if (/(recherche|search|suche|such)/i.test(lower)) return "🔍 Recherche";
  if (/(auto-naming|thema|themen|topic|name)/i.test(lower)) return "🏷️ Thema";
  if (/(code|script|funktion|typescript|python|bash|node)/i.test(lower)) return "💻 Code";

  // 2. Stop words filtering
  const stopWords = new Set([
    "kannst", "könntest", "könnte", "bitte", "mach", "mache", "zeige", "zeig", "sag", "sage",
    "schreib", "schreibe", "erstelle", "erstell", "implementier", "implementiere", "erklär", "erkläre",
    "wieso", "warum", "weshalb", "wohin", "wann", "was", "wie", "wer", "ist", "sind", "war", "waren",
    "haben", "hat", "hatte", "dieser", "dieses", "diesem", "diese", "dieses", "hier", "dort",
    "eines", "einer", "einen", "einem", "eine", "ein", "das", "der", "die", "den", "dem", "des",
    "mit", "von", "für", "auf", "in", "im", "an", "am", "zu", "zum", "zur", "nach", "über", "unter",
    "vor", "zwischen", "auch", "noch", "schon", "nur", "mal", "sehr", "etwas", "mehr", "weniger",
    "can", "could", "would", "please", "make", "show", "tell", "write", "create", "implement",
    "explain", "why", "how", "what", "where", "when", "who", "is", "are", "was", "were", "have",
    "has", "had", "this", "that", "these", "those", "here", "there", "a", "an", "the", "with",
    "from", "for", "on", "in", "at", "to", "after", "about", "under", "before", "between", "also",
    "still", "already", "just", "very", "some", "more", "less", "you", "me", "my", "your", "it"
  ]);

  const rawWords = cleanInput
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()));

  if (rawWords.length === 0) return "💬 Chat";

  // Capitalize first letter of each word
  const capitalized = rawWords.slice(0, 2).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  let result = `💬 ${capitalized.join(" ")}`;

  if (result.length > 16) {
    result = `💬 ${capitalized[0]}`;
    if (result.length > 16) {
      result = result.slice(0, 15) + "…";
    }
  }

  return result;
}
