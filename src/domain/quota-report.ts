/**
 * `/usage` (Models & Quota) report: pure extraction and rendering.
 *
 * `extractQuota` turns raw PTY output into a typed {@link QuotaReport};
 * `renderQuota` turns that model into the Telegram HTML block. Keeping the two
 * separate lets us regression-test parsing against captured fixtures without
 * asserting on presentation, and vice versa.
 */
import { cleanAnsi, parseDurationToMinutes, stripProgressBar } from "./report-text.js";

/** A single quota limit (weekly or five-hour) within a model section. */
export interface QuotaLimit {
  /** Normalized value string, e.g. "94%", "Quota available", or "Disabled". */
  value: string | null;
  /** Refresh countdown text, e.g. "151h 15m". */
  refresh: string | null;
}

/** The weekly and five-hour limits for one provider section. */
export interface QuotaSection {
  weekly: QuotaLimit;
  fiveHour: QuotaLimit;
}

/** A parsed Models & Quota report. */
export interface QuotaReport {
  account: string | null;
  gemini: QuotaSection;
  claude: QuotaSection;
  argon: QuotaSection;
  /** Fallback section used when neither Gemini, Claude, nor Argon sections are present. */
  general: QuotaSection;
}

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60; // 10080 mins = 168h
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60; // 300 mins = 5h

const EMPTY_SECTION = (): QuotaSection => ({
  weekly: { value: null, refresh: null },
  fiveHour: { value: null, refresh: null },
});

export function sectionHasLimits(section: QuotaSection): boolean {
  return Boolean(section.weekly.value || section.fiveHour.value);
}

/**
 * Render one limit line with a traffic-light indicator and pace tag.
 * Exported (and historically re-exported from pty-runner) for direct testing.
 */
export function formatQuotaLimitLine(
  label: string,
  val: string | null,
  refresh: string | null,
  windowMinutes: number
): string | null {
  if (!val) return null;

  const isValDisabled = /disabled/i.test(val);
  const pctMatch = val.match(/(\d+(?:\.\d+)?)\s*%/);
  const actualPct = pctMatch ? parseFloat(pctMatch[1]) : (isValDisabled ? 0 : null);
  const displayVal = pctMatch ? `${pctMatch[1]}%` : val;
  const remainingMinutes = parseDurationToMinutes(refresh);

  let indicator = "🟢";
  let bufferTag = "";

  if (isValDisabled) {
    indicator = "⚪";
    const refreshPart = refresh ? ` (in ${refresh})` : "";
    return `• ${label}: ${indicator} <i>Disabled</i>${refreshPart}`;
  }

  if (actualPct !== null) {
    if (remainingMinutes !== null && windowMinutes > 0) {
      const timeRemainingRatio = Math.min(1, Math.max(0, remainingMinutes / windowMinutes));
      const expectedPct = timeRemainingRatio * 100;
      const delta = actualPct - expectedPct;

      if (actualPct < 10 || delta < -12) {
        indicator = "🔴";
      } else if (delta < -3) {
        indicator = "🟡";
      } else if (delta >= 10) {
        indicator = "⭐";
      } else {
        indicator = "🟢";
      }

      const roundedDelta = Math.round(delta);
      if (indicator === "🟢" && delta >= -2 && delta <= 0.5) {
        bufferTag = " <i>[On track]</i>";
      } else if (roundedDelta > 0) {
        bufferTag = ` <i>[+${roundedDelta}%]</i>`;
      } else {
        bufferTag = ` <i>[${roundedDelta}%]</i>`;
      }
    } else {
      if (actualPct < 10) {
        indicator = "🔴";
      } else if (actualPct < 30) {
        indicator = "🟡";
      } else {
        indicator = "🟢";
      }
    }
  }

  const refreshPart = refresh ? ` (in ${refresh})` : "";
  return `• ${label}: ${indicator} <b>${displayVal}</b>${refreshPart}${bufferTag}`;
}

/** Extract weekly/five-hour limits from one provider section's text. */
export function extractQuotaLimits(sectionText: string): QuotaSection {
  const section = EMPTY_SECTION();
  if (!sectionText) return section;

  // Weekly limit. "Limit" is optional so a future "Weekly: 50%" layout still parses.
  const weeklyMatch = sectionText.match(
    /Weekly(?:\s*(?:Limit|Usage))?(?:\s*Remaining)?[\s\S]*?(?=(?:Five\s*Hour|5\s*Hour|CLAUDE|GEMINI|$))/i
  );
  if (weeklyMatch) {
    const cleanWeekly = stripProgressBar(weeklyMatch[0]);
    if (/disabled/i.test(cleanWeekly)) {
      section.weekly.value = "Disabled";
    } else {
      const valMatch = cleanWeekly.match(
        /(\d+(?:\.\d+)?%\s*(?:remaining|available|Quota available|left)?|Quota available)/i
      );
      if (valMatch) section.weekly.value = valMatch[1].trim();
    }
    const refreshMatch = weeklyMatch[0].match(/Refreshes\s*in\s*([0-9a-zA-Z ]+)/i);
    if (refreshMatch) section.weekly.refresh = refreshMatch[1].trim();
  }

  // Five hour limit. "Limit" is optional for the same forward-compatibility reason.
  const fiveHourMatch = sectionText.match(
    /(?:Five|5)\s*Hour(?:\s*(?:Limit|Usage))?(?:\s*Remaining)?[\s\S]*?(?=(?:Weekly|CLAUDE|GEMINI|$))/i
  );
  if (fiveHourMatch) {
    const cleanFive = stripProgressBar(fiveHourMatch[0]);
    if (/disabled/i.test(cleanFive)) {
      section.fiveHour.value = "Disabled";
    } else {
      const valMatch = cleanFive.match(
        /(\d+(?:\.\d+)?%\s*(?:remaining|available|Quota available|left)?|Quota available)/i
      );
      if (valMatch) section.fiveHour.value = valMatch[1].trim();
    }
    const refreshMatch = fiveHourMatch[0].match(/Refreshes\s*in\s*([0-9a-zA-Z ]+)/i);
    if (refreshMatch) section.fiveHour.refresh = refreshMatch[1].trim();
  }

  return section;
}

/**
 * Isolate the rendered Models & Quota panel and extract it into a report.
 * Throws when the captured output contains no quota information at all.
 */
export function extractQuota(rawOutput: string, cleaned?: string): QuotaReport {
  const text = (cleaned ?? cleanAnsi(rawOutput)).trim();

  // The TUI autocomplete list can contain 'Gemini', 'Claude', etc.
  // Find the last occurrence of Models & Quota to isolate the result panel.
  const quotaMatches = [...text.matchAll(/(?:└\s*)?Models\s*&\s*Quota/gi)];
  const quotaStart = quotaMatches.length ? quotaMatches[quotaMatches.length - 1].index ?? -1 : -1;
  const panel = quotaStart >= 0 ? text.slice(quotaStart) : text;

  const hasQuotaIndicator =
    /models?\s*&\s*quota|weekly\s*limit|gemini\s*models?|gemini\s*4\s*argon|claude\s*(?:and|\/|&)\s*gpt|quota\s*available/i.test(panel);
  if (!hasQuotaIndicator) {
    throw new Error(
      `AGY did not produce a Models & Quota report.\n\nCaptured output:\n${panel.slice(0, 500) || "(empty)"}`
    );
  }

  const accountMatch = panel.match(/(?:Account|User|Email|Signed\s+in\s+as|Logged\s+in\s+as)[:\s]+([^\n\r]+)/i);
  let account = accountMatch ? accountMatch[1].trim() : null;
  // Fallback: a bare email in the panel (layouts that print the address alone).
  if (!account) {
    const emailMatch = panel.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (emailMatch) account = emailMatch[0];
  }
  // Keep only the address when the label captured trailing words.
  if (account) {
    const embeddedEmail = account.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (embeddedEmail) account = embeddedEmail[0];
  }

  const geminiPartMatch = panel.match(
    /(?:GEMINI\s*MODELS?|Gemini\s+Models?)[\s\S]*?(?=(?:CLAUDE\s*(?:AND|&|\/)\s*GPT(?:\s*MODELS?)?|Claude\s+Models?|GEMINI\s*4\s*ARGON|Gemini\s+4\s+Argon(?!\s+Weekly|\s+Five|\s+5)|│\s*Within\s+each\s+group|↑\/↓\s*Scroll)|$)/i
  );
  const geminiPart = geminiPartMatch ? geminiPartMatch[0] : "";

  const claudePartMatch = panel.match(
    /(?:CLAUDE\s*(?:AND|&|\/)\s*GPT(?:\s*MODELS?)?|Claude\s+Models?)[\s\S]*?(?=(?:GEMINI\s*4\s*ARGON|Gemini\s+4\s+Argon(?!\s+Weekly|\s+Five|\s+5)|GEMINI\s*MODELS?|Gemini\s+Models?|│\s*Within\s+each\s+group|↑\/↓\s*Scroll)|$)/i
  );
  const claudePart = claudePartMatch ? claudePartMatch[0] : "";

  const argonPartMatch = panel.match(
    /(?:GEMINI\s*4\s*ARGON|Gemini\s+4\s+Argon(?!\s+Weekly|\s+Five|\s+5))[\s\S]*?(?=(?:CLAUDE\s*(?:AND|&|\/)\s*GPT(?:\s*MODELS?)?|Claude\s+Models?|GEMINI\s*MODELS?|Gemini\s+Models?|│\s*Within\s+each\s+group|↑\/↓\s*Scroll)|$)/i
  );
  const argonPart = argonPartMatch ? argonPartMatch[0] : "";

  const gemini = extractQuotaLimits(geminiPart);
  const claude = extractQuotaLimits(claudePart);
  const argon = extractQuotaLimits(argonPart);
  // General is only meaningful (and only rendered) when no provider section matched.
  const general = sectionHasLimits(gemini) || sectionHasLimits(claude) || sectionHasLimits(argon)
    ? EMPTY_SECTION()
    : extractQuotaLimits(panel);

  return { account, gemini, claude, argon, general };
}

/** Render a {@link QuotaReport} into the Telegram HTML block. */
export function renderQuota(report: QuotaReport): string {
  const lines = ["📊 <b>Models & Quota</b>\n"];
  if (report.account) lines.push(`<b>Account:</b> <code>${report.account}</code>\n`);

  const hasGeminiLimits = sectionHasLimits(report.gemini);
  const hasClaudeLimits = sectionHasLimits(report.claude);
  const hasArgonLimits = sectionHasLimits(report.argon);

  if (hasGeminiLimits) {
    lines.push("<b>Gemini Models</b>");
    const weeklyLine = formatQuotaLimitLine("Weekly", report.gemini.weekly.value, report.gemini.weekly.refresh, WEEKLY_WINDOW_MINUTES);
    if (weeklyLine) lines.push(weeklyLine);
    const fiveHourLine = formatQuotaLimitLine("5-Hour", report.gemini.fiveHour.value, report.gemini.fiveHour.refresh, FIVE_HOUR_WINDOW_MINUTES);
    if (fiveHourLine) lines.push(fiveHourLine);
  }

  if (hasClaudeLimits) {
    if (hasGeminiLimits) lines.push("");
    lines.push("<b>Claude & GPT Models</b>");
    const weeklyLine = formatQuotaLimitLine("Weekly", report.claude.weekly.value, report.claude.weekly.refresh, WEEKLY_WINDOW_MINUTES);
    if (weeklyLine) lines.push(weeklyLine);
    const fiveHourLine = formatQuotaLimitLine("5-Hour", report.claude.fiveHour.value, report.claude.fiveHour.refresh, FIVE_HOUR_WINDOW_MINUTES);
    if (fiveHourLine) lines.push(fiveHourLine);
  }

  if (hasArgonLimits) {
    if (hasGeminiLimits || hasClaudeLimits) lines.push("");
    lines.push("<b>Gemini 4 Argon</b>");
    const weeklyLine = formatQuotaLimitLine("Weekly", report.argon.weekly.value, report.argon.weekly.refresh, WEEKLY_WINDOW_MINUTES);
    if (weeklyLine) lines.push(weeklyLine);
    const fiveHourLine = formatQuotaLimitLine("5-Hour", report.argon.fiveHour.value, report.argon.fiveHour.refresh, FIVE_HOUR_WINDOW_MINUTES);
    if (fiveHourLine) lines.push(fiveHourLine);
  }

  if (!hasGeminiLimits && !hasClaudeLimits && !hasArgonLimits) {
    if (sectionHasLimits(report.general)) {
      lines.push("<b>Antigravity Quota</b>");
      const weeklyLine = formatQuotaLimitLine("Weekly", report.general.weekly.value, report.general.weekly.refresh, WEEKLY_WINDOW_MINUTES);
      if (weeklyLine) lines.push(weeklyLine);
      const fiveHourLine = formatQuotaLimitLine("5-Hour", report.general.fiveHour.value, report.general.fiveHour.refresh, FIVE_HOUR_WINDOW_MINUTES);
      if (fiveHourLine) lines.push(fiveHourLine);
    }
  }

  return lines.join("\n").trim();
}

/** Back-compat one-shot: raw PTY output to rendered HTML. */
export function parseUsageQuota(rawOutput: string, cleaned?: string): string {
  return renderQuota(extractQuota(rawOutput, cleaned));
}
