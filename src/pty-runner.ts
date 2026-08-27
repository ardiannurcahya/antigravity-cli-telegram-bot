import { spawn } from "node:child_process";
import type { AgyConfig } from "./types.js";

export function cleanAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?:>=<!]*[ -/]*[@-~a-zA-Z]/g, "")
    .replace(/\x1b[()#%*+-.][0-9a-zA-Z]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r/g, "");
}

function stripProgressBar(str: string): string {
  return str.replace(/[█░▒▓━═─\-_[\]=><#]+/g, " ").replace(/\s+/g, " ").trim();
}

export function parseDurationToMinutes(text: string | null | undefined): number | null {
  if (!text) return null;
  const str = text.trim().toLowerCase();
  let totalMinutes = 0;
  let matched = false;

  const daysMatch = str.match(/(\d+(?:\.\d+)?)\s*d(?:ays?)?/);
  if (daysMatch) {
    totalMinutes += parseFloat(daysMatch[1]) * 24 * 60;
    matched = true;
  }

  const hoursMatch = str.match(/(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?/);
  if (hoursMatch) {
    totalMinutes += parseFloat(hoursMatch[1]) * 60;
    matched = true;
  }

  const minsMatch = str.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?/);
  if (minsMatch) {
    totalMinutes += parseFloat(minsMatch[1]);
    matched = true;
  }

  const secsMatch = str.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/);
  if (secsMatch) {
    totalMinutes += parseFloat(secsMatch[1]) / 60;
    matched = true;
  }

  return matched ? totalMinutes : null;
}

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

export function parseUsageQuota(rawOutput: string): string {
  const text = cleanAnsi(rawOutput).trim();

  // The TUI autocomplete list can contain 'Gemini', 'Claude', etc.
  // Find the last occurrence of Models & Quota to isolate the rendered command result panel.
  const quotaMatches = [...text.matchAll(/(?:└\s*)?Models\s*&\s*Quota/gi)];
  const quotaStart = quotaMatches.length ? quotaMatches[quotaMatches.length - 1].index ?? -1 : -1;
  const panel = quotaStart >= 0 ? text.slice(quotaStart) : text;

  // Validate that the output contains actual quota information, not just a startup screen
  const hasQuotaIndicator =
    /models?\s*&\s*quota|weekly\s*limit|gemini\s*models?|claude\s*(?:and|\/|&)\s*gpt|quota\s*available/i.test(panel);
  if (!hasQuotaIndicator) {
    throw new Error(
      `AGY did not produce a Models & Quota report.\n\nCaptured output:\n${panel.slice(0, 500) || "(empty)"}`
    );
  }

  // Extract account email
  const accountMatch = panel.match(/(?:Account|User|Email):\s*([^\n\r]+)/i);
  const account = accountMatch ? accountMatch[1].trim() : null;

  // Split into Gemini and Claude sections within the quota panel
  const geminiPartMatch = panel.match(
    /(?:GEMINI\s*MODELS?|Gemini\s+Models?)[\s\S]*?(?=(?:CLAUDE\s*(?:AND|&|\/)\s*GPT(?:\s*MODELS?)?|Claude\s+Models?)|$)/i
  );
  const geminiPart = geminiPartMatch ? geminiPartMatch[0] : "";

  const claudePartMatch = panel.match(
    /(?:CLAUDE\s*(?:AND|&|\/)\s*GPT(?:\s*MODELS?)?|Claude\s+Models?)[\s\S]*$/i
  );
  const claudePart = claudePartMatch ? claudePartMatch[0] : "";

  const extractLimits = (
    sectionText: string
  ): { weekly: string | null; weeklyRefresh: string | null; fiveHour: string | null; fiveHourRefresh: string | null } => {
    let weekly: string | null = null;
    let weeklyRefresh: string | null = null;
    let fiveHour: string | null = null;
    let fiveHourRefresh: string | null = null;

    if (!sectionText) return { weekly, weeklyRefresh, fiveHour, fiveHourRefresh };

    // Weekly limit
    const weeklyMatch = sectionText.match(
      /Weekly\s*Limit(?:\s*Remaining)?[\s\S]*?(?=(?:Five\s*Hour|5\s*Hour|CLAUDE|GEMINI|$))/i
    );
    if (weeklyMatch) {
      const cleanWeekly = stripProgressBar(weeklyMatch[0]);
      if (/disabled/i.test(cleanWeekly)) {
        weekly = "Disabled";
      } else {
        const valMatch = cleanWeekly.match(
          /(\d+(?:\.\d+)?%\s*(?:remaining|available|Quota available|left)?|Quota available)/i
        );
        if (valMatch) weekly = valMatch[1].trim();
      }
      const refreshMatch = cleanWeekly.match(/Refreshes\s*in\s*([0-9a-zA-Z\s]+)/i);
      if (refreshMatch) weeklyRefresh = refreshMatch[1].trim();
    }

    // Five hour limit
    const fiveHourMatch = sectionText.match(
      /(?:Five|5)\s*Hour\s*Limit(?:\s*Remaining)?[\s\S]*?(?=(?:Weekly|CLAUDE|GEMINI|$))/i
    );
    if (fiveHourMatch) {
      const cleanFive = stripProgressBar(fiveHourMatch[0]);
      if (/disabled/i.test(cleanFive)) {
        fiveHour = "Disabled";
      } else {
        const valMatch = cleanFive.match(
          /(\d+(?:\.\d+)?%\s*(?:remaining|available|Quota available|left)?|Quota available)/i
        );
        if (valMatch) fiveHour = valMatch[1].trim();
      }
      const refreshMatch = cleanFive.match(/Refreshes\s*in\s*([0-9a-zA-Z\s]+)/i);
      if (refreshMatch) fiveHourRefresh = refreshMatch[1].trim();
    }

    return { weekly, weeklyRefresh, fiveHour, fiveHourRefresh };
  };

  const gemini = extractLimits(geminiPart);
  const claude = extractLimits(claudePart);

  const lines = ["📊 <b>Models & Quota</b>\n"];
  if (account) lines.push(`<b>Account:</b> <code>${account}</code>\n`);

  const hasGeminiLimits = Boolean(gemini.weekly || gemini.fiveHour);
  const hasClaudeLimits = Boolean(claude.weekly || claude.fiveHour);

  const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60; // 10080 mins = 168h
  const FIVE_HOUR_WINDOW_MINUTES = 5 * 60; // 300 mins = 5h

  if (hasGeminiLimits) {
    lines.push("<b>Gemini Models</b>");
    const weeklyLine = formatQuotaLimitLine("Weekly", gemini.weekly, gemini.weeklyRefresh, WEEKLY_WINDOW_MINUTES);
    if (weeklyLine) lines.push(weeklyLine);
    const fiveHourLine = formatQuotaLimitLine("5-Hour", gemini.fiveHour, gemini.fiveHourRefresh, FIVE_HOUR_WINDOW_MINUTES);
    if (fiveHourLine) lines.push(fiveHourLine);
  }

  if (hasClaudeLimits) {
    if (hasGeminiLimits) lines.push("");
    lines.push("<b>Claude & GPT Models</b>");
    const weeklyLine = formatQuotaLimitLine("Weekly", claude.weekly, claude.weeklyRefresh, WEEKLY_WINDOW_MINUTES);
    if (weeklyLine) lines.push(weeklyLine);
    const fiveHourLine = formatQuotaLimitLine("5-Hour", claude.fiveHour, claude.fiveHourRefresh, FIVE_HOUR_WINDOW_MINUTES);
    if (fiveHourLine) lines.push(fiveHourLine);
  }

  if (!hasGeminiLimits && !hasClaudeLimits) {
    const general = extractLimits(panel);
    if (general.weekly || general.fiveHour) {
      lines.push("<b>Antigravity Quota</b>");
      const weeklyLine = formatQuotaLimitLine("Weekly", general.weekly, general.weeklyRefresh, WEEKLY_WINDOW_MINUTES);
      if (weeklyLine) lines.push(weeklyLine);
      const fiveHourLine = formatQuotaLimitLine("5-Hour", general.fiveHour, general.fiveHourRefresh, FIVE_HOUR_WINDOW_MINUTES);
      if (fiveHourLine) lines.push(fiveHourLine);
    }
  }

  return lines.join("\n").trim();
}

export function parseCredits(rawOutput: string): string {
  const text = cleanAnsi(rawOutput).trim();

  // Validate that credits or balance information was returned
  const hasCreditsIndicator = /credits?|balance|purchase|buy/i.test(text);
  if (!hasCreditsIndicator) {
    throw new Error(
      `AGY did not produce a Credits report.\n\nCaptured output:\n${text.slice(0, 500) || "(empty)"}`
    );
  }

  const creditsMatch =
    text.match(/(?:(?:G1\s+)?credits\s*remaining|(?:available\s+)?credits|balance)[:\s]*([0-9$][^\n\r]*)/i) ||
    text.match(/([0-9]+(?:\.[0-9]+)?\s*(?:credits|G1 credits))/i);

  const purchaseMatch =
    text.match(/(?:Purchase(?:\s+link)?|Buy)[:\s]*(https?:\/\/[^\s)]+)/i) ||
    text.match(/(https?:\/\/[^\s)]+)/i);

  const lines = ["💳 <b>AGY Credits</b>\n"];
  if (creditsMatch) {
    lines.push(`• Credits Remaining: <b>${creditsMatch[1].trim()}</b>`);
  }
  if (purchaseMatch) {
    const url = purchaseMatch[1].trim();
    lines.push(`• Purchase / Top-up: <a href="${url}">${url}</a>`);
  }

  if (!creditsMatch && !purchaseMatch) {
    const cleanLines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.includes("/credits") && !l.startsWith("❯") && !l.startsWith(">"));
    lines.push(cleanLines.join("\n"));
  }

  return lines.join("\n").trim();
}

export function parseContext(rawOutput: string): string {
  const text = cleanAnsi(rawOutput).trim();
  // The TUI autocomplete list can mention /context before the actual panel.
  // The final Context Usage occurrence is the rendered command result.
  const contextMatches = [...text.matchAll(/(?:└\s*)?Context Usage/gi)];
  const contextStart = contextMatches.length ? contextMatches[contextMatches.length - 1].index ?? -1 : -1;
  if (contextStart < 0) {
    throw new Error(`AGY did not produce an Active Context report.\n\nCaptured output:\n${text.slice(0, 500) || "(empty)"}`);
  }
  const panel = text.slice(contextStart).split(/\n\s*(?:Related:|esc to cancel)/i)[0];
  const lines = panel.split("\n").map((line) => line.replace(/^[□◉⛁⊠\s]+/, "").trim()).filter(Boolean);
  const modelLine = lines.find((line) => /tokens\s*$/i.test(line) || /tokens\s*\(/i.test(line));
  const usageLine = lines.find((line) => /^estimated usage/i.test(line));
  const categories = lines
    .filter((line) => /^(?:User messages|Agent responses|Tool calls|System prompt|System tools|Skills|Subagents):/i.test(line))
    .map((line) => line);
  const freeLine = lines.find((line) => /^free space:/i.test(line));
  const checkpointLine = lines.find((line) => /^checkpoints?/i.test(line));
  const checkpointDetail = lines.find((line) => /^└?\s*checkpoint \d+/i.test(line));
  const artifacts = lines.filter((line) => line.startsWith("└ ") && /\.\w+:\s*[\d.]+k? tokens$/i.test(line));
  const result = [
    "🧠 <b>Active Context</b>",
    modelLine,
    usageLine,
    categories.length ? `<b>Token breakdown</b>\n${categories.map((line) => `• ${line}`).join("\n")}` : null,
    freeLine,
    checkpointLine && checkpointDetail ? `${checkpointLine} · ${checkpointDetail}` : checkpointLine,
    artifacts.length ? `<b>Artifacts:</b> ${artifacts.length}` : null,
  ].filter((line): line is string => Boolean(line));
  return result.join("\n");
}

const PTY_SCRIPT = `
import pty, os, sys, time, select, signal, re, struct, fcntl, termios

def clean_ansi(text):
    text = re.sub(r'\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', '', text)
    text = re.sub(r'\\x1b\\[[0-9;?:>=<!]*[ -/]*[@-~a-zA-Z]', '', text)
    text = re.sub(r'\\x1b[()#%*+-.][0-9a-zA-Z]', '', text)
    text = re.sub(r'\\x1b[@-Z\\\\-_]', '', text)
    return re.sub(r'[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]', '', text).replace('\\r', '')

bin_path = sys.argv[1]
cwd = sys.argv[2]
cmd_to_send = sys.argv[3]
conversation_id = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
timeout_sec = float(sys.argv[5]) if len(sys.argv) > 5 else 25.0

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except Exception:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    if os.path.isdir(cwd):
        try:
            os.chdir(cwd)
        except Exception:
            pass
    env = dict(os.environ)
    env['TERM'] = 'xterm-256color'
    env['NO_COLOR'] = '0'
    if 'HOME' not in env or not env['HOME']:
        env['HOME'] = os.path.expanduser('~')
    for k in ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS', 'TELEGRAM_ALLOWED_CHAT_IDS']:
        env.pop(k, None)
    try:
        argv = [bin_path]
        if conversation_id:
            # Explicitly enter the interactive TUI when resuming a conversation.
            # Without this flag AGY can print the previous response and exit.
            argv += ['--conversation', conversation_id, '--prompt-interactive', '']
        os.execvpe(bin_path, argv, env)
    except Exception as e:
        sys.stderr.write(f"exec failed: {e}\\n")
    sys.exit(1)

os.close(slave)
output = b''
start = time.time()
sent_command = False
handled_trust = False
last_data_time = time.time()
prompt_first_seen = None
retried_enter = False

try:
    while time.time() - start < timeout_sec:
        r, _, _ = select.select([master], [], [], 0.05)
        if master in r:
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                output += data
                last_data_time = time.time()
            except OSError:
                break

        decoded = output.decode('utf-8', errors='ignore')
        cleaned = clean_ansi(decoded)
        lower_cleaned = cleaned.lower()

        # Check if login menu is explicitly asking for OAuth selection
        if not sent_command and ('select login method' in lower_cleaned and 'use arrow keys' in lower_cleaned):
            sys.stdout.write("Error: AGY CLI is not signed in. Please authenticate AGY on the server.\\n")
            sys.exit(0)

        # Handle trust / confirmation dialog. Newer AGY versions use an
        # arrow-key menu with the first option already selected.
        if not handled_trust and 'yes, i trust this folder' in lower_cleaned and 'no, exit' in lower_cleaned:
            time.sleep(0.3)
            try:
                os.write(master, b'\\r')
            except OSError:
                pass
            handled_trust = True
            prompt_first_seen = None
            last_data_time = time.time()
            time.sleep(0.4)
            continue

        # Handle legacy trust / confirmation dialog
        if not handled_trust and ('trust' in lower_cleaned or 'do you trust' in lower_cleaned) and ('[y/n]' in lower_cleaned or 'yes/no' in lower_cleaned or '?' in lower_cleaned):
            time.sleep(0.3)
            try:
                os.write(master, b'y\\r')
            except OSError:
                pass
            handled_trust = True
            time.sleep(0.4)
            continue

        # Check active prompt readiness. AGY places the prompt between TUI
        # rows, so it may be in the middle of the accumulated buffer.
        has_prompt_symbol = (
            bool(re.search(r'(?m)^[ \\t]*[❯>][ \\t]*(?:\\n|$)', cleaned))
            or ('? for shortcuts' in lower_cleaned)
            or ('for shortcuts' in lower_cleaned)
            or ('type a command' in lower_cleaned)
            or ('ask anything' in lower_cleaned)
            or ('accept-edits' in lower_cleaned and 'gemini' in lower_cleaned)
            or ('bypass permissions' in lower_cleaned)
            or ('plan mode' in lower_cleaned)
        )

        if not sent_command:
            if has_prompt_symbol:
                if prompt_first_seen is None:
                    prompt_first_seen = time.time()

                # Wait until at least 0.5s elapsed since prompt appeared AND output has settled for 0.3s
                if (time.time() - prompt_first_seen >= 0.5) and (time.time() - last_data_time >= 0.3):
                    # Type characters with tiny delay to allow TUI state update
                    for ch in cmd_to_send:
                        os.write(master, ch.encode('utf-8'))
                        time.sleep(0.03)
                    time.sleep(0.1)
                    # Submit with \\r (Carriage Return)
                    os.write(master, b'\\r')
                    sent_command = True
                    output = b'' # Clear startup buffer
                    last_data_time = time.time()
                    continue

        # After sending command
        if sent_command:
            has_quota_result = ('models & quota' in lower_cleaned) or ('weekly limit' in lower_cleaned) or ('credits remaining' in lower_cleaned) or ('g1 credits' in lower_cleaned) or ('balance:' in lower_cleaned)
            has_context_result = ('active context' in lower_cleaned) or ('context usage' in lower_cleaned) or ('context window' in lower_cleaned) or ('estimated tokens' in lower_cleaned)
            if has_quota_result or has_context_result:
                if time.time() - last_data_time >= 0.8:
                    break

            # If 1.8s passed without response after typing, retry sending Enter once
            if not retried_enter and time.time() - last_data_time >= 1.8 and not has_quota_result:
                try:
                    os.write(master, b'\\r')
                except OSError:
                    pass
                retried_enter = True
                last_data_time = time.time()

            if time.time() - last_data_time >= 3.0 and len(output) > 0:
                break
finally:
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGTERM)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    time.sleep(0.1)
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGKILL)
    except Exception:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    try:
        os.close(master)
    except Exception:
        pass
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass

decoded = output.decode('utf-8', errors='ignore')
sys.stdout.write(clean_ansi(decoded))
`;

export interface PtyRunnerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  conversationId?: string;
}

export function runPtyCommand(
  config: AgyConfig,
  command: "/usage" | "/credits" | "/context",
  options: PtyRunnerOptions = {}
): Promise<string> {
  const { timeoutMs = 25_000, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("PTY command cancelled"));
    }

    const timeoutSec = Math.max(2, Math.ceil(timeoutMs / 1000));
    const child = spawn("python3", ["-c", PTY_SCRIPT, config.bin, config.workspace, command, options.conversationId || "", String(timeoutSec)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killProcessGroup = (): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };

    const abort = (): void => {
      killProcessGroup();
      finish(() => reject(new Error("PTY command cancelled")));
    };

    const timer = setTimeout(() => {
      killProcessGroup();
      finish(() => reject(new Error(`PTY command ${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs + 2000);

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      killProcessGroup();
      finish(() => reject(error));
    });

    child.on("close", (code, sig) =>
      finish(() => {
        if (code !== 0 && !stdout.trim()) {
          const detail = stderr.trim().slice(0, 500);
          reject(new Error(`PTY ${command} exited with ${code ?? sig}${detail ? `: ${detail}` : ""}`));
          return;
        }
        resolve(stdout.trim() || stderr.trim() || "AGY returned no output.");
      })
    );
  });
}

function formatDurationFromMs(diffMs: number): string {
  if (diffMs <= 0) return "now";
  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / (24 * 60));
  const hours = Math.floor((totalMins % (24 * 60)) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

interface QuotaBucketJson {
  id: string;
  name: string;
  description?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
  disabled?: boolean;
}

interface QuotaGroupJson {
  name: string;
  description?: string;
  buckets: QuotaBucketJson[];
}

export async function getUsageQuotaDirect(config: AgyConfig, options: PtyRunnerOptions = {}): Promise<string> {
  const { timeoutMs = 15_000, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Command cancelled"));

    const child = spawn(config.bin, ["--print", "/quota", "--output-format", "json", "--dangerously-skip-permissions"], {
      cwd: config.workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Direct quota command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`Direct quota failed (exit code ${code}): ${stderr.trim()}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        const groups: QuotaGroupJson[] = parsed?.command?.data?.groups || [];
        if (!groups.length) {
          return reject(new Error("No quota groups in response JSON"));
        }

        const lines = ["📊 <b>Models & Quota</b>\n"];
        const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
        const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;

        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          if (i > 0) lines.push("");
          lines.push(`<b>${g.name}</b>`);

          for (const b of g.buckets) {
            const isWeekly = b.window === "weekly" || b.id.includes("weekly");
            const label = isWeekly ? "Weekly" : "5-Hour";
            const windowMins = isWeekly ? WEEKLY_WINDOW_MINUTES : FIVE_HOUR_WINDOW_MINUTES;

            if (b.disabled) {
              const refreshStr = b.reset_time ? formatDurationFromMs(new Date(b.reset_time).getTime() - Date.now()) : null;
              const formattedLine = formatQuotaLimitLine(label, "Disabled", refreshStr, windowMins);
              if (formattedLine) lines.push(formattedLine);
            } else {
              const frac = typeof b.remaining_fraction === "number" ? b.remaining_fraction : 1;
              const pctStr = `${Math.round(frac * 100)}%`;
              const refreshStr = b.reset_time ? formatDurationFromMs(new Date(b.reset_time).getTime() - Date.now()) : null;
              const formattedLine = formatQuotaLimitLine(label, pctStr, refreshStr, windowMins);
              if (formattedLine) lines.push(formattedLine);
            }
          }
        }

        resolve(lines.join("\n").trim());
      } catch (err) {
        reject(err);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function getCreditsDirect(config: AgyConfig, options: PtyRunnerOptions = {}): Promise<string> {
  const { timeoutMs = 15_000, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Command cancelled"));

    const child = spawn(config.bin, ["--print", "/credits", "--output-format", "json", "--dangerously-skip-permissions"], {
      cwd: config.workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Direct credits command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`Direct credits failed (exit code ${code}): ${stderr.trim()}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        const data = parsed?.command?.data || {};
        const remaining = data.remaining_credits ?? data.credits;
        const upgradeUri = data.upgrade_uri || data.upgrade_url;

        const lines = ["💳 <b>AGY Credits</b>\n"];
        if (remaining !== undefined) {
          lines.push(`• Credits Remaining: <b>${remaining}</b>`);
        }
        if (upgradeUri) {
          lines.push(`• Purchase / Top-up: <a href="${upgradeUri}">${upgradeUri}</a>`);
        }

        if (lines.length === 1) {
          return reject(new Error("No credits data in response JSON"));
        }

        resolve(lines.join("\n").trim());
      } catch (err) {
        reject(err);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function getUsageQuota(config: AgyConfig, options: PtyRunnerOptions = {}): Promise<string> {
  try {
    return await getUsageQuotaDirect(config, options);
  } catch {
    const raw = await runPtyCommand(config, "/usage", options);
    return parseUsageQuota(raw);
  }
}

export async function getCredits(config: AgyConfig, options: PtyRunnerOptions = {}): Promise<string> {
  try {
    return await getCreditsDirect(config, options);
  } catch {
    const raw = await runPtyCommand(config, "/credits", options);
    return parseCredits(raw);
  }
}
