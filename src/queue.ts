import type { ChatId } from "./types.js";

export interface QueueJob {
  chatId: ChatId;
  prompt?: string;
  kind?: "prompt" | "usage" | "credits" | "context";
  id?: string;
  enqueuedAt?: number;
  imagePath?: string;
  documentPath?: string;
  documentName?: string;
  mediaPath?: string;
  mediaType?: string;
  wasVoiceInput?: boolean;
}
export interface QueueStatus { active: (QueueJob & { cancel: () => boolean }) | null; queued: number; totalQueued: number }
type Worker = (job: QueueJob, isCancelled: () => boolean) => Promise<void>;

export interface JobQueueOptions {
  /** Invoked on every cancelForChat so owners can abort associated work. */
  onCancel?: (chatId: ChatId) => void;
  maxConcurrent?: number;
}

export class JobQueue {
  private readonly pending: QueueJob[] = [];
  private readonly activeJobs: Map<string, QueueJob & { cancel: () => boolean }> = new Map();
  private sequence = 0;
  private isDraining = false;
  private readonly maxConcurrent: number;

  public constructor(
    private readonly maxSize: number,
    private readonly worker: Worker,
    private readonly options: JobQueueOptions = {}
  ) {
    this.maxConcurrent = options.maxConcurrent ?? 1;
  }

  public enqueue(job: QueueJob): { accepted: boolean; reason?: string; jobId?: string; position?: number } {
    if (this.pending.length >= this.maxSize) return { accepted: false, reason: "queue_full" };
    const queued = { ...job, id: `job-${++this.sequence}`, enqueuedAt: Date.now() };
    this.pending.push(queued);
    void this.drain().catch((err) => console.error("[queue] Drain unhandled error:", err));
    return { accepted: true, jobId: queued.id, position: this.pending.length };
  }

  public cancelForChat(chatId: ChatId): { removed: number; activeCancelled: boolean } {
    const key = String(chatId);
    const before = this.pending.length;
    this.pending.splice(0, this.pending.length, ...this.pending.filter((job) => String(job.chatId) !== key));
    const active = this.activeJobs.get(key);
    const activeCancelled = active ? active.cancel() : false;
    this.options.onCancel?.(chatId);
    return { removed: before - this.pending.length, activeCancelled };
  }

  public pendingForChat(chatId: ChatId): QueueJob[] {
    const key = String(chatId);
    return this.pending.filter((job) => String(job.chatId) === key);
  }

  public statusForChat(chatId: ChatId): QueueStatus {
    const key = String(chatId);
    return {
      active: this.activeJobs.get(key) || null,
      queued: this.pending.filter((job) => String(job.chatId) === key).length,
      totalQueued: this.pending.length,
    };
  }

  private async drain(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;
    try {
      while (this.activeJobs.size < this.maxConcurrent && this.pending.length > 0) {
        const jobIndex = this.pending.findIndex((job) => !this.activeJobs.has(String(job.chatId)));
        if (jobIndex === -1) break;

        const job = this.pending.splice(jobIndex, 1)[0];
        const chatKey = String(job.chatId);
        let cancelled = false;
        const activeItem = { ...job, cancel: () => { cancelled = true; return true; } };
        this.activeJobs.set(chatKey, activeItem);

        void (async () => {
          try {
            await this.worker(job, () => cancelled);
          } catch (workerError) {
            console.error(`[queue] Worker execution error for chat ${job.chatId}:`, workerError);
          } finally {
            this.activeJobs.delete(chatKey);
            void this.drain().catch((err) => console.error("[queue] Drain error after worker finish:", err));
          }
        })();
      }
    } finally {
      this.isDraining = false;
    }
  }
}
