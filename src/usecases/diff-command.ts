import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AppContext } from "../context.js";
import { settingsFor } from "../domain/settings.js";
import { isWithin } from "../domain/workspace.js";
import { createMainKeyboard } from "../keyboards.js";
import { escapeHtml } from "../telegram.js";
import type { ChatId } from "../types.js";
import { reply, replyWithHtml } from "../ui/reply.js";

const execFileAsync = promisify(execFile);

/** Maximum character length to render directly in a Telegram chat message. */
export const DIRECT_DIFF_MAX_CHARS = 3000;

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runGitCommand(args: string[], cwd: string): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      stdout: (error?.stdout || "").trim(),
      stderr: (error?.stderr || error?.message || "").trim(),
      exitCode: typeof error?.code === "number" ? error.code : 1,
    };
  }
}

export async function handleDiffCommand(context: AppContext, chatId: ChatId): Promise<void> {
  const settings = settingsFor(context, chatId);
  const effectiveWorkspace = settings.workspace || context.config.agy.workspace;

  if (!fs.existsSync(effectiveWorkspace)) {
    await reply(
      context,
      chatId,
      `Directory not found: <code>${escapeHtml(effectiveWorkspace)}</code>`,
      createMainKeyboard(settings)
    );
    return;
  }

  const realProjectsRoot = fs.existsSync(context.config.agy.projectsRoot)
    ? fs.realpathSync(context.config.agy.projectsRoot)
    : path.resolve(context.config.agy.projectsRoot);
  const realDefault = fs.existsSync(context.config.agy.workspace)
    ? fs.realpathSync(context.config.agy.workspace)
    : path.resolve(context.config.agy.workspace);
  const realWorkspace = fs.realpathSync(effectiveWorkspace);

  if (!isWithin(realWorkspace, realProjectsRoot) && !isWithin(realWorkspace, realDefault)) {
    await reply(
      context,
      chatId,
      "Security boundary violation: workspace directory must reside within configured projects root.",
      createMainKeyboard(settings)
    );
    return;
  }

  const isGit = await runGitCommand(["rev-parse", "--is-inside-work-tree"], realWorkspace);
  if (isGit.exitCode !== 0) {
    await replyWithHtml(
      context,
      chatId,
      `⚠️ The active workspace is not an initialized Git repository:\n<code>${escapeHtml(realWorkspace)}</code>`,
      createMainKeyboard(settings)
    );
    return;
  }

  let diffRes = await runGitCommand(["diff", "HEAD"], realWorkspace);
  if (diffRes.exitCode !== 0 && diffRes.stderr.includes("HEAD")) {
    diffRes = await runGitCommand(["diff"], realWorkspace);
  }

  const diff = diffRes.stdout;
  if (!diff) {
    const statusRes = await runGitCommand(["status", "--porcelain"], realWorkspace);
    if (!statusRes.stdout) {
      await replyWithHtml(
        context,
        chatId,
        `ℹ️ No local changes in active workspace:\n<code>${escapeHtml(realWorkspace)}</code>`,
        createMainKeyboard(settings)
      );
      return;
    }
    await replyWithHtml(
      context,
      chatId,
      `ℹ️ No modified tracked files in active workspace (untracked files detected):\n<code>${escapeHtml(realWorkspace)}</code>\n\n<pre>${escapeHtml(statusRes.stdout)}</pre>`,
      createMainKeyboard(settings)
    );
    return;
  }

  if (diff.length < DIRECT_DIFF_MAX_CHARS) {
    await replyWithHtml(
      context,
      chatId,
      `📁 <b>Git diff:</b> <code>${escapeHtml(realWorkspace)}</code>\n\n<pre><code class="language-diff">${escapeHtml(diff)}</code></pre>`,
      createMainKeyboard(settings)
    );
    return;
  }

  let statRes = await runGitCommand(["diff", "--stat", "HEAD"], realWorkspace);
  if (statRes.exitCode !== 0) {
    statRes = await runGitCommand(["diff", "--stat"], realWorkspace);
  }
  const statOutput = statRes.stdout || "Large patch generated.";

  const tmpDir = context.config.tempDir;
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const patchFile = path.join(tmpDir, `patch-${Date.now()}.diff`);
  await fs.promises.writeFile(patchFile, diff, "utf8");

  try {
    await replyWithHtml(
      context,
      chatId,
      `📊 <b>Git diff summary:</b> <code>${escapeHtml(realWorkspace)}</code>\n\n<pre>${escapeHtml(statOutput)}</pre>\n\n📄 <i>Full patch attached below.</i>`
    );
    await context.telegram.sendDocumentFile(
      chatId,
      patchFile,
      "Full workspace diff patch",
      createMainKeyboard(settings)
    );
  } finally {
    await fs.promises.unlink(patchFile).catch(() => undefined);
  }
}
