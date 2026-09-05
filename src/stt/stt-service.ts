import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, SessionSettings } from "../types.js";
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
    const prompt = `Transcribe the spoken language from the audio file "${audioFilePath}". Output ONLY the exact transcribed text, without any introduction, confirmation, explanation, formatting, or quotation marks. If no speech is audible or the file is empty, reply with [EMPTY].`;

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

export class GeminiSttService implements SttService {
  constructor(private readonly config: AppConfig) {}

  public isAvailable(): boolean {
    return Boolean(this.config.stt.geminiApiKey);
  }

  public async transcribe(
    audioFilePath: string,
    options?: { language?: string; signal?: AbortSignal }
  ): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const apiKey = this.config.stt.geminiApiKey;
    if (!apiKey) {
      throw new Error("Gemini API key is not configured. Set GEMINI_API_KEY in ~/.config/agy-telegram/.env.");
    }

    const model = this.config.stt.geminiModel || "gemini-2.5-flash";
    const audioBuffer = await fs.readFile(audioFilePath);
    const base64Audio = audioBuffer.toString("base64");

    const ext = path.extname(audioFilePath).toLowerCase();
    let mimeType = "audio/ogg";
    if (ext === ".mp3") mimeType = "audio/mp3";
    else if (ext === ".wav") mimeType = "audio/wav";
    else if (ext === ".m4a") mimeType = "audio/m4a";
    else if (ext === ".aac") mimeType = "audio/aac";
    else if (ext === ".flac") mimeType = "audio/flac";

    const prompt = "Transcribe the spoken language from this audio. Output ONLY the exact transcribed text, without any introduction, confirmation, explanation, formatting, or quotation marks. If no speech is audible or the audio is empty, reply with [EMPTY].";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.stt.timeoutMs);
    const onAbort = (): void => controller.abort();
    if (options?.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Audio,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Gemini STT API error (${response.status}): ${errorText.slice(0, 300)}`);
      }

      const data = (await response.json()) as any;
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const cleanText = rawText.trim().replace(/^["']|["']$/g, "").trim();

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
    } finally {
      clearTimeout(timeout);
      if (options?.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

export function createSttService(config: AppConfig, settings?: SessionSettings): SttService | null {
  const provider = settings?.sttProvider || config.stt.provider;
  const effectiveConfig: AppConfig = {
    ...config,
    stt: {
      ...config.stt,
      provider,
      whisperModel: settings?.sttWhisperModel || config.stt.whisperModel,
      agyModel: settings?.sttAgyModel || config.stt.agyModel,
      language: settings?.sttLang || config.stt.language,
    },
  };

  if (provider === "agy") {
    return new AgySttService(effectiveConfig);
  }
  if (provider === "whisper-local") {
    return new WhisperLocalSttService(effectiveConfig);
  }
  if (provider === "gemini") {
    return new GeminiSttService(effectiveConfig);
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
