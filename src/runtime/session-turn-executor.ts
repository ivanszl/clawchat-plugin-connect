import type { TurnTarget } from "../session-continuity";
import type { AgentBindingConfig } from "../types";
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
  private readonly handles = new Map<string, ConnectRuntimeSession>();

  constructor(private readonly options: SessionTurnExecutorOptions) {}

  async *execute(target: TurnTarget, input: SessionTurnExecution): AsyncIterable<RuntimeActivity> {
    const handle = await this.handleFor(target);
    yield* handle.prompt({ ...input, turnOrigin: target.turnOrigin });
  }

  async cancel(sessionRef: string): Promise<boolean> {
    return (await this.handles.get(normalizeSessionRef(sessionRef))?.cancel?.()) ?? false;
  }

  async release(sessionRef: string): Promise<boolean> {
    const key = normalizeSessionRef(sessionRef);
    const handle = this.handles.get(key);
    if (!handle) return false;
    this.handles.delete(key);
    await handle.close();
    return true;
  }

  async invalidate(sessionRef: string): Promise<boolean> {
    const released = await this.release(sessionRef);
    await this.options.attachRuntimeThread(normalizeSessionRef(sessionRef), null);
    return released;
  }

  async close(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    const results = await Promise.allSettled(handles.map(async (handle) => await handle.close()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async handleFor(target: TurnTarget): Promise<ConnectRuntimeSession> {
    const key = normalizeSessionRef(target.sessionRef);
    const existing = this.handles.get(key);
    if (existing) return existing;
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
    this.handles.set(key, handle);
    return handle;
  }
}

function normalizeSessionRef(sessionRef: string): string {
  return sessionRef.trim().toUpperCase();
}
