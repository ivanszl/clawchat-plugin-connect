import type { AgentBindingConfig } from "../types";
import type { TurnTarget } from "../workspaces/session-continuity";
import type { ConnectRuntimePrompt, ConnectRuntimeSession, ConnectRuntimeStartContext, RuntimeActivity } from "./types";

export interface SessionTurnExecutorOptions {
  configPath: string;
  stateDbPath: string;
  bindingFor(bindingId: string): AgentBindingConfig;
  start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession>;
  attachRuntimeThread(sessionRef: string, runtimeThreadId: string | null): Promise<void>;
}

export type SessionTurnExecution = Omit<ConnectRuntimePrompt, "turnOrigin">;

export class SessionTurnExecutor {
  private readonly handles = new Map<string, { bindingId: string; handle: ConnectRuntimeSession }>();

  constructor(private readonly options: SessionTurnExecutorOptions) {}

  async *execute(target: TurnTarget, input: SessionTurnExecution): AsyncIterable<RuntimeActivity> {
    const handle = await this.handleFor(target);
    yield* handle.prompt({ ...input, turnOrigin: target.turnOrigin });
  }

  async cancel(sessionRef: string): Promise<boolean> {
    return (await this.handles.get(normalizeSessionRef(sessionRef))?.handle.cancel?.()) ?? false;
  }

  async release(sessionRef: string): Promise<boolean> {
    const key = normalizeSessionRef(sessionRef);
    const entry = this.handles.get(key);
    if (!entry) return false;
    this.handles.delete(key);
    await entry.handle.close();
    return true;
  }

  async invalidate(sessionRef: string): Promise<boolean> {
    const released = await this.release(sessionRef);
    await this.options.attachRuntimeThread(normalizeSessionRef(sessionRef), null);
    return released;
  }

  async releaseBindings(bindingIds: ReadonlySet<string>): Promise<void> {
    if (bindingIds.size === 0) return;
    const handles: ConnectRuntimeSession[] = [];
    for (const [sessionRef, entry] of this.handles) {
      if (!bindingIds.has(entry.bindingId)) continue;
      this.handles.delete(sessionRef);
      handles.push(entry.handle);
    }
    const results = await Promise.allSettled(handles.map(async (handle) => await handle.close()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async close(): Promise<void> {
    const handles = [...this.handles.values()].map(({ handle }) => handle);
    this.handles.clear();
    const results = await Promise.allSettled(handles.map(async (handle) => await handle.close()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async handleFor(target: TurnTarget): Promise<ConnectRuntimeSession> {
    const key = normalizeSessionRef(target.sessionRef);
    const existing = this.handles.get(key);
    if (existing) return existing.handle;
    const binding = this.options.bindingFor(target.bindingId);
    const handle = await this.options.start(binding, {
      agentId: target.bindingId,
      chatId: target.chatId,
      sessionId: target.sessionId,
      runtimeSessionId: target.runtimeThreadId,
      configPath: this.options.configPath,
      stateDbPath: this.options.stateDbPath,
      onRuntimeSessionId: async (runtimeThreadId) => {
        await this.options.attachRuntimeThread(target.sessionRef, runtimeThreadId);
      },
    });
    this.handles.set(key, { bindingId: target.bindingId, handle });
    return handle;
  }
}

function normalizeSessionRef(sessionRef: string): string {
  return sessionRef.trim().toUpperCase();
}
