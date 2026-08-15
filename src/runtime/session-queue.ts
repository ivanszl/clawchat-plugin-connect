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
  state: SessionQueueTicketState;
  run: () => Promise<void>;
  settle(failure: Error | null): void;
}
export type SessionQueueTicketState = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface SessionQueueTicket {
  readonly state: SessionQueueTicketState;
  readonly completion: Promise<void>;
  cancel(): boolean;
}
export class SessionQueue {
  private readonly maxConcurrentTurns: number;
  private readonly maxPendingPerSession: number;
  private readonly onStatsChange?: (stats: QueueStats) => Promise<void> | void;
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly runningSessions = new Set<string>();
  private readonly lifecycleClaims = new Set<string>();
  private readonly acceptanceReservations = new Map<string, number>();
  private bindingQuiescing = false;
  private pendingLifecycleAcquisitions = 0;
  private admissionsSettled: (() => void) | undefined;
  private runningSettled: (() => void) | undefined;
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
    await this.submit(sessionIdentity, run, displayIdentity).completion;
  }
  submit(
    sessionIdentity: string,
    run: () => Promise<void>,
    displayIdentity = `Session ${sessionIdentity}`,
  ): SessionQueueTicket {
    return this.submitItem(sessionIdentity, run, displayIdentity, false);
  }
  async submitAccepted(
    sessionIdentity: string,
    run: () => Promise<void>,
    accept: () => Promise<void>,
    displayIdentity = `Session ${sessionIdentity}`,
  ): Promise<SessionQueueTicket> {
    this.assertAccepting(sessionIdentity, displayIdentity);
    const queue = this.queues.get(sessionIdentity) ?? [];
    const reserved = this.acceptanceReservations.get(sessionIdentity) ?? 0;
    if (queue.length + reserved >= this.maxPendingPerSession) {
      throw new Error(`too many pending turns for ${displayIdentity}`);
    }
    this.acceptanceReservations.set(sessionIdentity, reserved + 1);
    try {
      await accept();
    } catch (error) {
      this.releaseAcceptanceReservation(sessionIdentity);
      throw error;
    }
    this.releaseAcceptanceReservation(sessionIdentity);
    return this.submitItem(sessionIdentity, run, displayIdentity, true);
  }

  assertAccepting(sessionIdentity: string, displayIdentity = `Session ${sessionIdentity}`): void {
    if (this.bindingQuiescing) {
      throw new Error(`${displayIdentity} Agent Binding lifecycle operation is in progress`);
    }
    if (this.lifecycleClaims.has(sessionIdentity)) {
      throw new Error(`${displayIdentity} lifecycle operation is in progress`);
    }
  }

  async acquireBindingQuiescence(displayIdentity = "Agent Binding"): Promise<() => Promise<void>> {
    if (this.bindingQuiescing) {
      throw new Error(`${displayIdentity} lifecycle operation is already in progress`);
    }
    this.bindingQuiescing = true;
    this.rejectQueued(`${displayIdentity} lifecycle operation started`);
    try {
      await this.waitForAdmissions();
      this.rejectQueued(`${displayIdentity} lifecycle operation started`);
      await this.waitForRunningTurns();
    } catch (error) {
      this.bindingQuiescing = false;
      this.pump();
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.bindingQuiescing = false;
      this.pump();
      await this.notifyStats().catch(() => undefined);
    };
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
    if (this.bindingQuiescing) {
      throw new Error(`${displayIdentity} Agent Binding lifecycle operation is in progress`);
    }
    if (this.lifecycleClaims.has(sessionIdentity)) {
      throw new Error(`${displayIdentity} lifecycle operation is in progress`);
    }
    if ((this.acceptanceReservations.get(sessionIdentity) ?? 0) > 0) {
      throw new Error(`${displayIdentity} Turn acceptance is in progress`);
    }
    this.lifecycleClaims.add(sessionIdentity);
    this.pendingLifecycleAcquisitions += 1;
    const queue = this.queues.get(sessionIdentity) ?? [];
    this.queues.set(sessionIdentity, queue);
    for (const pending of queue.splice(0)) {
      pending.settle(new Error(`${displayIdentity} lifecycle operation started`));
    }
    try {
      await onClaim?.();
    } catch (error) {
      this.lifecycleClaims.delete(sessionIdentity);
      if (queue.length === 0 && !this.runningSessions.has(sessionIdentity)) this.queues.delete(sessionIdentity);
      this.releaseLifecycleAcquisition();
      throw error;
    }
    this.releaseLifecycleAcquisition();
    if (this.bindingQuiescing) {
      this.lifecycleClaims.delete(sessionIdentity);
      if (queue.length === 0 && !this.runningSessions.has(sessionIdentity)) this.queues.delete(sessionIdentity);
      throw new Error(`${displayIdentity} Agent Binding lifecycle operation is in progress`);
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
      const { item, ticket } = this.createItem(
        sessionIdentity,
        async () => {
          await onAcquired?.();
          resolve(async () => {
            releaseOperation();
            await settled;
          });
          await released;
        },
        (failure) => {
          try {
            if (failure) reject(failure);
          } finally {
            this.lifecycleClaims.delete(sessionIdentity);
            settleOperation();
          }
        },
      );
      void ticket.completion.catch(() => undefined);
      queue.push(item);
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
  private submitItem(
    sessionIdentity: string,
    run: () => Promise<void>,
    displayIdentity: string,
    admittedBeforeBindingGate: boolean,
  ): SessionQueueTicket {
    if (!admittedBeforeBindingGate) this.assertAccepting(sessionIdentity, displayIdentity);
    else if (this.lifecycleClaims.has(sessionIdentity)) {
      throw new Error(`${displayIdentity} lifecycle operation is in progress`);
    }
    const queue = this.queues.get(sessionIdentity) ?? [];
    if (queue.length >= this.maxPendingPerSession) {
      throw new Error(`too many pending turns for ${displayIdentity}`);
    }
    this.queues.set(sessionIdentity, queue);
    const { item, ticket } = this.createItem(sessionIdentity, run);
    queue.push(item);
    this.pump();
    void this.notifyStats().catch(() => undefined);
    return ticket;
  }

  private rejectQueued(message: string): void {
    for (const [sessionIdentity, queue] of this.queues) {
      for (const pending of queue.splice(0)) pending.settle(new Error(message));
      if (!this.runningSessions.has(sessionIdentity)) this.queues.delete(sessionIdentity);
    }
    void this.notifyStats().catch(() => undefined);
  }

  private async waitForAdmissions(): Promise<void> {
    if (this.acceptanceReservations.size === 0 && this.pendingLifecycleAcquisitions === 0) return;
    await new Promise<void>((resolve) => {
      this.admissionsSettled = resolve;
    });
  }

  private async waitForRunningTurns(): Promise<void> {
    if (this.running === 0) return;
    await new Promise<void>((resolve) => {
      this.runningSettled = resolve;
    });
  }

  private pump(): void {
    if (this.bindingQuiescing) return;
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
      item.state = "running";
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
    if (this.running === 0) {
      this.runningSettled?.();
      this.runningSettled = undefined;
    }
  }

  private createItem(
    sessionIdentity: string,
    run: () => Promise<void>,
    onSettled?: (failure: Error | null) => void,
  ): { item: QueueItem; ticket: SessionQueueTicket } {
    let resolveCompletion: () => void = () => undefined;
    let rejectCompletion: (error: Error) => void = () => undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const item: QueueItem = {
      state: "queued",
      run,
      settle: (failure) => {
        if (item.state !== "cancelled") item.state = failure ? "failed" : "completed";
        if (failure) rejectCompletion(failure);
        else resolveCompletion();
        onSettled?.(failure);
      },
    };
    const ticket: SessionQueueTicket = {
      get state() {
        return item.state;
      },
      completion,
      cancel: () => {
        if (item.state !== "queued") return false;
        const queue = this.queues.get(sessionIdentity);
        const index = queue?.indexOf(item) ?? -1;
        if (!queue || index < 0) return false;
        queue.splice(index, 1);
        item.state = "cancelled";
        item.settle(new Error(`Session ${sessionIdentity} queued turn cancelled before execution`));
        if (queue.length === 0 && !this.runningSessions.has(sessionIdentity)) this.queues.delete(sessionIdentity);
        void this.notifyStats().catch(() => undefined);
        this.pump();
        return true;
      },
    };
    return { item, ticket };
  }

  private releaseAcceptanceReservation(sessionIdentity: string): void {
    const reserved = this.acceptanceReservations.get(sessionIdentity) ?? 0;
    if (reserved <= 1) this.acceptanceReservations.delete(sessionIdentity);
    else this.acceptanceReservations.set(sessionIdentity, reserved - 1);
    this.settleAdmissionsIfIdle();
  }

  private releaseLifecycleAcquisition(): void {
    this.pendingLifecycleAcquisitions -= 1;
    this.settleAdmissionsIfIdle();
  }

  private settleAdmissionsIfIdle(): void {
    if (this.acceptanceReservations.size === 0 && this.pendingLifecycleAcquisitions === 0) {
      this.admissionsSettled?.();
      this.admissionsSettled = undefined;
    }
  }
  private async notifyStats(): Promise<void> {
    await this.onStatsChange?.(this.stats());
  }
}
