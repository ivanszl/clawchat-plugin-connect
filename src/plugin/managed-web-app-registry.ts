import type {
  ConnectPluginConfiguration,
  ConnectPluginDisposer,
  ConnectPluginManagedWebAppCapabilityManifest,
  ConnectPluginManagedWebAppInstance,
  ConnectPluginManagedWebAppInstanceContext,
  ConnectPluginManagedWebAppProvider,
  ManagedWebAppGenerationReference,
  ManagedWebAppHealth,
  RuntimeCapabilityRef,
} from "./sdk";

export interface ManagedWebAppProviderDefinition {
  readonly pluginId: string;
  readonly activationGeneration: number;
  readonly manifest: ConnectPluginManagedWebAppCapabilityManifest;
  readonly installationConfiguration: ConnectPluginConfiguration;
  readonly configuration: ConnectPluginConfiguration;
  readonly provider: ConnectPluginManagedWebAppProvider;
}
export interface ManagedWebAppBindingRequest {
  readonly bindingId: string;
  readonly runtime: RuntimeCapabilityRef;
  readonly runtimeConfiguration: ConnectPluginConfiguration;
}
export interface ManagedWebAppSelection extends ManagedWebAppGenerationReference {
  readonly kind: "native" | "compatible";
  readonly displayName: string;
  readonly description: string;
}
export interface ManagedWebAppSelectionCandidate extends ManagedWebAppGenerationReference {
  readonly manifest: ConnectPluginManagedWebAppCapabilityManifest;
}
export interface ManagedWebAppLease {
  readonly selection: ManagedWebAppSelection;
  readonly instanceKey: string;
  readonly upstream: string;
  health(): ManagedWebAppHealth;
  onHealthChange(listener: (health: ManagedWebAppHealth) => void): ConnectPluginDisposer;
  release(): Promise<void>;
}
export interface ManagedWebAppRegistrySnapshot {
  readonly selection: ManagedWebAppSelection;
  readonly instanceKey: string;
  readonly health: ManagedWebAppHealth;
  readonly diagnostic: string | null;
  readonly leaseCount: number;
  readonly bindingIds: readonly string[];
  readonly bindingLeases: readonly Readonly<{ bindingId: string; leaseCount: number }>[];
  readonly upstream: string | null;
}
interface ActiveProvider extends ManagedWebAppProviderDefinition { active: boolean }
interface InstanceRecord {
  readonly provider: ActiveProvider;
  readonly key: string;
  readonly selection: ManagedWebAppSelection;
  readonly acquisition: Promise<ConnectPluginManagedWebAppInstance>;
  instance?: ConnectPluginManagedWebAppInstance;
  upstream?: string;
  health: ManagedWebAppHealth;
  readonly healthListeners: Set<(health: ManagedWebAppHealth) => void>;
  readonly leases: Map<symbol, string>;
  readonly bindings: Set<string>;
  diagnostic: string | null;
  disposeHealth?: ConnectPluginDisposer;
  disposeExit?: ConnectPluginDisposer;
  stopping?: Promise<void>;
}

/** Core-owned selection and lifecycle boundary for Provider-owned Web servers. */
export class ManagedWebAppRegistry {
  private readonly providers = new Map<string, ActiveProvider>();
  private readonly instances = new Map<string, InstanceRecord>();

  activate(definition: ManagedWebAppProviderDefinition): void {
    validateDefinition(definition);
    const key = providerIdentity(definition.pluginId, definition.manifest.id);
    const current = this.providers.get(key);
    if (current?.active) throw new Error(`Managed Web App Provider ${definition.pluginId}/${definition.manifest.id} is already active`);
    this.providers.set(key, { ...definition, active: true });
  }

  fence(reference: ManagedWebAppGenerationReference): void {
    for (const provider of this.providers.values()) {
      if (sameGeneration(provider, reference)) provider.active = false;
    }
  }

  restore(reference: ManagedWebAppGenerationReference): void {
    for (const provider of this.providers.values()) {
      if (sameGeneration(provider, reference)) provider.active = true;
    }
  }

  async remove(reference: ManagedWebAppGenerationReference): Promise<void> {
    const retained = [...this.instances.values()].filter(
      (record) => sameGeneration(record.provider, reference) && record.leases.size > 0,
    );
    if (retained.length > 0) {
      throw new Error(
        `Managed Web App generation ${reference.pluginId}/${reference.capabilityId}@${reference.activationGeneration} still owns active leases`,
      );
    }
    await Promise.all(
      [...this.instances].map(async ([key, record]) => {
        if (!sameGeneration(record.provider, reference)) return;
        await this.stop(record);
        if (this.instances.get(key) === record) this.instances.delete(key);
      }),
    );
    const key = providerIdentity(reference.pluginId, reference.capabilityId);
    const provider = this.providers.get(key);
    if (provider && sameGeneration(provider, reference)) this.providers.delete(key);
  }

  select(runtime: RuntimeCapabilityRef): ManagedWebAppSelection | null {
    return selectManagedWebApp(
      runtime,
      [...this.providers.values()]
        .filter((provider) => provider.active)
        .map((provider) => ({
          pluginId: provider.pluginId,
          capabilityId: provider.manifest.id,
          activationGeneration: provider.activationGeneration,
          manifest: provider.manifest,
        })),
    );
  }
  async acquire(
    request: ManagedWebAppBindingRequest,
    requested?: RuntimeCapabilityRef,
  ): Promise<ManagedWebAppLease | null> {
    const selection = requested
      ? selectManagedWebApp(
          request.runtime,
          [...this.providers.values()]
            .filter(
              (provider) =>
                provider.active &&
                provider.pluginId === requested.pluginId &&
                provider.manifest.id === requested.capabilityId,
            )
            .map((provider) => ({
              pluginId: provider.pluginId,
              capabilityId: provider.manifest.id,
              activationGeneration: provider.activationGeneration,
              manifest: provider.manifest,
            })),
        )
      : this.select(request.runtime);
    if (!selection) return null;
    const provider = this.requireProvider(selection);
    const context = immutableContext(provider, request);
    const instanceKey = requireInstanceKey(await provider.provider.instanceKey(context));
    const key = instanceIdentity(provider, instanceKey);
    let record = this.instances.get(key);
    if (record?.health === "error" && record.leases.size === 0) {
      await this.stop(record);
      if (this.instances.get(key) === record) this.instances.delete(key);
      record = undefined;
    }
    if (!record) {
      record = this.beginAcquisition(provider, selection, context, instanceKey);
      this.instances.set(key, record);
    }
    record.bindings.add(request.bindingId);
    this.assertProviderAuthority(provider);
    const instance = await record.acquisition;
    let upstream: string;
    try {
      this.assertProviderAuthority(provider);
      upstream = validateUpstream(instance.upstream, record.upstream);
      if (record.health === "error" || record.health === "stopped") {
        throw new Error(
          `Managed Web App ${provider.pluginId}/${provider.manifest.id} instance ${instanceKey} is ${record.health}`,
        );
      }
    } catch (error) {
      return await this.failRecord(record, error);
    }
    const token = Symbol(`${request.bindingId}:${instanceKey}`);
    record.leases.set(token, request.bindingId);
    return this.createLease(record, token, selection, instanceKey, upstream);
  }

  snapshots(): ManagedWebAppRegistrySnapshot[] {
    return [...this.instances.values()].map((record) => ({
      selection: record.selection,
      instanceKey: record.key,
      health: record.health,
      diagnostic: record.diagnostic,
      leaseCount: record.leases.size,
      upstream: record.upstream ?? null,
      bindingIds: Object.freeze([...record.bindings].sort()),
      bindingLeases: bindingLeaseSnapshots(record.leases),
    }));
  }

  async close(): Promise<void> {
    for (const provider of this.providers.values()) provider.active = false;
    const records = [...this.instances];
    const results = await Promise.allSettled(
      records.map(async ([, record]) => await this.stop(record)),
    );
    const failures: unknown[] = [];
    for (const [index, result] of results.entries()) {
      const current = records[index];
      if (!current) continue;
      const [key, record] = current;
      if (result.status === "fulfilled") {
        if (this.instances.get(key) === record) this.instances.delete(key);
      } else {
        failures.push(result.reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Managed Web App Registry could not stop every Instance");
    }
    this.providers.clear();
  }

  private beginAcquisition(
    provider: ActiveProvider,
    selection: ManagedWebAppSelection,
    context: ConnectPluginManagedWebAppInstanceContext,
    instanceKey: string,
  ): InstanceRecord {
    let record!: InstanceRecord;
    const acquisition = Promise.resolve().then(async () => await provider.provider.acquire(Object.freeze({ ...context, instanceKey }))).then(async (instance) => {
      record.instance = instance;
      validateInstance(instance, provider, instanceKey);
      record.upstream = validateUpstream(instance.upstream);
      record.health = instance.health();
      record.disposeHealth = instance.onHealthChange((health) => this.updateHealth(record, health));
      record.disposeExit = instance.onExit((error) => this.updateHealth(record, error ? "error" : "stopped"));
      await instance.waitUntilReady();
      record.upstream = validateUpstream(instance.upstream, record.upstream);
      const health = instance.health();
      this.updateHealth(record, health);
      if (health !== "ready") throw new Error(`Managed Web App ${provider.pluginId}/${provider.manifest.id} instance ${instanceKey} reported ${health} after readiness`);
      record.diagnostic = null;
      return instance;
    }).catch(async (error) => await this.failRecord(record, error));
    record = {
      provider,
      selection,
      key: instanceKey,
      acquisition,
      health: "starting",
      healthListeners: new Set(),
      bindings: new Set(),
      diagnostic: null,
      leases: new Map(),
    };
    return record;
  }

  private createLease(record: InstanceRecord, token: symbol, selection: ManagedWebAppSelection, instanceKey: string, upstream: string): ManagedWebAppLease {
    let released = false;
    return Object.freeze({
      selection, instanceKey, upstream,
      health: () => { this.assertLease(record, token, released); return record.health },
      onHealthChange: (listener: (health: ManagedWebAppHealth) => void) => {
        this.assertLease(record, token, released);
        record.healthListeners.add(listener);
        return () => {
          record.healthListeners.delete(listener);
        };
      },
      release: async () => {
        if (released) return;
        this.assertLeaseOwnership(record, token, false);
        const bindingId = record.leases.get(token);
        if (record.leases.size > 1) {
          released = true;
          record.leases.delete(token);
          if (bindingId && ![...record.leases.values()].includes(bindingId)) {
            record.bindings.delete(bindingId);
          }
          return;
        }
        await this.stop(record);
        released = true;
        record.leases.delete(token);
        if (bindingId) record.bindings.delete(bindingId);
        const key = instanceIdentity(record.provider, record.key);
        if (this.instances.get(key) === record) this.instances.delete(key);
      },
    });
  }

  private assertLease(record: InstanceRecord, token: symbol, released: boolean): void {
    this.assertProviderAuthority(record.provider);
    this.assertLeaseOwnership(record, token, released);
  }
  private assertLeaseOwnership(record: InstanceRecord, token: symbol, released: boolean): void {
    if (released) throw new Error("Managed Web App lease is already released");
    if (!record.leases.has(token)) throw new Error("Managed Web App lease is unowned or stale");
    validateUpstream(record.instance?.upstream ?? "", record.upstream);
  }
  private assertProviderAuthority(provider: ActiveProvider): void {
    const current = this.providers.get(providerIdentity(provider.pluginId, provider.manifest.id));
    if (current !== provider || !provider.active || current.activationGeneration !== provider.activationGeneration) throw new Error(`Managed Web App ${provider.pluginId}/${provider.manifest.id} rejected stale Activation Generation ${provider.activationGeneration}`);
  }
  private requireProvider(selection: ManagedWebAppSelection): ActiveProvider {
    const provider = this.providers.get(providerIdentity(selection.pluginId, selection.capabilityId));
    if (!provider || provider.activationGeneration !== selection.activationGeneration) throw new Error(`Managed Web App ${selection.pluginId}/${selection.capabilityId} rejected stale Activation Generation ${selection.activationGeneration}`);
    return provider;
  }
  private updateHealth(record: InstanceRecord, health: ManagedWebAppHealth): void {
    if (record.health === health) return;
    record.health = health;
    for (const listener of record.healthListeners) listener(health);
  }
  private async failRecord(record: InstanceRecord, error: unknown): Promise<never> {
    await record.disposeHealth?.();
    await record.disposeExit?.();
    record.disposeHealth = undefined;
    record.disposeExit = undefined;
    let cleanupError: unknown;
    if (record.leases.size === 0 && record.instance) {
      try {
        await record.instance.release();
        record.instance = undefined;
        record.upstream = undefined;
      } catch (reason) {
        cleanupError = reason;
      }
    }
    record.diagnostic = cleanupError
      ? `${safeDiagnostic(error)}; cleanup pending: ${safeDiagnostic(cleanupError)}`
      : safeDiagnostic(error);
    this.updateHealth(record, "error");
    throw error;
  }

  private async stop(record: InstanceRecord): Promise<void> {
    if (record.stopping) return await record.stopping;
    const stopping = Promise.resolve().then(async () => {
      await record.disposeHealth?.();
      await record.disposeExit?.();
      const instance = record.instance ?? (await record.acquisition.catch(() => undefined));
      if (instance) await instance.release();
      record.healthListeners.clear();
      record.health = "stopped";
    });
    record.stopping = stopping;
    try {
      await stopping;
    } catch (error) {
      if (record.stopping === stopping) record.stopping = undefined;
      throw error;
    }
  }
}

function immutableContext(provider: ActiveProvider, request: ManagedWebAppBindingRequest): ConnectPluginManagedWebAppInstanceContext {
  return deepFreeze({ activationGeneration: provider.activationGeneration, pluginId: provider.pluginId, capabilityId: provider.manifest.id, bindingId: request.bindingId, runtime: structuredClone(request.runtime), installationConfiguration: structuredClone(provider.installationConfiguration), configuration: structuredClone(provider.configuration), runtimeConfiguration: structuredClone(request.runtimeConfiguration) });
}
function validateDefinition(definition: ManagedWebAppProviderDefinition): void {
  if (!Number.isSafeInteger(definition.activationGeneration) || definition.activationGeneration < 1) throw new Error("Managed Web App Activation Generation must be a positive safe integer");
  if (definition.provider.capabilityId !== definition.manifest.id) throw new Error(`Managed Web App Provider ${definition.pluginId}/${definition.provider.capabilityId} does not match manifest capability ${definition.manifest.id}`);
}
function validateInstance(instance: ConnectPluginManagedWebAppInstance, provider: ActiveProvider, instanceKey: string): void {
  if (!instance || typeof instance !== "object" || typeof instance.waitUntilReady !== "function" || typeof instance.health !== "function" || typeof instance.onHealthChange !== "function" || typeof instance.onExit !== "function" || typeof instance.release !== "function") throw new Error(`Managed Web App ${provider.pluginId}/${provider.manifest.id} instance ${instanceKey} is malformed`);
  validateUpstream(instance.upstream);
}
function validateUpstream(upstream: string, expected?: string): string {
  let url: URL;
  try { url = new URL(upstream) } catch (error) { throw new Error("Managed Web App upstream must be a valid loopback HTTP origin", { cause: error }) }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== upstream) throw new Error("Managed Web App upstream must be an opaque 127.0.0.1 HTTP origin");
  if (expected !== undefined && upstream !== expected) throw new Error("Managed Web App upstream changed during an active instance lease");
  return upstream;
}
function requireInstanceKey(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.includes("\0")) throw new Error("Managed Web App Provider instance key must be a non-empty exact string");
  return value;
}
function providerIdentity(pluginId: string, capabilityId: string): string { return `${pluginId}\0${capabilityId}` }
function instanceIdentity(provider: ActiveProvider, instanceKey: string): string { return `${provider.pluginId}\0${provider.manifest.id}\0${provider.activationGeneration}\0${instanceKey}` }
function selectionFor(
  candidate: ManagedWebAppSelectionCandidate,
  kind: "native" | "compatible",
): ManagedWebAppSelection {
  return Object.freeze({
    pluginId: candidate.pluginId,
    capabilityId: candidate.capabilityId,
    activationGeneration: candidate.activationGeneration,
    kind,
    displayName: candidate.manifest.displayName,
    description: candidate.manifest.description,
  });
}

export function selectManagedWebApp(
  runtime: RuntimeCapabilityRef,
  candidates: readonly ManagedWebAppSelectionCandidate[],
): ManagedWebAppSelection | null {
  const native = candidates.filter(
    (candidate) =>
      candidate.pluginId === runtime.pluginId &&
      candidate.manifest.nativeRuntimeCapabilityIds.includes(runtime.capabilityId),
  );
  if (native.length > 1) throw ambiguousSelection(runtime, "native", native);
  if (native[0]) return selectionFor(native[0], "native");
  const compatible = candidates.filter((candidate) =>
    candidate.manifest.compatibleRuntimes.some(
      (reference) =>
        reference.pluginId === runtime.pluginId && reference.capabilityId === runtime.capabilityId,
    ),
  );
  if (compatible.length > 1) throw ambiguousSelection(runtime, "compatible", compatible);
  return compatible[0] ? selectionFor(compatible[0], "compatible") : null;
}

function ambiguousSelection(
  runtime: RuntimeCapabilityRef,
  kind: "native" | "compatible",
  candidates: readonly ManagedWebAppSelectionCandidate[],
): Error {
  return new Error(
    `Runtime ${runtime.pluginId}/${runtime.capabilityId} has ambiguous ${kind} Managed Web Apps: ${candidates
      .map(
        (candidate) =>
          `${candidate.pluginId}/${candidate.capabilityId}@${candidate.activationGeneration}`,
      )
      .sort()
      .join(", ")}`,
  );
}

function sameGeneration(
  candidate: ManagedWebAppGenerationReference | ManagedWebAppProviderDefinition,
  reference: ManagedWebAppGenerationReference,
): boolean {
  const capabilityId =
    "capabilityId" in candidate ? candidate.capabilityId : candidate.manifest.id;
  return (
    candidate.pluginId === reference.pluginId &&
    capabilityId === reference.capabilityId &&
    candidate.activationGeneration === reference.activationGeneration
  );
}
function bindingLeaseSnapshots(
  leases: ReadonlyMap<symbol, string>,
): readonly Readonly<{ bindingId: string; leaseCount: number }>[] {
  const counts = new Map<string, number>();
  for (const bindingId of leases.values()) counts.set(bindingId, (counts.get(bindingId) ?? 0) + 1);
  return Object.freeze(
    [...counts].map(([bindingId, leaseCount]) => Object.freeze({ bindingId, leaseCount })).sort(
      (left, right) => left.bindingId.localeCompare(right.bindingId),
    ),
  );
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(authorization|credential|password|secret|token|api[-_ ]?key)\s*[:=]\s*\S+/giu,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gu, "http://[redacted]@")
    .slice(0, 512);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}
