export interface QueueStats {
  running: number;
  queued: number;
  chats: number;
}
export interface SessionQueueOptions {
  maxConcurrentTurns?: number;
  maxPendingPerChat?: number;
}
interface QueueItem {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}
export class SessionQueue {
  private readonly maxConcurrentTurns: number;
  private readonly maxPendingPerChat: number;
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly runningChats = new Set<string>();
  private running = 0;
  constructor(options: SessionQueueOptions = {}) {
    this.maxConcurrentTurns = options.maxConcurrentTurns ?? 4;
    this.maxPendingPerChat = options.maxPendingPerChat ?? 20;
  }
  async enqueue(chatId: string, run: () => Promise<void>): Promise<void> {
    const queue = this.queues.get(chatId) ?? [];
    if (queue.length >= this.maxPendingPerChat) throw new Error(`too many pending turns for chat ${chatId}`);
    this.queues.set(chatId, queue);
    await new Promise<void>((resolve, reject) => {
      queue.push({ run, resolve, reject });
      this.pump();
    });
  }
  stats(): QueueStats {
    let queued = 0;
    for (const queue of this.queues.values()) queued += queue.length;
    return { running: this.running, queued, chats: this.queues.size };
  }
  private pump(): void {
    if (this.running >= this.maxConcurrentTurns) return;
    for (const [chatId, queue] of this.queues) {
      if (this.running >= this.maxConcurrentTurns) return;
      if (this.runningChats.has(chatId)) continue;
      const item = queue.shift();
      if (!item) {
        this.queues.delete(chatId);
        continue;
      }
      this.running += 1;
      this.runningChats.add(chatId);
      void item
        .run()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this.runningChats.delete(chatId);
          if ((this.queues.get(chatId)?.length ?? 0) === 0) this.queues.delete(chatId);
          this.pump();
        });
    }
  }
}
