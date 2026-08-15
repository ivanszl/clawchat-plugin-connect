import type { RuntimeCapabilityRef } from "../plugin/sdk";
import { type AgentBindingConfig, type RuntimeWorkspace, runtimeFamilyFor } from "../types";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
  RuntimeActivitySnapshot,
  RuntimeCatalogScope,
  RuntimeCommandSummary,
  RuntimeInputMessageIdentity,
  RuntimeInputReconciliation,
  RuntimeLifecycleCapabilities,
  RuntimeModelOption,
  RuntimeSessionOption,
  RuntimeSkillSummary,
  RuntimeThreadSummary,
} from "./types";
import { RuntimeLifecycleError } from "./types";

export interface RuntimeAdapterDefinition {
  kind: string;
  runtime?: RuntimeCapabilityRef;
  create(binding: AgentBindingConfig): ConnectRuntimeAdapter;
}
export interface RuntimeAdapterReplacement {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  unregister(): Promise<void>;
}

const RUNTIME_CATALOG_TTL_MS = 30_000;

export class RuntimeAdapterRegistry {
  private readonly definitions = new Map<string, { definition: RuntimeAdapterDefinition; registration: symbol }>();
  private readonly adaptersByBinding = new Map<string, { providerKey: string; adapter: ConnectRuntimeAdapter }>();
  private readonly anonymousBindingIds = new WeakMap<object, string>();
  private nextAnonymousBindingId = 1;
  private readonly modelLists = new Map<
    string,
    { expiresAt: number; value?: RuntimeModelOption[]; loading?: Promise<RuntimeModelOption[]> }
  >();
  private readonly sessionOptionLists = new Map<
    string,
    { expiresAt: number; value?: RuntimeSessionOption[]; loading?: Promise<RuntimeSessionOption[]> }
  >();
  private readonly skillLists = new Map<
    string,
    { expiresAt: number; value?: RuntimeSkillSummary[]; loading?: Promise<RuntimeSkillSummary[]> }
  >();
  private readonly skillChangeSubscriptions = new Map<string, () => void>();
  private readonly commandLists = new Map<
    string,
    { expiresAt: number; value?: RuntimeCommandSummary[]; loading?: Promise<RuntimeCommandSummary[]> }
  >();
  private readonly commandChangeSubscriptions = new Map<string, () => void>();
  private readonly catalogChangeSubscriptions = new Map<string, () => void>();

  constructor(definitions: readonly RuntimeAdapterDefinition[]) {
    for (const definition of definitions) this.addDefinition(definition);
  }

  register(definition: RuntimeAdapterDefinition): () => Promise<void> {
    return this.registerAll([definition]);
  }

  registerAll(definitions: readonly RuntimeAdapterDefinition[]): () => Promise<void> {
    const pending = definitions.map((definition) => this.normalizeDefinition(definition));
    const providerKeys = new Set<string>();
    for (const { providerKey, definition } of pending) {
      if (this.definitions.has(providerKey) || providerKeys.has(providerKey)) {
        throw new Error(
          definition.runtime
            ? `duplicate Runtime Adapter provider: ${providerKey}`
            : `duplicate Runtime Adapter kind: ${definition.kind}`,
        );
      }
      providerKeys.add(providerKey);
    }
    const registration = Symbol("runtime-adapter-registration");
    for (const { providerKey, definition } of pending) {
      this.definitions.set(providerKey, { definition, registration });
    }
    let registered = true;
    return async () => {
      if (!registered) return;
      registered = false;
      await this.unregisterRegistration(providerKeys, registration);
    };
  }

  replaceAll(
    definitions: readonly RuntimeAdapterDefinition[],
    replacedRuntimeRefs: readonly RuntimeCapabilityRef[],
  ): RuntimeAdapterReplacement {
    const pending = definitions.map((definition) => this.normalizeDefinition(definition));
    const replacementKeys = new Set(
      replacedRuntimeRefs.map((runtime) => `plugin:${runtime.pluginId}\0${runtime.capabilityId}`),
    );
    const pendingKeys = new Set<string>();
    for (const { providerKey, definition } of pending) {
      if (pendingKeys.has(providerKey) || (this.definitions.has(providerKey) && !replacementKeys.has(providerKey))) {
        throw new Error(`duplicate Runtime Adapter provider: ${providerKey}`);
      }
      if (!definition.runtime) throw new Error("Only Plugin Runtime providers can participate in Bundle replacement");
      pendingKeys.add(providerKey);
    }

    const registration = Symbol("runtime-adapter-replacement");
    let state: "pending" | "committed" | "rolled-back" | "unregistered" = "pending";
    return {
      commit: async () => {
        if (state !== "pending") return;

        for (const providerKey of replacementKeys) this.definitions.delete(providerKey);
        for (const { providerKey, definition } of pending) {
          this.definitions.set(providerKey, { definition, registration });
        }
        state = "committed";
        const previousAdapters = this.takeAdaptersFor(replacementKeys);

        const results = await Promise.allSettled(previousAdapters.map(async ({ adapter }) => await adapter.close?.()));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      },
      rollback: async () => {
        if (state !== "pending") return;
        state = "rolled-back";
      },
      unregister: async () => {
        if (state === "unregistered" || state === "rolled-back") return;
        if (state === "pending") {
          throw new Error("Runtime Adapter replacement must be committed or rolled back before unregistering");
        }
        state = "unregistered";
        await this.unregisterRegistration(pendingKeys, registration);
      },
    };
  }

  async start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession> {
    return await this.require(binding).start(binding, context);
  }

  async prepare(binding: AgentBindingConfig): Promise<void> {
    await this.require(binding).prepare?.(binding);
  }

  modesFor(binding: AgentBindingConfig, scope?: RuntimeCatalogScope): readonly string[] {
    const adapter = this.require(binding);
    return adapter.modesFor?.(binding, scope) ?? adapter.modes;
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

  async listModels(binding: AgentBindingConfig, scope?: RuntimeCatalogScope): Promise<RuntimeModelOption[] | null> {
    const operation = this.require(binding).listModels;
    return await this.listCachedRuntimeCatalog(
      this.catalogKey(this.bindingId(binding), scope),
      this.modelLists,
      operation ? async () => await operation(binding, scope) : undefined,
    );
  }

  async listSessionOptions(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    scope?: RuntimeCatalogScope,
  ): Promise<RuntimeSessionOption[]> {
    const operation = this.require(binding).listSessionOptions;
    return (
      (await this.listCachedRuntimeCatalog(
        this.catalogKey(`${this.bindingId(binding)}\0${workspace.workingDirectory}`, scope),
        this.sessionOptionLists,
        operation ? async () => await operation(binding, workspace, scope) : undefined,
      )) ?? []
    );
  }

  async listSkills(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    options: { forceRefresh?: boolean; existingOnly?: boolean; waitMs?: number; runtimeThreadId?: string } = {},
  ): Promise<RuntimeSkillSummary[] | null> {
    const adapter = this.require(binding);
    return await this.listRuntimeCatalog(
      binding,
      workspace,
      this.skillLists,
      adapter.listSkills
        ? async () =>
            await adapter.listSkills?.(binding, workspace, {
              forceRefresh: options.forceRefresh,
              runtimeThreadId: options.runtimeThreadId,
            })
        : undefined,
      options,
    );
  }

  async listCommands(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    options: { forceRefresh?: boolean; existingOnly?: boolean; waitMs?: number; runtimeThreadId?: string } = {},
  ): Promise<RuntimeCommandSummary[] | null> {
    const adapter = this.require(binding);
    return await this.listRuntimeCatalog(
      binding,
      workspace,
      this.commandLists,
      adapter.listCommands
        ? async () =>
            await adapter.listCommands?.(binding, workspace, {
              forceRefresh: options.forceRefresh,
              runtimeThreadId: options.runtimeThreadId,
            })
        : undefined,
      options,
    );
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

  async reconcileInput(
    binding: AgentBindingConfig,
    runtimeThreadId: string,
    candidate: RuntimeInputMessageIdentity,
  ): Promise<RuntimeInputReconciliation> {
    const operation = this.require(binding).reconcileInput;
    if (!operation) return { outcome: "unknown" };
    try {
      return await operation(binding, runtimeThreadId, candidate);
    } catch {
      return { outcome: "unknown" };
    }
  }

  async verifyThreadReady(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    await this.require(binding).verifyThreadReady?.(binding, runtimeThreadId);
  }

  async archiveThread(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void> {
    const adapter = this.require(binding);
    const operation = adapter.archiveThread;
    if (!operation)
      throw new RuntimeLifecycleError(
        "unsupported",
        `${runtimeFamilyFor(binding)} Runtime Adapter does not support thread archiving`,
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
        `${runtimeFamilyFor(binding)} Runtime Adapter does not support thread restoration`,
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
        `${runtimeFamilyFor(binding)} Runtime Adapter does not support thread deletion`,
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
      [...this.adaptersByBinding.values()].map(async ({ adapter }) => await adapter.close?.()),
    );
    this.adaptersByBinding.clear();
    for (const bindingId of new Set([
      ...this.skillChangeSubscriptions.keys(),
      ...this.commandChangeSubscriptions.keys(),
      ...this.catalogChangeSubscriptions.keys(),
    ])) {
      this.clearBinding(bindingId);
    }
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private require(binding: AgentBindingConfig): ConnectRuntimeAdapter {
    const providerKey = this.providerKey(binding);
    const registered = this.definitions.get(providerKey);
    const definition = registered?.definition;
    const family = runtimeFamilyFor(binding);
    if (!definition) {
      if (binding.kind !== "plugin") {
        throw new Error(`no Runtime Adapter registered for kind: ${binding.kind}`);
      }
      throw new Error(
        `no Runtime Adapter registered for provider: ${binding.runtime.pluginId}/${binding.runtime.capabilityId}`,
      );
    }
    if (definition.kind !== family) {
      throw new Error(`Runtime provider ${providerKey} advertises ${definition.kind}, not Binding family ${family}`);
    }
    const bindingId = this.bindingId(binding);
    const existing = this.adaptersByBinding.get(bindingId);
    if (existing) {
      if (existing.providerKey !== providerKey) throw new Error(`Agent Binding ${bindingId} changed Runtime provider`);
      return existing.adapter;
    }
    const adapter = definition.create(binding);
    if (adapter.kind !== family) {
      throw new Error(`Runtime Adapter factory for ${providerKey} created ${adapter.kind}, expected ${family}`);
    }
    this.adaptersByBinding.set(bindingId, { providerKey, adapter });
    this.installAdapterSubscriptions(bindingId, adapter);
    return adapter;
  }

  private async listRuntimeCatalog<T>(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    cache: Map<string, { expiresAt: number; value?: T[]; loading?: Promise<T[]> }>,
    load: (() => Promise<T[] | undefined>) | undefined,
    options: { forceRefresh?: boolean; existingOnly?: boolean; waitMs?: number; runtimeThreadId?: string },
  ): Promise<T[] | null> {
    const key = `${this.bindingId(binding)}\0${workspace.workingDirectory}\0${options.runtimeThreadId ?? ""}`;
    return await this.listCachedRuntimeCatalog(key, cache, load, options);
  }

  private async listCachedRuntimeCatalog<T>(
    key: string,
    cache: Map<string, { expiresAt: number; value?: T[]; loading?: Promise<T[]> }>,
    load: (() => Promise<T[] | undefined>) | undefined,
    options: { forceRefresh?: boolean; existingOnly?: boolean; waitMs?: number } = {},
  ): Promise<T[] | null> {
    if (!load) return null;
    const cached = cache.get(key);
    if (!options.forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
    if (!options.forceRefresh && cached?.loading) {
      if (options.existingOnly) return await waitForRuntimeList(cached.loading, options.waitMs ?? 150);
      return await cached.loading;
    }
    if (options.existingOnly) return cached?.value ?? null;
    const loading = load()
      .then((value) => {
        const resolved = value ?? [];
        cache.set(key, { value: resolved, expiresAt: Date.now() + RUNTIME_CATALOG_TTL_MS });
        return resolved;
      })
      .catch((error) => {
        cache.delete(key);
        throw error;
      });
    cache.set(key, { loading, expiresAt: 0 });
    return await loading;
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

  private addDefinition(definition: RuntimeAdapterDefinition): string {
    const normalized = this.normalizeDefinition(definition);
    if (this.definitions.has(normalized.providerKey)) {
      throw new Error(
        normalized.definition.runtime
          ? `duplicate Runtime Adapter provider: ${normalized.providerKey}`
          : `duplicate Runtime Adapter kind: ${normalized.definition.kind}`,
      );
    }
    this.definitions.set(normalized.providerKey, {
      definition: normalized.definition,
      registration: Symbol("builtin-runtime-adapter"),
    });
    return normalized.providerKey;
  }

  private normalizeDefinition(definition: RuntimeAdapterDefinition): {
    providerKey: string;
    definition: RuntimeAdapterDefinition;
  } {
    const kind = definition.kind.trim();
    if (!kind) throw new Error("Runtime Adapter family is required");
    return {
      providerKey: definition.runtime
        ? `plugin:${definition.runtime.pluginId}\0${definition.runtime.capabilityId}`
        : `builtin:${kind}`,
      definition: { ...definition, kind },
    };
  }

  private providerKey(binding: AgentBindingConfig): string {
    return binding.kind === "plugin"
      ? `plugin:${binding.runtime.pluginId}\0${binding.runtime.capabilityId}`
      : `builtin:${binding.kind}`;
  }

  private installAdapterSubscriptions(bindingId: string, adapter: ConnectRuntimeAdapter): void {
    if (adapter.onSkillsChanged) {
      this.skillChangeSubscriptions.set(
        bindingId,
        adapter.onSkillsChanged(() => {
          for (const key of this.skillLists.keys()) if (key.startsWith(`${bindingId}\0`)) this.skillLists.delete(key);
        }),
      );
    }
    if (adapter.onCommandsChanged) {
      this.commandChangeSubscriptions.set(
        bindingId,
        adapter.onCommandsChanged(() => {
          for (const key of this.commandLists.keys()) {
            if (key.startsWith(`${bindingId}\0`)) this.commandLists.delete(key);
          }
        }),
      );
    }
    if (adapter.onCatalogsChanged) {
      this.catalogChangeSubscriptions.set(
        bindingId,
        adapter.onCatalogsChanged(() => this.invalidateBindingCatalogs(bindingId)),
      );
    }
  }

  private takeAdaptersFor(
    providerKeys: ReadonlySet<string>,
  ): Array<{ bindingId: string; providerKey: string; adapter: ConnectRuntimeAdapter }> {
    const removed: Array<{ bindingId: string; providerKey: string; adapter: ConnectRuntimeAdapter }> = [];
    for (const [bindingId, instance] of this.adaptersByBinding) {
      if (!providerKeys.has(instance.providerKey)) continue;
      removed.push({ bindingId, ...instance });
      this.adaptersByBinding.delete(bindingId);
      this.clearBinding(bindingId);
    }
    return removed;
  }

  private async unregisterRegistration(providerKeys: ReadonlySet<string>, registration: symbol): Promise<void> {
    const ownedKeys = new Set<string>();
    for (const providerKey of providerKeys) {
      if (this.definitions.get(providerKey)?.registration !== registration) continue;
      this.definitions.delete(providerKey);
      ownedKeys.add(providerKey);
    }
    const closing = this.takeAdaptersFor(ownedKeys);
    const results = await Promise.allSettled(closing.map(async ({ adapter }) => await adapter.close?.()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private clearBinding(bindingId: string): void {
    this.skillChangeSubscriptions.get(bindingId)?.();
    this.commandChangeSubscriptions.get(bindingId)?.();
    this.catalogChangeSubscriptions.get(bindingId)?.();
    this.skillChangeSubscriptions.delete(bindingId);
    this.commandChangeSubscriptions.delete(bindingId);
    this.catalogChangeSubscriptions.delete(bindingId);
    this.invalidateBindingCatalogs(bindingId);
  }

  private catalogKey(prefix: string, scope?: RuntimeCatalogScope): string {
    return `${prefix}\0${scope?.runtimeThreadId ?? ""}\0${scope?.workspace?.workingDirectory ?? ""}`;
  }

  private invalidateBindingCatalogs(bindingId: string): void {
    for (const cache of [this.modelLists, this.sessionOptionLists, this.skillLists, this.commandLists]) {
      for (const key of cache.keys()) if (key.startsWith(`${bindingId}\0`)) cache.delete(key);
    }
  }
}

async function waitForRuntimeList<T>(loading: Promise<T[]>, waitMs: number): Promise<T[] | null> {
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
