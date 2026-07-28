export interface QueueStats {
  running: number;
  queued: number;
  sessions: number;
}
export type SessionActivity = "running" | "queued" | "idle";
export interface SessionQueueOptions {
  maxConcurrentTurns?: number;
  maxPendingPerSession?: number;
  onStatsChange?: (stats: QueueStats) => Promise<void> | void;
}
interface QueueItem {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}
export class SessionQueue {
  private readonly maxConcurrentTurns: number;
  private readonly maxPendingPerSession: number;
  private readonly onStatsChange?: (stats: QueueStats) => Promise<void> | void;
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly runningSessions = new Set<string>();
  private running = 0;
  constructor(options: SessionQueueOptions = {}) {
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? 4;
    this.maxPendingPerSession = options.maxPendingPerSession ?? 20;
    this.onStatsChange = options.onStatsChange;
  }
  async enqueue(
    sessionIdentity: string,
    run: () => Promise<void>,
    displayIdentity = `Session ${sessionIdentity}`,
  ): Promise<void> {
    const queue = this.queues.get(sessionIdentity) ?? [];
    if (queue.length >= this.maxPendingPerSession) throw new Error(`too many pending turns for ${displayIdentity}`);
    this.queues.set(sessionIdentity, queue);
    await new Promise<void>((resolve, reject) => {
      queue.push({ run, resolve, reject });
      this.pump();
    });
  }
  stats(): QueueStats {
    let queued = 0;
    for (const queue of this.queues.values()) queued += queue.length;
    return { running: this.running, queued, sessions: this.queues.size };
  }
  activity(sessionIdentity: string): SessionActivity {
    if (this.runningSessions.has(sessionIdentity)) return "running";
    if ((this.queues.get(sessionIdentity)?.length ?? 0) > 0) return "queued";
    return "idle";
  }
  private pump(): void {
    if (this.running >= this.maxConcurrentTurns) return;
    for (const [sessionIdentity, queue] of this.queues) {
      if (this.running >= this.maxConcurrentTurns) return;
      if (this.runningSessions.has(sessionIdentity)) continue;
      const item = queue.shift();
      if (!item) {
        this.queues.delete(sessionIdentity);
        continue;
      }
      this.running += 1;
      this.runningSessions.add(sessionIdentity);
      void this.runItem(sessionIdentity, item);
    }
  }

  private async runItem(sessionIdentity: string, item: QueueItem): Promise<void> {
    let failure: Error | null = null;
    try {
      await this.notifyStats();
      await item.run();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.running -= 1;
      this.runningSessions.delete(sessionIdentity);
      if ((this.queues.get(sessionIdentity)?.length ?? 0) === 0) this.queues.delete(sessionIdentity);
      await this.notifyStats().catch(() => undefined);
      this.pump();
    }
    if (failure) item.reject(failure);
    else item.resolve();
  }

  private async notifyStats(): Promise<void> {
    await this.onStatsChange?.(this.stats());
  }
}
