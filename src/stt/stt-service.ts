import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../types.js";
import type { SttService, TranscriptionResult } from "../domain/stt.js";

export class AgySttService implements SttService {
  constructor(private readonly config: AppConfig) {}

  public isAvailable(): boolean {
    return Boolean(this.config.agy.bin);
  }

  public async transcribe(
    audioFilePath: string,
    options?: { language?: string; signal?: AbortSignal }
  ): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const model = this.config.stt.agyModel || "gemini-3.8-flash-low";
    const prompt = `Transkribiere die gesprochene Sprache aus der Audiodatei "${audioFilePath}". Gib AUSSCHLIESSLICH den transkribierten Wortlaut aus, ohne jede Einleitung, Bestätigung, Erklärung oder Anführungszeichen. Falls keine Sprache zu hören ist oder die Datei leer ist, antworte mit [EMPTY].`;

    const args = [
      "--print",
      prompt,
      "--model",
      model,
      "--effort",
      "low",
      "--disable-slash-commands",
    ];

    if (this.config.agy.allowDangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    const text = await runProcess(
      this.config.agy.bin,
      args,
      this.config.stt.timeoutMs,
      options?.signal
    );

    const cleanText = text.trim().replace(/^["']|["']$/g, "").trim();
    if (!cleanText || cleanText === "[EMPTY]" || /keine sprache|no speech/i.test(cleanText)) {
      return {
        text: "",
        durationSeconds: (Date.now() - startedAt) / 1000,
      };
    }

    return {
      text: cleanText,
      durationSeconds: (Date.now() - startedAt) / 1000,
    };
  }
}

export class WhisperLocalSttService implements SttService {
  constructor(private readonly config: AppConfig) {}

  public isAvailable(): boolean {
    return Boolean(this.config.stt.whisperBin);
  }

  public async transcribe(
    audioFilePath: string,
    options?: { language?: string; signal?: AbortSignal }
  ): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const model = this.config.stt.whisperModel || "base";
    const lang = options?.language || this.config.stt.language;
    const outputDir = path.dirname(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const txtFile = path.join(outputDir, `${baseName}.txt`);

    const args = [
      audioFilePath,
      "--model",
      model,
      "--output_format",
      "txt",
      "--output_dir",
      outputDir,
      "--fp16",
      "False",
    ];

    if (lang && lang !== "auto") {
      args.push("--language", lang);
    }

    try {
      await runProcess(
        this.config.stt.whisperBin,
        args,
        this.config.stt.timeoutMs,
        options?.signal
      );

      let text = "";
      try {
        text = await fs.readFile(txtFile, "utf-8");
        await fs.unlink(txtFile).catch(() => undefined);
      } catch {
        // file may not exist if whisper failed
      }

      return {
        text: text.trim(),
        durationSeconds: (Date.now() - startedAt) / 1000,
      };
    } catch (error) {
      await fs.unlink(txtFile).catch(() => undefined);
      throw error;
    }
  }
}

export function createSttService(config: AppConfig): SttService | null {
  if (config.stt.provider === "agy") {
    return new AgySttService(config);
  }
  if (config.stt.provider === "whisper-local") {
    return new WhisperLocalSttService(config);
  }
  return null;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(new Error(`STT execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(new Error("STT execution aborted by signal"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (timedOut) return;

      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `STT process failed with exit code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`
          )
        );
      }
    });
  });
}
