import type { TranscriptProjection } from "../client-interface/transcript-projection";
import type { RuntimeAdapterRegistry } from "./registry";
import type { RuntimeInteractionCoordinator } from "./runtime-interaction-coordinator";
import type { SessionQueue, SessionQueueOptions } from "./session-queue";
import type { SessionTurnExecutor, SessionTurnExecutorOptions } from "./session-turn-executor";

export interface ConnectExecutionCapabilities {
  readonly runtimeAdapters: RuntimeAdapterRegistry;
  readonly transcriptProjection: TranscriptProjection;
  readonly runtimeInteractions: RuntimeInteractionCoordinator;
  createSessionQueue(bindingId: string, options: SessionQueueOptions): SessionQueue;
  createSessionTurnExecutor(options: Omit<SessionTurnExecutorOptions, "start">): SessionTurnExecutor;
  quiesceBindings<T>(bindingIds: readonly string[], criticalSection: () => Promise<T>): Promise<T>;
}
