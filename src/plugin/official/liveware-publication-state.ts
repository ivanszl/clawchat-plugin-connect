import type { ConnectStateStore, PluginDurableStateNamespace } from "../../persistence/state";
import type { ConnectDurableStateHostCapability, ConnectPluginDurableState } from "../sdk";
import {
  LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION,
  OFFICIAL_LIVEWARE_CAPABILITY_ID,
  OFFICIAL_LIVEWARE_PLUGIN_ID,
} from "./liveware-manifest";
import type {
  BindingLivewarePublicationState,
  BindingLivewarePublicationStateRecord,
  BindingLivewarePublicationStateStore,
  BindingLivewarePublicationStatus,
  BindingLivewarePublicationTransition,
} from "./liveware-publication";

const PUBLICATION_STATUSES = new Set<BindingLivewarePublicationStatus>([
  "absent",
  "provisioning",
  "active",
  "degraded",
  "retiring",
  "retired",
]);
const PUBLICATION_TRANSITIONS = new Set<BindingLivewarePublicationTransition>([
  null,
  "create-app",
  "bind-tunnel",
  "register-launcher",
  "unregister-launcher",
  "delete-app",
]);

export class ConnectBindingLivewarePublicationStateStore implements BindingLivewarePublicationStateStore {
  constructor(
    private readonly state: ConnectStateStore,
    private readonly assertGeneration: () => Promise<void> = async () => undefined,
    private readonly activationGeneration?: number,
    private readonly runOperation: <T>(operation: () => Promise<T>) => Promise<T> = async (operation) =>
      await operation(),
  ) {}

  async read(bindingId: string): Promise<BindingLivewarePublicationStateRecord | null> {
    return await this.runOperation(async () => {
      await this.assertGeneration();
      const generation = this.activationGeneration ?? (await this.latestGeneration(bindingId));
      if (generation === null) return null;
      return await this.readGeneration(bindingId, generation);
    });
  }

  async compareAndSwap(
    bindingId: string,
    expectedRevision: number | null,
    value: BindingLivewarePublicationState,
  ): Promise<BindingLivewarePublicationStateRecord> {
    return await this.runOperation(async () => {
      await this.assertGeneration();
      const validated = publicationState(value, bindingId);
      const generation =
        this.activationGeneration ?? (await this.latestGeneration(bindingId)) ?? validated.activationGeneration;
      const current = await this.readGeneration(bindingId, generation);
      if (current && current.value.activationGeneration > validated.activationGeneration) {
        throw new Error(`stale Liveware publication Activation Generation for ${bindingId}`);
      }
      const record = await this.state.compareAndSwapPluginDurableState(
        publicationNamespace(bindingId, generation),
        expectedRevision,
        LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION,
        validated,
      );
      return {
        revision: record.revision,
        value: publicationState(record.value, bindingId),
      };
    });
  }

  private async readGeneration(
    bindingId: string,
    activationGeneration: number,
  ): Promise<BindingLivewarePublicationStateRecord | null> {
    const record = await this.state.readPluginDurableState(publicationNamespace(bindingId, activationGeneration));
    if (!record) return null;
    if (record.schemaVersion !== LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION) {
      const reset = await this.state.compareAndSwapPluginDurableState(
        publicationNamespace(bindingId, activationGeneration),
        record.revision,
        LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION,
        resetBindingLivewarePublicationState(bindingId, activationGeneration),
      );
      return {
        revision: reset.revision,
        value: publicationState(reset.value, bindingId),
      };
    }
    return {
      revision: record.revision,
      value: publicationState(record.value, bindingId),
    };
  }

  private async latestGeneration(bindingId: string): Promise<number | null> {
    const scope = requiredText(bindingId, "Agent Binding identity");
    const snapshots = await this.state.listPluginDurableState(OFFICIAL_LIVEWARE_PLUGIN_ID);
    let latest: number | null = null;
    for (const snapshot of snapshots) {
      const namespace = snapshot.namespace;
      if (
        namespace.capabilityId === OFFICIAL_LIVEWARE_CAPABILITY_ID &&
        namespace.instanceId === scope &&
        namespace.lifetime === "binding" &&
        namespace.scopeKey === scope &&
        (latest === null || namespace.activationGeneration > latest)
      ) {
        latest = namespace.activationGeneration;
      }
    }
    return latest;
  }
}

export class DeclaredBindingLivewarePublicationStateStore implements BindingLivewarePublicationStateStore {
  private readonly states = new Map<string, ConnectPluginDurableState>();

  constructor(
    private readonly durableState: ConnectDurableStateHostCapability,
    private readonly capabilityId: string,
    private readonly activationGeneration: number,
  ) {}

  async read(bindingId: string): Promise<BindingLivewarePublicationStateRecord | null> {
    const record = await this.stateFor(bindingId).read();
    if (!record) return null;
    if (record.schemaVersion !== LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION) {
      const reset = await this.stateFor(bindingId).compareAndSwap(
        record.revision,
        resetBindingLivewarePublicationState(bindingId, this.activationGeneration),
      );
      return {
        revision: reset.revision,
        value: publicationState(reset.value, bindingId),
      };
    }
    return {
      revision: record.revision,
      value: publicationState(record.value, bindingId),
    };
  }

  async compareAndSwap(
    bindingId: string,
    expectedRevision: number | null,
    value: BindingLivewarePublicationState,
  ): Promise<BindingLivewarePublicationStateRecord> {
    const record = await this.stateFor(bindingId).compareAndSwap(expectedRevision, publicationState(value, bindingId));
    return {
      revision: record.revision,
      value: publicationState(record.value, bindingId),
    };
  }

  private stateFor(bindingId: string): ConnectPluginDurableState {
    const cached = this.states.get(bindingId);
    if (cached) return cached;
    const state = this.durableState.forBinding(this.capabilityId, bindingId);
    this.states.set(bindingId, state);
    return state;
  }
}

function publicationNamespace(bindingId: string, activationGeneration: number): PluginDurableStateNamespace {
  const scope = requiredText(bindingId, "Agent Binding identity");
  return {
    pluginId: OFFICIAL_LIVEWARE_PLUGIN_ID,
    activationGeneration,
    capabilityId: OFFICIAL_LIVEWARE_CAPABILITY_ID,
    instanceId: scope,
    lifetime: "binding",
    scopeKey: scope,
  };
}

function publicationState(value: unknown, bindingId: string): BindingLivewarePublicationState {
  if (!isRecord(value)) throw new Error(`Binding Liveware Publication ${bindingId} state must be a JSON object`);
  const status = value.status;
  const transition = value.transition;
  const desired = value.desired;
  const activationGeneration = value.activationGeneration;
  if (!PUBLICATION_STATUSES.has(status as BindingLivewarePublicationStatus)) {
    throw new Error(`Binding Liveware Publication ${bindingId} state has an unsupported status`);
  }
  if (!PUBLICATION_TRANSITIONS.has(transition as BindingLivewarePublicationTransition)) {
    throw new Error(`Binding Liveware Publication ${bindingId} state has an unsupported transition`);
  }
  if (desired !== "private" && desired !== "retired") {
    throw new Error(`Binding Liveware Publication ${bindingId} state has an unsupported desired policy`);
  }
  if (!Number.isSafeInteger(activationGeneration) || Number(activationGeneration) < 1) {
    throw new Error(`Binding Liveware Publication ${bindingId} state has an invalid Activation Generation`);
  }
  const storedBindingId = requiredText(value.bindingId, "stored Agent Binding identity");
  if (storedBindingId !== bindingId) {
    throw new Error(`Binding Liveware Publication state for ${bindingId} names ${storedBindingId}`);
  }
  return {
    bindingId: storedBindingId,
    activationGeneration: Number(activationGeneration),
    desired,
    status: status as BindingLivewarePublicationStatus,
    transition: transition as BindingLivewarePublicationTransition,
    selectedApp: selectedAppState(value.selectedApp, bindingId),
    correlationKey: requiredText(value.correlationKey, "publication correlation key"),
    appId: optionalText(value.appId, "Liveware App identity"),
    publicUrl: optionalText(value.publicUrl, "Liveware public URL"),
    registrationId: optionalText(value.registrationId, "ClawChat Liveware Registration identity"),
    diagnostic: optionalText(value.diagnostic, "publication diagnostic"),
  };
}

export function validateBindingLivewarePublicationState(
  value: unknown,
  bindingId: string,
): BindingLivewarePublicationState {
  return publicationState(value, bindingId);
}
export function resetBindingLivewarePublicationState(
  bindingId: string,
  activationGeneration: number,
): BindingLivewarePublicationState {
  const exactBindingId = requiredText(bindingId, "Agent Binding identity");
  if (!Number.isSafeInteger(activationGeneration) || activationGeneration < 1) {
    throw new Error(`Binding Liveware Publication ${bindingId} state has an invalid Activation Generation`);
  }
  return {
    bindingId: exactBindingId,
    activationGeneration,
    desired: "private",
    status: "absent",
    transition: null,
    selectedApp: null,
    correlationKey: `ClawChat Connect · ${exactBindingId}`,
    appId: null,
    publicUrl: null,
    registrationId: null,
    diagnostic: null,
  };
}

function selectedAppState(value: unknown, bindingId: string): BindingLivewarePublicationState["selectedApp"] {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error(`Binding Liveware Publication ${bindingId} state has no exact selected Managed Web App`);
  }
  const allowed: Readonly<Record<string, true>> = {
    pluginId: true,
    capabilityId: true,
    activationGeneration: true,
    instanceKey: true,
    displayName: true,
    description: true,
  };
  if (Object.keys(value).some((key) => !Object.hasOwn(allowed, key))) {
    throw new Error(`Binding Liveware Publication ${bindingId} selected Managed Web App state is obsolete`);
  }
  const generation = value.activationGeneration;
  if (!Number.isSafeInteger(generation) || Number(generation) < 1) {
    throw new Error(`Binding Liveware Publication ${bindingId} selected Managed Web App generation is invalid`);
  }
  return {
    pluginId: requiredText(value.pluginId, "selected Managed Web App Plugin identity"),
    capabilityId: requiredText(value.capabilityId, "selected Managed Web App capability identity"),
    activationGeneration: Number(generation),
    instanceKey: requiredText(value.instanceKey, "selected Managed Web App Instance identity"),
    displayName: requiredText(value.displayName, "selected Managed Web App display name"),
    description: requiredText(value.description, "selected Managed Web App description"),
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be non-empty and exact`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredText(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
