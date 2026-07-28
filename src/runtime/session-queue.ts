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
  settle(failure: Error | null): void;
}
export class SessionQueue {
  private readonly maxConcurrentTurns: number;
  private readonly maxPendingPerSession: number;
  private readonly onStatsChange?: (stats: QueueStats) => Promise<void> | void;
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly runningSessions = new Set<string>();
  private readonly lifecycleClaims = new Set<string>();
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
    this.assertAccepting(sessionIdentity, displayIdentity);
    const queue = this.queues.get(sessionIdentity) ?? [];
    if (queue.length >= this.maxPendingPerSession) throw new Error(`too many pending turns for ${displayIdentity}`);
    this.queues.set(sessionIdentity, queue);
    await new Promise<void>((resolve, reject) => {
      queue.push({
        run,
        settle: (failure) => {
          if (failure) reject(failure);
          else resolve();
        },
      });
      this.pump();
    });
  }

  assertAccepting(sessionIdentity: string, displayIdentity = `Session ${sessionIdentity}`): void {
    if (this.lifecycleClaims.has(sessionIdentity)) {
      throw new Error(`${displayIdentity} lifecycle operation is in progress`);
    }
  }

  async claim<T>(
    sessionIdentity: string,
    run: () => Promise<T>,
    displayIdentity = `Session ${sessionIdentity}`,
    onClaim?: () => Promise<void>,
  ): Promise<T> {
    const release = await this.acquire(sessionIdentity, displayIdentity, onClaim);
    try {
      return await run();
    } finally {
      await release();
    }
  }

  async acquire(
    sessionIdentity: string,
    displayIdentity = `Session ${sessionIdentity}`,
    onClaim?: () => Promise<void>,
    onAcquired?: () => Promise<void>,
  ): Promise<() => Promise<void>> {
    if (this.lifecycleClaims.has(sessionIdentity)) {
      throw new Error(`${displayIdentity} lifecycle operation is in progress`);
    }
    this.lifecycleClaims.add(sessionIdentity);
    const queue = this.queues.get(sessionIdentity) ?? [];
    this.queues.set(sessionIdentity, queue);
    for (const pending of queue.splice(0)) {
      pending.settle(new Error(`${displayIdentity} lifecycle operation started`));
    }
    try {
      await onClaim?.();
    } catch (error) {
      this.lifecycleClaims.delete(sessionIdentity);
      throw error;
    }
    let releaseOperation: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let settleOperation: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settleOperation = resolve;
    });
    return await new Promise<() => Promise<void>>((resolve, reject) => {
      queue.push({
        run: async () => {
          await onAcquired?.();
          resolve(async () => {
            releaseOperation();
            await settled;
          });
          await released;
        },
        settle: (failure) => {
          try {
            if (failure) reject(failure);
          } finally {
            this.lifecycleClaims.delete(sessionIdentity);
            settleOperation();
          }
        },
      });
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
    item.settle(failure);
  }

  private async notifyStats(): Promise<void> {
    await this.onStatsChange?.(this.stats());
  }
}
