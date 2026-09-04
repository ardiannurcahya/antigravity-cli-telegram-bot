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

    // Preformatted HTML Blockquote
    if (line.match(/^\s*<blockquote(?:\s+expandable)?>/i)) {
      const htmlBlockLines: string[] = [];
      while (i < lines.length) {
        htmlBlockLines.push(lines[i]);
        if (/<\/blockquote>/i.test(lines[i])) break;
        i++;
      }
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push(htmlBlockLines.join("\n"));
      if (i + 1 < lines.length && lines[i + 1].trim() !== "") {
        output.push("");
      }
      continue;
    }

    // Blockquote & GitHub Alerts
    if (line.match(/^\s*(?:\*\*>|>)/)) {
      const isExpandable = /^\s*\*\*>/.test(line);
      const quoteLines: string[] = [];
      while (i < lines.length && (isExpandable ? /^\s*(?:\*\*>|>)/.test(lines[i]) : /^\s*>/.test(lines[i]))) {
        let qLine = lines[i].replace(isExpandable ? /^\s*(?:\*\*>|>)\s?/ : /^\s*>\s?/, "");
        if (isExpandable && qLine.endsWith("**") && (qLine.match(/\*\*/g) || []).length % 2 === 1) {
          qLine = qLine.slice(0, -2);
        }
        quoteLines.push(qLine);
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
      const openTag = isExpandable ? "<blockquote expandable>" : "<blockquote>";
      const finalQuoteHtml = alertHeader
        ? `${openTag}${alertHeader}\n${formattedQuote}</blockquote>`
        : `${openTag}${formattedQuote}</blockquote>`;

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
  return sanitizeLatexExpressions(
    cell
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim()
  );
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
  const quote = block.match(/^<blockquote(\s+expandable)?>([\s\S]*)<\/blockquote>$/);
  if (quote) {
    const attr = quote[1] || "";
    const open = `<blockquote${attr}>`;
    const close = "</blockquote>";
    const contentLimit = Math.max(1, maxChars - open.length - close.length);
    return splitMessage(quote[2], contentLimit).map((part) => `${open}${part}${close}`);
  }
  return splitMessage(stripHtmlTags(block), maxChars).map(escapeHtml);
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

const GREEK_MAP: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ",
  delta: "δ", Delta: "Δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ", Theta: "Θ",
  iota: "ι", kappa: "κ", lambda: "λ", Lambda: "Λ",
  mu: "µ", nu: "ν", xi: "ξ", Xi: "Ξ",
  pi: "π", Pi: "Π", rho: "ρ", sigma: "σ", Sigma: "Σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", Phi: "Φ",
  chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω",
};

const SYMBOL_MAP: Record<string, string> = {
  rightarrow: "→", to: "→", longrightarrow: "⟶",
  leftarrow: "←", gets: "←", longleftarrow: "⟵",
  Rightarrow: "⇒", Leftarrow: "⇐",
  leftrightarrow: "↔", Leftrightarrow: "⇔", iff: "⇔",
  uparrow: "↑", downarrow: "↓", mapsto: "↦",
  approx: "≈", sim: "∼", simeq: "≃", cong: "≅",
  neq: "≠", ne: "≠",
  le: "≤", leq: "≤", ge: "≥", geq: "≥",
  ll: "≪", gg: "≫",
  pm: "±", mp: "∓",
  times: "×", cdot: "·", div: "÷",
  circ: "°", degree: "°",
  infty: "∞",
  in: "∈", notin: "∉", ni: "∋",
  subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  cup: "∪", cap: "∩",
  forall: "∀", exists: "∃", nexists: "∄",
  nabla: "∇", partial: "∂",
  sum: "∑", prod: "∏", int: "∫",
  ldots: "…", cdots: "…", dots: "…",
};

const SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  n: "ⁿ", i: "ⁱ",
};

const SUBSCRIPT_MAP: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ",
  l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ",
  s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

function toSuperscript(str: string): string {
  return str.split("").map((ch) => SUPERSCRIPT_MAP[ch] || ch).join("");
}

function toSubscript(str: string): string {
  return str.split("").map((ch) => SUBSCRIPT_MAP[ch] || ch).join("");
}

function extractBracedArg(text: string, startIndex: number): { content: string; endIndex: number } | null {
  if (text[startIndex] !== "{") return null;
  let depth = 0;
  const start = startIndex + 1;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return { content: text.slice(start, i), endIndex: i };
      }
    }
  }
  return null;
}

function replaceFractions(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("\\frac", i)) {
      const firstBraceIdx = i + 5;
      const num = extractBracedArg(text, firstBraceIdx);
      if (num) {
        const secondBraceIdx = num.endIndex + 1;
        const den = extractBracedArg(text, secondBraceIdx);
        if (den) {
          result += `(${cleanLatexMath(num.content)})/(${cleanLatexMath(den.content)})`;
          i = den.endIndex + 1;
          continue;
        }
      }
    }
    result += text[i];
    i++;
  }
  return result;
}

export function cleanLatexMath(expr: string): string {
  let res = expr;
  res = replaceFractions(res);

  while (res.includes("\\sqrt")) {
    const idx = res.indexOf("\\sqrt");
    const braced = extractBracedArg(res, idx + 5);
    if (braced) {
      const inner = cleanLatexMath(braced.content);
      res = res.slice(0, idx) + `√(${inner})` + res.slice(braced.endIndex + 1);
    } else {
      break;
    }
  }

  while (/\\(?:text|mathrm|mathbf|textbf|mathit|textit|operatorname)\{/.test(res)) {
    const match = res.match(/\\(?:text|mathrm|mathbf|textbf|mathit|textit|operatorname)\{/);
    if (!match || match.index === undefined) break;
    const startIdx = match.index + match[0].length - 1;
    const braced = extractBracedArg(res, startIdx);
    if (braced) {
      res = res.slice(0, match.index) + braced.content + res.slice(braced.endIndex + 1);
    } else {
      break;
    }
  }

  res = res.replace(/\{,\}/g, ",");
  res = res.replace(/\\([%$_{}#])/g, "$1");
  res = res.replace(/\\&amp;/g, "&amp;");
  res = res.replace(/\\&/g, "&amp;");
  res = res.replace(/\\[,;: ]/g, " ");
  res = res.replace(/\\!/g, "");
  res = res.replace(/\\q?quad/g, "  ");

  res = res.replace(/\^\{([^{}]+)\}/g, (_, exp: string) => toSuperscript(exp));
  res = res.replace(/\_\{([^{}]+)\}/g, (_, sub: string) => toSubscript(sub));
  res = res.replace(/\^([0-9+-ni])/g, (_, exp: string) => toSuperscript(exp));
  res = res.replace(/\_([0-9+-aeh-pr-tv-x])/g, (_, sub: string) => toSubscript(sub));

  res = res.replace(/\\([a-zA-Z]+)/g, (_match, name: string) => {
    if (SYMBOL_MAP[name]) return SYMBOL_MAP[name];
    if (GREEK_MAP[name]) return GREEK_MAP[name];
    return name;
  });

  res = res.replace(/\{([^{}]+)\}/g, "$1");

  return res.trim().replace(/\s{2,}/g, " ");
}

export function sanitizeLatexExpressions(text: string): string {
  let result = text;

  // Block math: $$ ... $$ or \[ ... \]
  result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => cleanLatexMath(inner));
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => cleanLatexMath(inner));

  // Inline math: \( ... \)
  result = result.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => cleanLatexMath(inner));

  // Inline math: $ ... $
  result = result.replace(/\$([^\$\n]+?)\$/g, (match, inner: string) => {
    const trimmed = inner.trim();
    if (!trimmed) return match;
    if (
      /\\[a-zA-Z,;:! %$_{}#&]/.test(trimmed) ||
      /[\^_{}]/.test(trimmed) ||
      /[=<>≤≥≈≠±×·÷]/.test(trimmed) ||
      /^[a-zA-Z]$/.test(trimmed) ||
      /^[0-9.,\s+\-*\/()]+[+\-*\/][0-9.,\s+\-*\/()]+$/.test(trimmed)
    ) {
      return cleanLatexMath(inner);
    }
    return match;
  });

  // Also clean loose LaTeX symbols outside delimiters (e.g. \rightarrow, \approx, \text{...})
  result = cleanLatexMath(result);

  return result;
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
  escaped = escaped.replace(/\[([^\]]+)\]\((?:file|conversation):\/\/[^\s)]+\)/g, (_match, label: string) => {
    const cleanLabel = label.replace(/^`+|`+$/g, "");
    return token(`<code>${cleanLabel}</code>`);
  });
  escaped = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${code}</code>`));

  // Sanitize LaTeX math and TeX macros in regular text outside code blocks & links
  escaped = sanitizeLatexExpressions(escaped);

  escaped = escaped.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_match, boldA: string | undefined, boldB: string | undefined) => `<b>${boldA || boldB}</b>`);
  escaped = escaped.replace(/~~(.+?)~~/g, "<s>$1</s>");
  escaped = escaped.replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, (_match, italicA: string | undefined, italicB: string | undefined) => `<i>${italicA || italicB}</i>`);

  let prev: string | undefined;
  let iterations = 0;
  while (escaped !== prev && /\u0000\d+\u0000/.test(escaped) && iterations < 10) {
    prev = escaped;
    escaped = escaped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] || "");
    iterations += 1;
  }
  return escaped;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

