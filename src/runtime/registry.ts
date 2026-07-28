import type { AgentBindingConfig, RuntimeWorkspace } from "../types";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
  RuntimeActivitySnapshot,
  RuntimeLifecycleCapabilities,
  RuntimeModelOption,
  RuntimeThreadSummary,
} from "./types";

export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, ConnectRuntimeAdapter>();

  constructor(adapters: readonly ConnectRuntimeAdapter[]) {
    for (const adapter of adapters) {
      const kind = adapter.kind.trim();
      if (!kind) throw new Error("Runtime Adapter kind is required");
      if (this.adapters.has(kind)) throw new Error(`duplicate Runtime Adapter kind: ${kind}`);
      this.adapters.set(kind, adapter);
    }
  }

  async start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession> {
    return await this.require(binding.kind).start(binding, context);
  }

  async prepare(binding: AgentBindingConfig): Promise<void> {
    await this.require(binding.kind).prepare?.(binding);
  }

  modesFor(binding: AgentBindingConfig): readonly string[] {
    return this.require(binding.kind).modes;
  }

  lifecycleCapabilities(binding: AgentBindingConfig): RuntimeLifecycleCapabilities {
    const adapter = this.require(binding.kind);
    return (
      adapter.lifecycleCapabilities ?? {
        archive: Boolean(adapter.archiveThread),
        restore: Boolean(adapter.unarchiveThread),
        delete: Boolean(adapter.deleteThread),
      }
    );
  }

  async listModels(binding: AgentBindingConfig): Promise<RuntimeModelOption[] | null> {
    const operation = this.require(binding.kind).listModels;
    return operation ? await operation(binding) : null;
  }

  async discoverThreads(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]> {
    return (await this.require(binding.kind).discoverThreads?.(binding, workspace)) ?? [];
  }

  async discoverAllThreads(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]> {
    return (await this.require(binding.kind).discoverAllThreads?.(binding)) ?? [];
  }

  async discoverArchivedThreads(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]> {
    return (await this.require(binding.kind).discoverArchivedThreads?.(binding)) ?? [];
  }

  async readActivity(binding: AgentBindingConfig, runtimeThreadId: string): Promise<RuntimeActivitySnapshot> {
    const adapter = this.require(binding.kind);
    if (adapter.readActivity) return await adapter.readActivity(binding, runtimeThreadId);
    return {
      activities: [],
      completeness: "live-only",
      limitations: ["identity", "correlation", "ordering"],
    };
  }

  async archiveThread(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    const adapter = this.require(binding.kind);
    const operation = adapter.archiveThread;
    if (!operation) throw new Error(`${binding.kind} Runtime Adapter does not support thread archiving`);
    if (
      adapter.discoverArchivedThreads &&
      (await adapter.discoverArchivedThreads(binding)).some((thread) => thread.runtimeThreadId === runtimeThreadId)
    ) {
      return;
    }
    await operation(binding, runtimeThreadId);
  }

  async unarchiveThread(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    const adapter = this.require(binding.kind);
    const operation = adapter.unarchiveThread;
    if (!operation) throw new Error(`${binding.kind} Runtime Adapter does not support thread restoration`);
    if (
      adapter.discoverAllThreads &&
      (await adapter.discoverAllThreads(binding)).some((thread) => thread.runtimeThreadId === runtimeThreadId)
    ) {
      return;
    }
    await operation(binding, runtimeThreadId);
  }

  async deleteThread(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    const adapter = this.require(binding.kind);
    const operation = adapter.deleteThread;
    if (!operation) throw new Error(`${binding.kind} Runtime Adapter does not support thread deletion`);
    if (adapter.discoverAllThreads && adapter.discoverArchivedThreads) {
      const [active, archived] = await Promise.all([
        adapter.discoverAllThreads(binding),
        adapter.discoverArchivedThreads(binding),
      ]);
      if (![...active, ...archived].some((thread) => thread.runtimeThreadId === runtimeThreadId)) return;
    }
    await operation(binding, runtimeThreadId);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => await adapter.close?.()),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private require(kind: string): ConnectRuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no Runtime Adapter registered for kind: ${kind}`);
    return adapter;
  }
}
