import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AppConfig, SessionSettings } from "../types.js";
import type { TtsService, SynthesisResult } from "../domain/tts.js";

export function cleanTextForSpeech(text: string): string {
  let cleaned = text;

  // Replace code blocks ```lang ... ``` with a spoken indicator
  cleaned = cleaned.replace(/```(?:[a-zA-Z0-9_-]+)?\s*[\r\n]+([\s\S]*?)```/g, (_match, code) => {
    const lineCount = code.trim().split("\n").length;
    return `[Code block with ${lineCount} lines]`;
  });

  // Remove inline code backticks `code` -> code
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

  // Remove markdown headers #, ##, etc.
  cleaned = cleaned.replace(/^#+\s+/gm, "");

  // Remove markdown bold/italic asterisks and underscores
  cleaned = cleaned.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1");

  // Clean markdown links [label](url) -> label
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove raw URLs
  cleaned = cleaned.replace(/https?:\/\/\S+/g, "");

  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "");

  // Replace multiple newlines or spaces with single space
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

export class EdgeTtsService implements TtsService {
  constructor(
    private readonly binPath: string = "/home/ubuntu/.local/bin/edge-tts",
    private readonly defaultVoice: string = "en-US-AndrewMultilingualNeural",
    private readonly tempDir: string = os.tmpdir(),
    private readonly timeoutMs: number = 25000
  ) {}

  public isAvailable(): boolean {
    return Boolean(this.binPath);
  }

  public async synthesize(
    text: string,
    options?: { voice?: string; signal?: AbortSignal }
  ): Promise<SynthesisResult> {
    const speechText = cleanTextForSpeech(text);
    if (!speechText) {
      throw new Error("No pronounceable text available for TTS.");
    }

    // Limit text length to avoid overly long audio (e.g. max 3500 chars)
    const truncatedText = speechText.length > 3500 ? `${speechText.slice(0, 3500)}...` : speechText;

    const voice = options?.voice || this.defaultVoice;
    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mp3Path = path.join(this.tempDir, `tts_${runId}.mp3`);
    const oggPath = path.join(this.tempDir, `tts_${runId}.ogg`);

    try {
      // 1. Synthesize MP3 using edge-tts
      await runProcess(
        this.binPath,
        ["--voice", voice, "--text", truncatedText, "--write-media", mp3Path],
        this.timeoutMs,
        options?.signal
      );

      // 2. Convert to Opus in OGG container (Telegram voice note format)
      await runProcess(
        "ffmpeg",
        ["-y", "-i", mp3Path, "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", oggPath],
        this.timeoutMs,
        options?.signal
      );

      return {
        audioPath: oggPath,
        format: "ogg",
      };
    } catch (err) {
      await fs.unlink(oggPath).catch(() => undefined);
      throw err;
    } finally {
      await fs.unlink(mp3Path).catch(() => undefined);
    }
  }
}

export function createTtsService(config: AppConfig, settings?: SessionSettings): TtsService | null {
  const mode = settings?.ttsMode || config.tts?.mode || "off";
  if (mode === "off") return null;

  const voice = settings?.ttsVoice || config.tts?.voice || "en-US-AndrewMultilingualNeural";
  const bin = config.tts?.bin || "/home/ubuntu/.local/bin/edge-tts";
  const timeoutMs = config.tts?.timeoutMs || 25000;
  return new EdgeTtsService(bin, voice, config.tempDir, timeoutMs);
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

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(new Error(`Process ${command} aborted by signal`));
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

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `Process ${command} failed with code ${code}: ${stderr || stdout}`
          )
        );
      }
    });
  });
}
