import type { AgentBindingConfig, RuntimeWorkspace } from "../types";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
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

  modesFor(binding: AgentBindingConfig): readonly string[] {
    return this.require(binding.kind).modes;
  }

  async discoverThreads(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]> {
    return (await this.require(binding.kind).discoverThreads?.(binding, workspace)) ?? [];
  }

  private require(kind: string): ConnectRuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no Runtime Adapter registered for kind: ${kind}`);
    return adapter;
  }
}
