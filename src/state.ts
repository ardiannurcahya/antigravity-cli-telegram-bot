import fs from "node:fs/promises";
import path from "node:path";
import type { ChatId, InFlightJob, PersistedState, SessionState } from "./types.js";

export class StateStore {
  private data: PersistedState = { updateOffset: 0, sessions: {} };
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly file: string) {}

  public async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object") return;
      const value = parsed as Partial<PersistedState>;
      this.data = {
        updateOffset: Number.isSafeInteger(value.updateOffset) ? value.updateOffset as number : 0,
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions as Record<string, SessionState> : {},
        inFlight: value.inFlight && typeof value.inFlight === "object" ? value.inFlight : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  public session(chatId: ChatId): SessionState | null { return this.data.sessions[String(chatId)] || null; }
  public async resetSession(chatId: ChatId, preserveSettings = true, preserveWorkspace = true): Promise<void> {
    const existing = this.data.sessions[String(chatId)];
      const { continueSession, newProject, model, effort, ...restSettings } = existing.settings;
      if (!preserveWorkspace) {
        restSettings.workspace = null;
      }
      const hasCustomSettings = Object.values(restSettings).some((val) => val !== undefined && val !== null);
      if (hasCustomSettings) {
        this.data.sessions[String(chatId)] = {
          settings: {
            ...restSettings,
            continueSession: false,
            newProject: false,
          },
        };
        await this.save();
        return;
      }
    }
    delete this.data.sessions[String(chatId)];
    await this.save();
  }
  public async setSession(chatId: ChatId, session: SessionState): Promise<void> {
    this.data.sessions[String(chatId)] = { ...this.data.sessions[String(chatId)], ...session };
    await this.save();
  }
  public async setOffset(offset: number): Promise<void> { this.data.updateOffset = offset; await this.save(); }
  public get offset(): number { return this.data.updateOffset; }

  public get inFlight(): Record<string, InFlightJob> { return this.data.inFlight || {}; }
  public async setInFlight(chatId: ChatId, job: InFlightJob): Promise<void> {
    if (!this.data.inFlight) this.data.inFlight = {};
    this.data.inFlight[String(chatId)] = job;
    await this.save();
  }
  public async clearInFlight(chatId: ChatId): Promise<void> {
    if (this.data.inFlight && this.data.inFlight[String(chatId)]) {
      delete this.data.inFlight[String(chatId)];
      await this.save();
    }
  }
  public async clearAllInFlight(): Promise<void> {
    this.data.inFlight = {};
    await this.save();
  }

  private async save(): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o600);
    });
    return this.writeChain;
  }
}
