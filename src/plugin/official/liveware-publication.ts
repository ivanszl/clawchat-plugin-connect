import type { ManagedWebAppGenerationReference } from "../sdk";

export const LIVEWARE_PUBLICATION_APP_PREFIX = "ClawChat Connect · ";
export const LIVEWARE_PUBLICATION_SUBTITLE = "Connect Web";

export type BindingLivewarePublicationStatus =
  | "absent"
  | "provisioning"
  | "active"
  | "degraded"
  | "retiring"
  | "retired";

export type BindingLivewarePublicationTransition =
  | "create-app"
  | "bind-tunnel"
  | "register-launcher"
  | "unregister-launcher"
  | "delete-app"
  | null;

export interface SelectedManagedWebAppState extends ManagedWebAppGenerationReference {
  readonly instanceKey: string;
  readonly displayName: string;
  readonly description: string;
}

export interface BindingLivewarePublicationState extends Readonly<Record<string, unknown>> {
  readonly bindingId: string;
  readonly activationGeneration: number;
  readonly desired: "private" | "retired";
  readonly status: BindingLivewarePublicationStatus;
  readonly transition: BindingLivewarePublicationTransition;
  readonly selectedApp: SelectedManagedWebAppState | null;
  readonly correlationKey: string;
  readonly appId: string | null;
  readonly publicUrl: string | null;
  readonly registrationId: string | null;
  readonly diagnostic: string | null;
}

export interface BindingLivewarePublicationStateRecord {
  readonly revision: number;
  readonly value: BindingLivewarePublicationState;
}

export interface BindingLivewarePublicationStateStore {
  read(bindingId: string): Promise<BindingLivewarePublicationStateRecord | null>;
  compareAndSwap(
    bindingId: string,
    expectedRevision: number | null,
    value: BindingLivewarePublicationState,
  ): Promise<BindingLivewarePublicationStateRecord>;
}

export interface LivewarePublicationApp {
  readonly appId: string;
  readonly name: string;
  publicUrl: string | null;
}

export interface LivewarePublicationAgent {
  readonly ready: Promise<void>;
  readonly exited: Promise<unknown>;
  stop(): Promise<void>;
}

export interface LivewarePublicationControlSession {
  listApps(): Promise<LivewarePublicationApp[]>;
  inspectApp(appId: string): Promise<LivewarePublicationApp>;
  createApp(correlationKey: string, accessPolicy: "private"): Promise<LivewarePublicationApp>;
  bindTunnel(appId: string, upstream: string): Promise<string>;
  startAgent(): Promise<LivewarePublicationAgent>;
  deleteApp(appId: string): Promise<void>;
}

export interface LivewarePublicationControlPlane {
  connect(bindingId: string): Promise<LivewarePublicationControlSession>;
}

export interface LivewarePublicationRegistration {
  readonly livewareId: string;
  readonly name: string;
  readonly subtitle: string;
  readonly url: string;
}

export interface LivewarePublicationRegistrationPort {
  list(bindingId: string, deviceId: string): Promise<LivewarePublicationRegistration[]>;
  register(bindingId: string, deviceId: string, registration: LivewarePublicationRegistration): Promise<void>;
  unregister(bindingId: string, deviceId: string, livewareId: string): Promise<void>;
}

export interface BindingLivewarePublicationLifecycleOptions {
  readonly activationGeneration: number;
  readonly upstream?: string;
  readonly selectedApp?: SelectedManagedWebAppState;
  readonly state: BindingLivewarePublicationStateStore;
  readonly controlPlane: LivewarePublicationControlPlane;
  readonly registrations: LivewarePublicationRegistrationPort;
}

export interface BindingLivewarePublicationTarget {
  readonly bindingId: string;
  readonly deviceId: string;
}

export class BindingLivewarePublicationLifecycle {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly reconciled = new Set<string>();
  private readonly agents = new Map<string, LivewarePublicationAgent>();
  private accepting = true;

  constructor(private readonly options: BindingLivewarePublicationLifecycleOptions) {
    if (!Number.isSafeInteger(options.activationGeneration) || options.activationGeneration < 1) {
      throw new Error("Liveware publication Activation Generation must be a positive safe integer");
    }
    if (options.upstream !== undefined) {
      const upstream = new URL(options.upstream);
      if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || !upstream.port) {
        throw new Error("Liveware publication upstream must be an opaque loopback HTTP endpoint");
      }
    }
  }

  async ensurePrivate(target: BindingLivewarePublicationTarget): Promise<BindingLivewarePublicationState> {
    return await this.serialize(target.bindingId, async () => await this.provision(target));
  }

  async retire(target: BindingLivewarePublicationTarget): Promise<BindingLivewarePublicationState> {
    return await this.serialize(target.bindingId, async () => await this.retirePublication(target));
  }

  async dispose(): Promise<void> {
    this.accepting = false;
    await this.stopAgents();
    await Promise.allSettled(this.operations.values());
  }

  private async retirePublication(target: BindingLivewarePublicationTarget): Promise<BindingLivewarePublicationState> {
    let record = await this.currentRecord(target.bindingId);
    if (record.value.status === "retired") {
      await this.releaseAgent(target.bindingId);
      return record.value;
    }
    record = await this.commit(record, {
      ...record.value,
      desired: "retired",
      status: "retiring",
      transition: "unregister-launcher",
      diagnostic: null,
    });
    try {
      let control: LivewarePublicationControlSession | undefined;
      if (!record.value.appId) {
        await this.assertAuthority(target.bindingId);
        control = await this.options.controlPlane.connect(target.bindingId);
        await this.assertAuthority(target.bindingId);
        const matches = (await control.listApps()).filter(
          (candidate) => candidate.name === record.value.correlationKey,
        );
        if (matches.length > 1) {
          throw new Error("multiple owned Apps match the publication correlation key during retirement");
        }
        const recovered = matches[0];
        if (recovered) {
          record = await this.commit(record, {
            ...record.value,
            appId: recovered.appId,
            publicUrl: recovered.publicUrl,
          });
        }
      }
      if (record.value.appId) {
        await this.assertAuthority(target.bindingId);
        const registrations = await this.options.registrations.list(target.bindingId, target.deviceId);
        if (registrations.some((candidate) => candidate.livewareId === record.value.appId)) {
          await this.assertAuthority(target.bindingId);
          await this.options.registrations.unregister(target.bindingId, target.deviceId, record.value.appId);
        }
      }
      record = await this.commit(record, {
        ...record.value,
        transition: "delete-app",
      });
      if (record.value.appId) {
        await this.assertAuthority(target.bindingId);
        control ??= await this.options.controlPlane.connect(target.bindingId);
        await this.assertAuthority(target.bindingId);
        const apps = await control.listApps();
        if (apps.some((candidate) => candidate.appId === record.value.appId)) {
          await this.assertAuthority(target.bindingId);
          await control.deleteApp(record.value.appId);
        }
        await this.assertAuthority(target.bindingId);
        const remaining = await control.listApps();
        if (remaining.some((candidate) => candidate.appId === record.value.appId)) {
          throw new Error(`Liveware App ${record.value.appId} remains after deletion`);
        }
      }
      await this.releaseAgent(target.bindingId);
      record = await this.commit(record, {
        ...record.value,
        status: "retired",
        transition: null,
        diagnostic: null,
      });
      this.reconciled.delete(target.bindingId);
      return record.value;
    } catch (error) {
      await this.commit(record, {
        ...record.value,
        status: "retiring",
        diagnostic: errorMessage(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  private async provision(target: BindingLivewarePublicationTarget): Promise<BindingLivewarePublicationState> {
    let record = await this.currentRecord(target.bindingId);
    if (record.value.status === "retiring" || record.value.desired === "retired") {
      throw new Error(`Binding Liveware Publication ${target.bindingId} is retiring and cannot be reprovisioned`);
    }
    if (!this.options.upstream || !this.options.selectedApp) {
      throw new Error(`Binding Liveware Publication ${target.bindingId} has no selected Managed Web App lease`);
    }
    if (record.value.status === "active" && this.reconciled.has(target.bindingId)) return record.value;
    const rebind = record.value.status === "active";
    const tunnelMayHaveBeenBound = record.value.appId !== null && record.value.publicUrl === null;

    record = await this.commit(record, {
      ...record.value,
      selectedApp: this.options.selectedApp,
      desired: "private",
      status: "provisioning",
      transition: "create-app",
      diagnostic: null,
    });
    let control: LivewarePublicationControlSession;
    try {
      await this.assertAuthority(target.bindingId);
      control = await this.options.controlPlane.connect(target.bindingId);
    } catch (error) {
      await this.degrade(record, `Liveware Control Plane connection failed: ${errorMessage(error)}`);
      throw error;
    }

    let apps: LivewarePublicationApp[];
    try {
      await this.assertAuthority(target.bindingId);
      apps = await control.listApps();
      await this.assertAuthority(target.bindingId);
    } catch (error) {
      await this.assertAuthority(target.bindingId);
      return (await this.degrade(record, `App correlation-key lookup failed: ${errorMessage(error)}`)).value;
    }
    const matches = apps.filter((app) => app.name === record.value.correlationKey);
    if (matches.length > 1)
      return (await this.degrade(record, "multiple owned Apps match the publication correlation key")).value;
    let app = matches[0];
    if (!app) {
      try {
        await this.assertAuthority(target.bindingId);
        app = await control.createApp(record.value.correlationKey, "private");
      } catch (error) {
        await this.degrade(record, `App creation failed: ${errorMessage(error)}`);
        throw error;
      }
    }
    record = await this.commit(record, {
      ...record.value,
      appId: app.appId,
      publicUrl: app.publicUrl,
      transition: "bind-tunnel",
    });

    let inspected: LivewarePublicationApp;
    try {
      await this.assertAuthority(target.bindingId);
      inspected = await control.inspectApp(app.appId);
    } catch (error) {
      await this.degrade(record, `App inspection failed: ${errorMessage(error)}`);
      throw error;
    }
    let publicUrl = inspected.publicUrl;
    if (rebind || !tunnelMayHaveBeenBound || !publicUrl) {
      try {
        await this.assertAuthority(target.bindingId);
        publicUrl = await control.bindTunnel(app.appId, this.options.upstream);
      } catch (error) {
        await this.degrade(record, `Tunnel binding failed: ${errorMessage(error)}`);
        throw error;
      }
    }
    try {
      await this.ensureAgent(target.bindingId, control);
    } catch (error) {
      await this.degrade(record, `Liveware agent startup failed: ${errorMessage(error)}`);
      throw error;
    }
    record = await this.commit(record, {
      ...record.value,
      publicUrl,
      transition: "register-launcher",
    });

    const registration: LivewarePublicationRegistration = {
      livewareId: app.appId,
      name: `${this.options.selectedApp.displayName} · ${target.bindingId}`,
      subtitle: this.options.selectedApp.description,
      url: publicUrl,
    };
    let registrations: LivewarePublicationRegistration[];
    try {
      await this.assertAuthority(target.bindingId);
      registrations = (await this.options.registrations.list(target.bindingId, target.deviceId)).filter(
        (candidate) => candidate.livewareId === app.appId,
      );
    } catch (error) {
      await this.degrade(record, `ClawChat launcher lookup failed: ${errorMessage(error)}`);
      throw error;
    }
    if (registrations.length > 1) {
      return (await this.degrade(record, "multiple ClawChat launchers match the publication App")).value;
    }
    const currentRegistration = registrations[0];
    if (!currentRegistration || !sameRegistration(currentRegistration, registration)) {
      try {
        await this.assertAuthority(target.bindingId);
        await this.options.registrations.register(target.bindingId, target.deviceId, registration);
      } catch (error) {
        await this.degrade(record, `ClawChat launcher registration failed: ${errorMessage(error)}`);
        throw error;
      }
    }
    record = await this.commit(record, {
      ...record.value,
      status: "active",
      transition: null,
      registrationId: app.appId,
      diagnostic: null,
    });
    if (this.agents.has(target.bindingId)) this.reconciled.add(target.bindingId);
    return record.value;
  }

  private async currentRecord(bindingId: string): Promise<BindingLivewarePublicationStateRecord> {
    const existing = await this.options.state.read(bindingId);
    if (existing) {
      if (existing.value.activationGeneration > this.options.activationGeneration) {
        throw new Error(`stale Liveware publication Activation Generation for ${bindingId}`);
      }
      if (existing.value.activationGeneration === this.options.activationGeneration) {
        if (
          this.options.selectedApp &&
          existing.value.status === "absent" &&
          existing.value.appId === null
        ) {
          return await this.options.state.compareAndSwap(bindingId, existing.revision, {
            ...existing.value,
            selectedApp: this.options.selectedApp,
            correlationKey: `${this.options.selectedApp.displayName} · ${bindingId}`,
          });
        }
        return existing;
      }
      const reactivate = existing.value.status === "retired" && existing.value.desired === "retired";
      return await this.options.state.compareAndSwap(bindingId, existing.revision, {
        ...existing.value,
        activationGeneration: this.options.activationGeneration,
        ...(reactivate
          ? { desired: "private" as const, status: "provisioning" as const, transition: null, diagnostic: null }
          : {}),
      });
    }
    return await this.options.state.compareAndSwap(bindingId, null, {
      bindingId,
      activationGeneration: this.options.activationGeneration,
      desired: "private",
      selectedApp: this.options.selectedApp ?? null,
      status: "absent",
      transition: null,
      correlationKey: this.options.selectedApp
        ? `${this.options.selectedApp.displayName} · ${bindingId}`
        : `${LIVEWARE_PUBLICATION_APP_PREFIX}${bindingId}`,
      appId: null,
      publicUrl: null,
      registrationId: null,
      diagnostic: null,
    });
  }

  private async commit(
    current: BindingLivewarePublicationStateRecord,
    value: BindingLivewarePublicationState,
  ): Promise<BindingLivewarePublicationStateRecord> {
    if (value.activationGeneration !== this.options.activationGeneration) {
      throw new Error(`stale Liveware publication Activation Generation for ${value.bindingId}`);
    }
    return await this.options.state.compareAndSwap(value.bindingId, current.revision, value);
  }

  private async degrade(
    current: BindingLivewarePublicationStateRecord,
    diagnostic: string,
  ): Promise<BindingLivewarePublicationStateRecord> {
    return await this.commit(current, { ...current.value, status: "degraded", diagnostic });
  }

  private async ensureAgent(bindingId: string, control: LivewarePublicationControlSession): Promise<void> {
    const existing = this.agents.get(bindingId);
    if (existing) {
      await existing.ready;
      return;
    }
    await this.assertAuthority(bindingId);
    if (!this.accepting) throw new Error("Liveware publication generation is fenced");
    const agent = await control.startAgent();
    this.agents.set(bindingId, agent);
    void agent.exited.then(
      () => this.forgetExitedAgent(bindingId, agent),
      () => this.forgetExitedAgent(bindingId, agent),
    );
    try {
      await agent.ready;
      await this.assertAuthority(bindingId);
    } catch (error) {
      if (this.agents.get(bindingId) === agent) this.agents.delete(bindingId);
      await agent.stop().catch(() => undefined);
      throw error;
    }
  }

  private forgetExitedAgent(bindingId: string, agent: LivewarePublicationAgent): void {
    if (this.agents.get(bindingId) !== agent) return;
    this.agents.delete(bindingId);
    this.reconciled.delete(bindingId);
  }

  private async releaseAgent(bindingId: string): Promise<void> {
    const agent = this.agents.get(bindingId);
    if (!agent) return;
    this.agents.delete(bindingId);
    await agent.stop();
  }

  private async stopAgents(): Promise<void> {
    await Promise.all([...this.agents.keys()].map(async (bindingId) => await this.releaseAgent(bindingId)));
  }

  private async assertAuthority(bindingId: string): Promise<void> {
    if (!this.accepting) throw new Error("Liveware publication generation is fenced");
    const current = await this.options.state.read(bindingId);
    if (!current || current.value.activationGeneration !== this.options.activationGeneration) {
      throw new Error(`stale Liveware publication Activation Generation for ${bindingId}`);
    }
    if (!this.accepting) throw new Error("Liveware publication generation is fenced");
  }

  private async serialize<T>(bindingId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error("Liveware publication generation is fenced");
    const previous = this.operations.get(bindingId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(bindingId, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(bindingId) === current) this.operations.delete(bindingId);
    }
  }
}

function sameRegistration(left: LivewarePublicationRegistration, right: LivewarePublicationRegistration): boolean {
  return (
    left.livewareId === right.livewareId &&
    left.name === right.name &&
    left.subtitle === right.subtitle &&
    left.url === right.url
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
