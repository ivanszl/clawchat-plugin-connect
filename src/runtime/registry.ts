import type { AgentBindingConfig, RuntimeWorkspace } from "../types";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
  RuntimeActivitySnapshot,
  RuntimeLifecycleCapabilities,
  RuntimeModelOption,
  RuntimeSessionOption,
  RuntimeSkillSummary,
  RuntimeThreadSummary,
} from "./types";
import { RuntimeLifecycleError } from "./types";

export interface RuntimeAdapterDefinition {
  kind: string;
  create(): ConnectRuntimeAdapter;
}

export class RuntimeAdapterRegistry {
  private readonly definitions = new Map<string, RuntimeAdapterDefinition>();
  private readonly adaptersByBinding = new Map<string, ConnectRuntimeAdapter>();
  private readonly anonymousBindingIds = new WeakMap<object, string>();
  private nextAnonymousBindingId = 1;
  private readonly skillLists = new Map<
    string,
    { expiresAt: number; value?: RuntimeSkillSummary[]; loading?: Promise<RuntimeSkillSummary[]> }
  >();
  private readonly skillChangeSubscriptions = new Map<string, () => void>();

  constructor(definitions: readonly RuntimeAdapterDefinition[]) {
    for (const definition of definitions) {
      const kind = definition.kind.trim();
      if (!kind) throw new Error("Runtime Adapter kind is required");
      if (this.definitions.has(kind)) throw new Error(`duplicate Runtime Adapter kind: ${kind}`);
      this.definitions.set(kind, definition);
    }
  }

  async start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession> {
    return await this.require(binding).start(binding, context);
  }

  async prepare(binding: AgentBindingConfig): Promise<void> {
    await this.require(binding).prepare?.(binding);
  }

  modesFor(binding: AgentBindingConfig): readonly string[] {
    return this.require(binding).modes;
  }

  lifecycleCapabilities(binding: AgentBindingConfig): RuntimeLifecycleCapabilities {
    const adapter = this.require(binding);
    return (
      adapter.lifecycleCapabilities ?? {
        archive: Boolean(adapter.archiveThread),
        restore: Boolean(adapter.unarchiveThread),
        delete: Boolean(adapter.deleteThread),
      }
    );
  }

  async listModels(binding: AgentBindingConfig): Promise<RuntimeModelOption[] | null> {
    const operation = this.require(binding).listModels;
    return operation ? await operation(binding) : null;
  }

  async listSessionOptions(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeSessionOption[]> {
    return (await this.require(binding).listSessionOptions?.(binding, workspace)) ?? [];
  }

  async listSkills(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    options: { forceRefresh?: boolean; existingOnly?: boolean; waitMs?: number } = {},
  ): Promise<RuntimeSkillSummary[] | null> {
    const adapter = this.require(binding);
    if (!adapter.listSkills) return null;
    const bindingId = this.bindingId(binding);
    const key = `${bindingId}\0${workspace.workingDirectory}`;
    const cached = this.skillLists.get(key);
    if (!options.forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
    if (!options.forceRefresh && cached?.loading) {
      if (options.existingOnly) return await waitForSkillList(cached.loading, options.waitMs ?? 150);
      return await cached.loading;
    }
    if (options.existingOnly) return cached?.value ?? null;
    const loading = adapter
      .listSkills(binding, workspace, { forceRefresh: options.forceRefresh })
      .then((value) => {
        this.skillLists.set(key, { value, expiresAt: Date.now() + 30_000 });
        return value;
      })
      .catch((error) => {
        this.skillLists.delete(key);
        throw error;
      });
    this.skillLists.set(key, { loading, expiresAt: 0 });
    return await loading;
  }

  async discoverThreads(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]> {
    return (await this.require(binding).discoverThreads?.(binding, workspace)) ?? [];
  }

  async discoverAllThreads(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]> {
    return (await this.require(binding).discoverAllThreads?.(binding)) ?? [];
  }

  async discoverArchivedThreads(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]> {
    return (await this.require(binding).discoverArchivedThreads?.(binding)) ?? [];
  }

  async readActivity(binding: AgentBindingConfig, runtimeThreadId: string): Promise<RuntimeActivitySnapshot> {
    const adapter = this.require(binding);
    if (adapter.readActivity) return await adapter.readActivity(binding, runtimeThreadId);
    return {
      activities: [],
      completeness: "live-only",
      limitations: ["identity", "correlation", "ordering"],
    };
  }

  async archiveThread(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    const adapter = this.require(binding);
    const operation = adapter.archiveThread;
    if (!operation)
      throw new RuntimeLifecycleError(
        "unsupported",
        `${binding.kind} Runtime Adapter does not support thread archiving`,
      );
    if (adapter.discoverArchivedThreads) {
      if ((await adapter.discoverArchivedThreads(binding)).some((thread) => thread.runtimeThreadId === runtimeThreadId))
        return;
      if (
        adapter.discoverAllThreads &&
        !(await adapter.discoverAllThreads(binding)).some((thread) => thread.runtimeThreadId === runtimeThreadId)
      ) {
        throw new RuntimeLifecycleError("not-found", `Runtime Thread ${runtimeThreadId} was not found`);
      }
    }
    await runLifecycleMutation("archive", () => operation(binding, runtimeThreadId));
  }

  async unarchiveThread(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    const adapter = this.require(binding);
    const operation = adapter.unarchiveThread;
    if (!operation)
      throw new RuntimeLifecycleError(
        "unsupported",
        `${binding.kind} Runtime Adapter does not support thread restoration`,
      );
    if (adapter.discoverAllThreads) {
      if ((await adapter.discoverAllThreads(binding)).some((thread) => thread.runtimeThreadId === runtimeThreadId))
        return;
      if (
        adapter.discoverArchivedThreads &&
        !(await adapter.discoverArchivedThreads(binding)).some((thread) => thread.runtimeThreadId === runtimeThreadId)
      ) {
        throw new RuntimeLifecycleError("not-found", `Runtime Thread ${runtimeThreadId} was not found`);
      }
    }
    await runLifecycleMutation("restore", () => operation(binding, runtimeThreadId));
  }

  async deleteThread(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    const adapter = this.require(binding);
    const operation = adapter.deleteThread;
    if (!operation)
      throw new RuntimeLifecycleError(
        "unsupported",
        `${binding.kind} Runtime Adapter does not support thread deletion`,
      );
    if (adapter.discoverAllThreads && adapter.discoverArchivedThreads) {
      const [active, archived] = await Promise.all([
        adapter.discoverAllThreads(binding),
        adapter.discoverArchivedThreads(binding),
      ]);
      if (![...active, ...archived].some((thread) => thread.runtimeThreadId === runtimeThreadId)) return;
    }
    await runLifecycleMutation("delete", () => operation(binding, runtimeThreadId));
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.adaptersByBinding.values()].map(async (adapter) => await adapter.close?.()),
    );
    this.adaptersByBinding.clear();
    for (const unsubscribe of this.skillChangeSubscriptions.values()) unsubscribe();
    this.skillChangeSubscriptions.clear();
    this.skillLists.clear();
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private require(binding: AgentBindingConfig): ConnectRuntimeAdapter {
    const definition = this.definitions.get(binding.kind);
    if (!definition) throw new Error(`no Runtime Adapter registered for kind: ${binding.kind}`);
    const bindingId = this.bindingId(binding);
    const existing = this.adaptersByBinding.get(bindingId);
    if (existing) {
      if (existing.kind !== binding.kind) throw new Error(`Agent Binding ${bindingId} changed Runtime Adapter kind`);
      return existing;
    }
    const adapter = definition.create();
    if (adapter.kind !== binding.kind)
      throw new Error(`Runtime Adapter factory for ${binding.kind} created ${adapter.kind}`);
    this.adaptersByBinding.set(bindingId, adapter);
    if (adapter.onSkillsChanged) {
      this.skillChangeSubscriptions.set(
        bindingId,
        adapter.onSkillsChanged(() => {
          for (const key of this.skillLists.keys()) if (key.startsWith(`${bindingId}\0`)) this.skillLists.delete(key);
        }),
      );
    }
    return adapter;
  }

  private bindingId(binding: AgentBindingConfig): string {
    const injected = binding.env?.CLAWCHAT_CONNECT_AGENT_ID?.trim();
    if (injected) return injected;
    const existing = this.anonymousBindingIds.get(binding);
    if (existing) return existing;
    const created = `anonymous-${this.nextAnonymousBindingId}`;
    this.nextAnonymousBindingId += 1;
    this.anonymousBindingIds.set(binding, created);
    return created;
  }
}

async function waitForSkillList(
  loading: Promise<RuntimeSkillSummary[]>,
  waitMs: number,
): Promise<RuntimeSkillSummary[] | null> {
  if (waitMs <= 0) return null;
  return await Promise.race([
    loading,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), waitMs);
    }),
  ]);
}

async function runLifecycleMutation(action: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof RuntimeLifecycleError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = /(?:not[\s-]*found|unknown thread|404)/iu.test(message) ? "not-found" : "conflict";
    throw new RuntimeLifecycleError(code, `Runtime Thread ${action} failed: ${message}`, { cause: error });
  }
}
