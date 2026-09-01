import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { childEnvironment } from "./infra/safe-env.js";
import type { AgyConfig, AgyResult, RunnerOptions, StreamEvent, Usage } from "./types.js";

const CONVERSATION_KEYS = new Set(["conversationId", "conversation_id", "conversationID", "sessionId", "session_id"]);

export function buildArgs(config: AgyConfig, prompt: string, conversationId: string | null, overrides: RunnerOptions = {}): string[] {
  const effective = { ...config, ...overrides };
  const outputFormat = effective.outputFormat || "stream-json";
  let finalPrompt = prompt;
  if (overrides.imagePath) {
    finalPrompt = prompt.trim()
      ? `${prompt}\n\n[Image attached: ${overrides.imagePath}]`
      : `Please analyze this image: ${overrides.imagePath}`;
  } else if (overrides.documentPath) {
    finalPrompt = prompt.trim()
      ? `${prompt}\n\n[Document attached: ${overrides.documentPath}]`
      : `Please read and analyze this document: ${overrides.documentPath}`;
  }
  const args = ["--print", finalPrompt, "--output-format", outputFormat, "--print-timeout", effective.printTimeout || `${Math.ceil(effective.timeoutMs / 1000)}s`];
  if (effective.project) args.push("--project", effective.project);
  if (effective.mode) args.push("--mode", effective.mode);
  if (effective.model) {
    args.push("--model", effective.model);
    const modelHasEffort = /-(low|medium|high)$/i.test(effective.model);
    const isClaude = /claude/i.test(effective.model);
    if (!modelHasEffort && !isClaude && effective.effort) {
      args.push("--effort", effective.effort);
    }
  } else if (effective.effort) {
    args.push("--effort", effective.effort);
  }
  if (effective.agent) args.push("--agent", effective.agent);
  const dirs = new Set(effective.addDirs || []);
  if (overrides.imagePath) dirs.add(path.dirname(overrides.imagePath));
  if (overrides.documentPath) dirs.add(path.dirname(overrides.documentPath));
  for (const addDir of dirs) args.push("--add-dir", addDir);
  if (effective.newProject) args.push("--new-project");
  if (effective.disableSlashCommands) args.push("--disable-slash-commands");
  if (effective.jsonSchema) args.push("--json-schema", effective.jsonSchema);
  if (effective.logFile) args.push("--log-file", effective.logFile);
  if (effective.dangerouslySkipPermissions || config.allowDangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (effective.sandbox) args.push("--sandbox");
  if (conversationId) {
    args.push("--conversation", conversationId);
  } else if (effective.continueSession) {
    args.push("--continue");
  }
  return args;
}

/** Tokenizes a Telegram `/agy ...` command without invoking a shell. */
export function parseCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let tokenStarted = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      tokenStarted = true;
    } else if (char === "\\") {
      escaped = true;
      tokenStarted = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
      tokenStarted = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += char;
      tokenStarted = true;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in /agy command");
  if (tokenStarted) args.push(current);
  return args;
}

export const TOP_LEVEL_COMMANDS = new Set(["agent", "agents", "changelog", "help", "install", "mcp", "mic-serve", "models", "plugin", "plugins", "update"]);

export function validateCustomArgs(args: string[]): string | null {
  if (args.length === 0) return "Usage: /agy <agy arguments>. Example: /agy --print \"Explain this project\" --output-format text";
  if (args.includes("--prompt-interactive") || args.includes("-i")) return "--prompt-interactive requires a local TTY and is not available through Telegram. Use /agy --print \"your prompt\" instead.";
  const first = args[0];
  if (first && TOP_LEVEL_COMMANDS.has(first)) return null;
  if (["--help", "-h", "--version", "-v"].includes(first || "")) return null;
  if (!args.includes("--print") && !args.includes("-p") && !args.includes("--prompt")) {
    if (first && !first.startsWith("-")) return null;
    return "Custom AGY commands must use --print, -p, or --prompt so they do not open an unmanaged interactive terminal.";
  }
  return null;
}

/** Runs a read-only AGY CLI command such as `models` or `changelog`. */
export function runAgyCommand(config: AgyConfig, commandArgs: string[], timeoutMs = 60_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("AGY command cancelled"));
    const child = spawn(config.bin, commandArgs, {
      cwd: config.workspace,
      env: childEnvironment(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopping = false;
    const stop = (): void => {
      if (stopping || !child.pid) return;
      stopping = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
      setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error(`AGY command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => { stop(); finish(() => reject(new Error("AGY command cancelled"))); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > config.maxOutputBytes) {
        finish(() => {
          stop();
          reject(new Error(`AGY command output exceeded ${config.maxOutputBytes} bytes`));
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => finish(() => {
      if (code !== 0) {
        const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 1000);
        reject(new Error(`AGY command exited with ${code ?? signal}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(stdout.trim() || stderr.trim() || "AGY returned no output.");
    }));
  });
}

export function extractConversationId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = extractConversationId(item); if (found) return found; }
    return null;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (CONVERSATION_KEYS.has(key) && typeof candidate === "string" && candidate) return candidate;
    const found = extractConversationId(candidate);
    if (found) return found;
  }
  return null;
}

export function normalizeUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;
  const usage: Usage = {};
  for (const key of ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"] as const) {
    const number = Number((value as Record<string, unknown>)[key]);
    if (Number.isFinite(number) && number >= 0) usage[key] = number;
  }
  return Object.keys(usage).length ? usage : null;
}

export function parseStreamOutput(stdout: string): AgyResult {
  const events: StreamEvent[] = [];
  let finalEvent: StreamEvent | null = null;
  let conversationId: string | null = null;
  let model: string | null = null;
  let response = "";
  let streamedResponse = "";
  let usage: Usage | null = null;
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  let toolCalls = 0;
  let executionError = "";

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: StreamEvent;
    try { event = JSON.parse(line) as StreamEvent; } catch { continue; }
    events.push(event);
    conversationId ||= extractConversationId(event);
    const init = asRecord(event.init);
    const step = asRecord(event.step_update);
    const result = asRecord(event.result);
    if (event.event === "init") model ||= stringValue(init?.model) || stringValue(event.model);
    if (event.event === "step_update") {
      model ||= stringValue(event.model) || stringValue(step?.model);
      if (step?.tool_info || step?.subagent_info || isToolStep(stringValue(step?.step_type))) toolCalls += 1;
      const stepUsage = normalizeUsage(step?.usage);
      if (stepUsage) usage = stepUsage;
      streamedResponse += stringValue(step?.text_delta) || stringValue(step?.text) || "";
      executionError ||= pickError(step);
    }
    if (event.event === "result") {
      finalEvent = event;
      model ||= stringValue(result?.model);
      response = pickText(result) || response;
      usage = normalizeUsage(result?.usage) || usage;
      durationMs = numberOrNull(result?.duration_seconds, (value) => value * 1000);
      numTurns = numberOrNull(result?.num_turns);
      if (Number.isSafeInteger(result?.tool_calls)) toolCalls = result?.tool_calls as number;
      executionError ||= pickError(result);
    }
    if (!response && event.event !== "step_update") response = pickText(event) || response;
  }
  return {
    text: response.trim() || streamedResponse.trim() || (executionError ? `AGY could not complete the request.\n\n${executionError}` : "AGY returned no output."), parsed: finalEvent, events,
    conversationId, model, usage, durationMs, numTurns, toolCalls, status: stringValue(asRecord(finalEvent?.result)?.status),
  };
}

export function formatStepUpdate(stepUpdate: Record<string, unknown> | undefined): string | null {
  if (!stepUpdate) return null;
  const tool = asRecord(stepUpdate.tool_info);
  if (tool) {
    const toolName = stringValue(tool.name) || stringValue(tool.tool_name) || stringValue(tool.tool) || stringValue(stepUpdate.step_type) || "tool";
    const args = asRecord(tool.parameters) || asRecord(tool.args) || asRecord(tool.input) || {};
    const summary = stringValue(tool.toolSummary) || stringValue(tool.toolAction) || "";

    if (toolName === "run_command" || toolName === "bash" || toolName === "terminal" || toolName === "execute_command") {
      const cmd = stringValue(args.CommandLine) || stringValue(args.command) || stringValue(args.cmd) || summary;
      const shortCmd = cmd ? (cmd.length > 55 ? `${cmd.slice(0, 52)}...` : cmd) : "";
      return shortCmd ? `⚙️ Command: ${shortCmd}` : "⚙️ Running command...";
    }
    if (toolName === "view_file" || toolName === "read_file" || toolName === "read_text_file" || toolName === "read_resource") {
      const file = stringValue(args.AbsolutePath) || stringValue(args.TargetFile) || stringValue(args.path) || stringValue(args.file) || summary;
      const baseFile = file ? path.basename(file) : "";
      return baseFile ? `📄 Reading file: ${baseFile}` : "📄 Reading file...";
    }
    if (toolName === "replace_file_content" || toolName === "write_to_file" || toolName === "edit_file" || toolName === "write_file") {
      const file = stringValue(args.TargetFile) || stringValue(args.path) || stringValue(args.file) || summary;
      const baseFile = file ? path.basename(file) : "";
      return baseFile ? `✏️ Editing file: ${baseFile}` : "✏️ Editing file...";
    }
    if (toolName === "search_web" || toolName === "web_search") {
      const query = stringValue(args.query) || stringValue(args.Query) || summary;
      const shortQuery = query ? (query.length > 45 ? `${query.slice(0, 42)}...` : query) : "";
      return shortQuery ? `🔍 Web search: "${shortQuery}"` : "🔍 Web search...";
    }
    if (toolName === "read_url_content" || toolName === "fetch" || toolName === "browse") {
      const url = stringValue(args.Url) || stringValue(args.url) || summary;
      const shortUrl = url ? (url.length > 45 ? `${url.slice(0, 42)}...` : url) : "";
      return shortUrl ? `🌐 Fetching: ${shortUrl}` : "🌐 Fetching URL...";
    }
    if (toolName === "list_dir" || toolName === "list_directory" || toolName === "find_by_name" || toolName === "grep_search") {
      const target = summary || stringValue(args.Pattern) || stringValue(args.Query) || stringValue(args.DirectoryPath) || "";
      const shortTarget = target ? (target.length > 45 ? `${target.slice(0, 42)}...` : target) : "";
      return shortTarget ? `📁 File search: ${shortTarget}` : "📁 Searching files...";
    }
    if (summary) {
      return `🔧 ${summary.length > 55 ? `${summary.slice(0, 52)}...` : summary}`;
    }
    return `🔧 Tool: ${toolName}`;
  }
  const subagent = asRecord(stepUpdate.subagent_info);
  if (subagent) {
    const role = stringValue(subagent.role) || stringValue(subagent.name) || "";
    return role ? `🤖 Subagent: ${role}` : "🤖 Delegating to subagent...";
  }
  if (stepUpdate.step_type === "agent_response") return "💬 Generating response...";
  if (stepUpdate.step_type === "checkpoint") return "💾 Saving checkpoint...";
  if (stepUpdate.step_type === "thinking" || typeof stepUpdate.thought === "string") return "🤔 Thinking...";
  if (typeof stepUpdate.step_type === "string" && !["user_input", "unknown"].includes(stepUpdate.step_type)) return `Step: ${stepUpdate.step_type}`;
  return null;
}

export function runAgy(config: AgyConfig, prompt: string, conversationId: string | null, options: RunnerOptions = {}): Promise<AgyResult> {
  return new Promise((resolve, reject) => {
    const { signal, onEvent, ...overrides } = options;
    const outputFormat = overrides.outputFormat || "stream-json";
    const child = spawn(config.bin, buildArgs(config, prompt, conversationId, { ...overrides, outputFormat }), {
      cwd: config.workspace, env: childEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let pendingLine = ""; let bytes = 0;
    let outputLimited = false; let timedOut = false; let settled = false; let callbackError: Error | null = null;
    const startedAt = Date.now();
    const finish = (callback: (value: never) => void, value: never): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(value);
    };
    const emit = (line: string): void => {
      if (!line.trim()) return;
      try { onEvent?.(JSON.parse(line) as StreamEvent); } catch (error) { if (error instanceof Error) callbackError ||= error; }
    };
    const processTree = (rootPid: number): number[] => {
      const children = new Map<number, number[]>();
      for (const entry of readdirSync("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        try {
          const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
          const closingParen = stat.lastIndexOf(")");
          if (closingParen < 0) continue;
          const fields = stat.slice(closingParen + 2).split(" ");
          const pid = Number(entry.name);
          const parentPid = Number(fields[1]);
          if (Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid)) {
            const list = children.get(parentPid) || [];
            list.push(pid);
            children.set(parentPid, list);
          }
        } catch { /* process exited while inspecting /proc */ }
      }
      const result: number[] = [];
      const visit = (pid: number): void => {
        for (const childPid of children.get(pid) || []) {
          result.push(childPid);
          visit(childPid);
        }
      };
      visit(rootPid);
      return result.reverse();
    };
    const stop = (immediate = false): void => {
      if (!child.pid) return;
      const descendants = processTree(child.pid);
      const sig = immediate ? "SIGKILL" : "SIGTERM";
      try { process.kill(-child.pid, sig); } catch { /* already exited */ }
      try { process.kill(child.pid, sig); } catch { /* already exited */ }
      for (const pid of descendants) {
        try { process.kill(pid, sig); } catch { /* already exited */ }
      }
      if (!immediate) {
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
          try { process.kill(child.pid!, "SIGKILL"); } catch { /* already exited */ }
          for (const pid of descendants) {
            try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
          }
        }, 300).unref();
      }
    };
    const abort = (): void => { stop(true); finish(reject as (value: never) => void, new Error("AGY job cancelled") as never); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, config.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > config.maxOutputBytes) { outputLimited = true; stop(); return; }
      const text = chunk.toString(); stdout += text;
      if (outputFormat !== "stream-json") return;
      pendingLine += text; const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop() || ""; lines.forEach(emit);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString(); });
    child.on("error", (error) => finish(reject as (value: never) => void, error as never));
    child.on("close", (code, signalName) => {
      if (outputFormat === "stream-json") emit(pendingLine);
      if (timedOut) return finish(reject as (value: never) => void, new Error(`AGY timed out after ${config.timeoutMs}ms`) as never);
      if (outputLimited) return finish(reject as (value: never) => void, new Error(`AGY output exceeded ${config.maxOutputBytes} bytes`) as never);
      if (code !== 0) {
        const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 1000);
        return finish(reject as (value: never) => void, new Error(`AGY exited with ${code ?? signalName}${detail ? `: ${detail}` : ""}`) as never);
      }
      if (callbackError) return finish(reject as (value: never) => void, callbackError as never);
      const result = outputFormat === "stream-json" ? parseStreamOutput(stdout) : parseJsonOutput(stdout);
      finish(resolve as (value: never) => void, { ...result, durationMs: result.durationMs ?? Date.now() - startedAt } as never);
    });
  });
}

function parseJsonOutput(stdout: string): AgyResult {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return { text: pickText(parsed) || JSON.stringify(parsed, null, 2), parsed, events: [], conversationId: extractConversationId(parsed), model: stringValue(parsed.model), usage: normalizeUsage(parsed.usage), durationMs: numberOrNull(parsed.duration_seconds, (value) => value * 1000), numTurns: numberOrNull(parsed.num_turns), toolCalls: Number.isSafeInteger(parsed.tool_calls) ? parsed.tool_calls as number : 0, status: stringValue(parsed.status) };
  } catch { return { text: stdout.trim() || "AGY returned no output.", parsed: null, events: [], conversationId: null, model: null, usage: null, durationMs: null, numTurns: null, toolCalls: 0, status: null }; }
}

function pickText(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  for (const key of ["response", "result", "output", "finalOutput", "final_output", "finalResponse", "final_response", "message", "text", "content", "answer"]) {
    if (typeof value[key] === "string" && (value[key] as string).trim()) return value[key] as string;
  }
  for (const key of ["result", "data", "answer"]) {
    const nested = asRecord(value[key]);
    const text = pickText(nested);
    if (text) return text;
  }
  return "";
}
function pickError(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  const error = value.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (asRecord(error)) return pickError(asRecord(error));
  for (const nestedKey of ["tool_info", "result", "data"]) {
    const nestedError = pickError(asRecord(value[nestedKey]));
    if (nestedError) return nestedError;
  }
  if (value.state === "ERROR" && typeof value.message === "string" && value.message.trim()) return value.message.trim();
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return "";
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function numberOrNull(value: unknown, transform: (value: number) => number = (item) => item): number | null { const number = Number(value); return Number.isFinite(number) ? transform(number) : null; }
function isToolStep(stepType: string | null): boolean { return !!stepType && /tool|command|browser|mcp/i.test(stepType); }
