import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import { defaultConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectPluginHost } from "../src/plugin/host";
import livewareDescriptor from "../src/plugin/official/liveware-descriptor";
import {
  createOfficialLivewarePluginEntry,
  type OfficialLivewareExposureServices,
} from "../src/plugin/official/liveware-entry";
import { OFFICIAL_LIVEWARE_PLUGIN_ID } from "../src/plugin/official/liveware-manifest";
import {
  BindingLivewarePublicationLifecycle,
  type BindingLivewarePublicationState,
  type BindingLivewarePublicationStateRecord,
  type BindingLivewarePublicationStateStore,
  type LivewarePublicationApp,
  type LivewarePublicationControlPlane,
  type LivewarePublicationControlSession,
  type LivewarePublicationRegistration,
  type LivewarePublicationRegistrationPort,
} from "../src/plugin/official/liveware-publication";
import { ConnectBindingLivewarePublicationStateStore } from "../src/plugin/official/liveware-publication-state";
import { retireOfficialLivewarePublications } from "../src/plugin/official/liveware-retirement";
import type {
  ConnectPluginExposureActivation,
  ConnectPluginExposureProvider,
  ManagedConnectPluginHostCapabilities,
} from "../src/plugin/official-sdk";
import { installPluginBundle, listInstalledPlugins } from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { resolveLivewareExecutablePath } from "../src/service/liveware-control";
import { CONNECT_VERSION } from "../src/service/version";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

class MemoryPublicationStateStore implements BindingLivewarePublicationStateStore {
  readonly records = new Map<string, BindingLivewarePublicationStateRecord>();

  failNextCompareAndSwap = false;
  async read(bindingId: string): Promise<BindingLivewarePublicationStateRecord | null> {
    return structuredClone(this.records.get(bindingId) ?? null);
  }

  async compareAndSwap(
    bindingId: string,
    expectedRevision: number | null,
    value: BindingLivewarePublicationState,
  ): Promise<BindingLivewarePublicationStateRecord> {
    const current = this.records.get(bindingId);
    if ((current?.revision ?? null) !== expectedRevision) throw new Error("publication state conflict");
    if (this.failNextCompareAndSwap) {
      this.failNextCompareAndSwap = false;
      throw new Error("simulated crash before local identity commit");
    }
    const record = { revision: (current?.revision ?? 0) + 1, value: structuredClone(value) };
    this.records.set(bindingId, record);
    return structuredClone(record);
  }
}

class FakePublicationRemote
  implements LivewarePublicationControlPlane, LivewarePublicationControlSession, LivewarePublicationRegistrationPort
{
  readonly apps: LivewarePublicationApp[] = [];
  afterCreate?: () => void;
  appLookupError: Error | null = null;
  afterBind?: () => void;
  afterRegister?: () => void;
  deleteError: Error | null = null;
  failUnregister = false;
  beforeListApps?: () => Promise<void>;
  readonly registrations: LivewarePublicationRegistration[] = [];
  readonly calls: string[] = [];

  async connect(bindingId: string): Promise<LivewarePublicationControlSession> {
    this.calls.push(`connect:${bindingId}`);
    return this;
  }

  async listApps(): Promise<LivewarePublicationApp[]> {
    this.calls.push("app:list");
    await this.beforeListApps?.();
    if (this.appLookupError) throw this.appLookupError;
    return structuredClone(this.apps);
  }

  async inspectApp(appId: string): Promise<LivewarePublicationApp> {
    this.calls.push(`app:inspect:${appId}`);
    const app = this.apps.find((candidate) => candidate.appId === appId);
    if (!app) throw new Error(`app not found: ${appId}`);
    return structuredClone(app);
  }

  async createApp(correlationKey: string): Promise<LivewarePublicationApp> {
    this.calls.push(`app:create:${correlationKey}`);
    const app: LivewarePublicationApp = {
      appId: `app-${this.apps.length + 1}`,
      name: correlationKey,
      publicUrl: null,
    };
    this.apps.push(app);
    this.afterCreate?.();
    return structuredClone(app);
  }
  async bindTunnel(appId: string, upstream: string): Promise<string> {
    this.calls.push(`tunnel:bind:${appId}:${upstream}`);
    const app = this.apps.find((candidate) => candidate.appId === appId);
    if (!app) throw new Error(`app not found: ${appId}`);
    app.publicUrl = `https://${appId}.liveware.example`;
    this.afterBind?.();
    return app.publicUrl;
  }

  async deleteApp(appId: string): Promise<void> {
    this.calls.push(`app:delete:${appId}`);
    if (this.deleteError) throw this.deleteError;
    const index = this.apps.findIndex((candidate) => candidate.appId === appId);
    if (index >= 0) this.apps.splice(index, 1);
  }

  async list(bindingId: string, deviceId: string): Promise<LivewarePublicationRegistration[]> {
    this.calls.push(`registration:list:${bindingId}:${deviceId}`);
    return structuredClone(this.registrations);
  }

  async register(bindingId: string, deviceId: string, registration: LivewarePublicationRegistration): Promise<void> {
    this.calls.push(`registration:create:${bindingId}:${deviceId}:${registration.livewareId}`);
    this.registrations.push(structuredClone(registration));
    this.afterRegister?.();
  }

  async unregister(bindingId: string, deviceId: string, livewareId: string): Promise<void> {
    this.calls.push(`registration:delete:${bindingId}:${deviceId}:${livewareId}`);
    if (this.failUnregister) throw new Error("ClawChat unregister failed");
    const index = this.registrations.findIndex((candidate) => candidate.livewareId === livewareId);
    if (index >= 0) this.registrations.splice(index, 1);
  }
}

describe("official Liveware Binding publication lifecycle", () => {
  it("skips offline retirement when selected Bindings have no publication state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-empty-retirement-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await expect(
        retireOfficialLivewarePublications({
          bindingIds: ["without-publication"],
          clawChatBaseUrl: "https://clawchat.test",
          configPath: join(directory, "config.json"),
          stateStore,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await stateStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("embeds the target Liveware companion in the release-verified official Bundle", async () => {
    const built = await buildOfficialPlugin(livewareDescriptor, {
      target: `${process.platform}-${process.arch}`,
      write: false,
    });

    expect(built.bundle.manifest.version).toBe(CONNECT_VERSION);
    const companion = built.bundle.files["assets/liveware"];
    expect(companion).toMatchObject({ encoding: "base64" });
    if (!companion) throw new Error("official Liveware Bundle omitted its companion");
    expect(Buffer.from(companion.content, "base64").byteLength).toBeGreaterThan(1_000);
  });
  it("resolves Agent-managed Liveware operations to the installed official Bundle companion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-companion-"));
    try {
      const configPath = join(directory, "config.json");
      const built = await buildOfficialPlugin(livewareDescriptor, {
        target: `${process.platform}-${process.arch}`,
        write: false,
      });
      await installPluginBundle({
        configPath,
        source: { type: "local", path: directory },
        bundle: built.bundle,
      });
      const selected = (await listInstalledPlugins(configPath)).find(
        (plugin) => plugin.pluginId === OFFICIAL_LIVEWARE_PLUGIN_ID,
      );
      if (!selected) throw new Error("official Liveware Plugin was not selected");

      await expect(resolveLivewareExecutablePath(configPath)).resolves.toBe(
        join(dirname(selected.manifestPath), "assets", "liveware"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves retirement intent when the official Bundle restarts or advances generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-retirement-state-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.agents = {};
    await saveConfig(config, configPath);
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
    await stateStore.initialize();
    const built = await buildOfficialPlugin(livewareDescriptor, {
      target: `${process.platform}-${process.arch}`,
      write: false,
    });
    const bundlePath = join(directory, "liveware.connect-plugin");
    await writeFile(bundlePath, `${JSON.stringify(built.bundle)}\n`);
    const installed = await installPluginBundle({
      configPath,
      source: { type: "local", path: bundlePath },
      bundle: built.bundle,
    });
    const retiring = {
      bindingId: "retiring-binding",
      activationGeneration: installed.activationGeneration,
      desired: "retired" as const,
      status: "retiring" as const,
      transition: "delete-app" as const,
      correlationKey: "ClawChat Connect · retiring-binding",
      appId: "app-retiring",
      publicUrl: "https://app-retiring.liveware.example",
      registrationId: null,
      diagnostic: "remote App deletion failed",
    };
    const generationOne = new ConnectBindingLivewarePublicationStateStore(
      stateStore,
      async () => undefined,
      installed.activationGeneration,
    );
    await generationOne.compareAndSwap(retiring.bindingId, null, retiring);
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
    });

    await host.activateInstalled();
    await expect(generationOne.read(retiring.bindingId)).resolves.toMatchObject({ value: retiring });
    const reinstalled = await host.reinstall(OFFICIAL_LIVEWARE_PLUGIN_ID);
    const generationTwo = new ConnectBindingLivewarePublicationStateStore(
      stateStore,
      async () => undefined,
      reinstalled.activationGeneration,
    );
    await expect(generationTwo.read(retiring.bindingId)).resolves.toMatchObject({
      value: { ...retiring, activationGeneration: reinstalled.activationGeneration },
    });

    await host.close();
    await stateStore.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("provisions one private App, tunnel, and launcher for one Agent Binding", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 7,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });

    const publication = await lifecycle.ensurePrivate({ bindingId: "primary", deviceId: "device-primary" });

    expect(publication).toMatchObject({
      bindingId: "primary",
      activationGeneration: 7,
      desired: "private",
      status: "active",
      transition: null,
      correlationKey: "ClawChat Connect · primary",
      appId: "app-1",
      publicUrl: "https://app-1.liveware.example",
      registrationId: "app-1",
    });
    expect(remote.apps).toHaveLength(1);
    expect(remote.registrations).toEqual([
      {
        livewareId: "app-1",
        name: "ClawChat Connect · primary",
        subtitle: "Connect Web",
        url: "https://app-1.liveware.example",
      },
    ]);
    expect(remote.calls).not.toContain(expect.stringContaining("unbind"));
  });

  it("adopts an App by its persisted correlation key after remote success and a crash before identity commit", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.afterCreate = () => {
      state.failNextCompareAndSwap = true;
    };
    const options = {
      activationGeneration: 3,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    };
    const interrupted = new BindingLivewarePublicationLifecycle(options);

    await expect(interrupted.ensurePrivate({ bindingId: "recover", deviceId: "device-recover" })).rejects.toThrow(
      "simulated crash",
    );
    expect(remote.apps).toHaveLength(1);
    expect((await state.read("recover"))?.value).toMatchObject({
      status: "provisioning",
      transition: "create-app",
      correlationKey: "ClawChat Connect · recover",
      appId: null,
    });

    remote.afterCreate = undefined;
    const restarted = new BindingLivewarePublicationLifecycle(options);
    await expect(restarted.ensurePrivate({ bindingId: "recover", deviceId: "device-recover" })).resolves.toMatchObject({
      status: "active",
      appId: "app-1",
    });
    expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);
  });

  it("recovers an uncommitted App identity by correlation key before retirement", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.afterCreate = () => {
      state.failNextCompareAndSwap = true;
    };
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 3,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const target = { bindingId: "retire-recovery", deviceId: "device-retire-recovery" };
    await expect(lifecycle.ensurePrivate(target)).rejects.toThrow("simulated crash");
    remote.afterCreate = undefined;

    await expect(lifecycle.retire(target)).resolves.toMatchObject({ status: "retired", appId: "app-1" });

    expect(remote.apps).toEqual([]);
    expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);
    expect(remote.calls.filter((call) => call.startsWith("app:delete:"))).toEqual(["app:delete:app-1"]);
  });

  it("marks duplicate correlation-key matches degraded without creating or mutating a remote resource", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.apps.push(
      { appId: "duplicate-a", name: "ClawChat Connect · duplicate", publicUrl: null },
      { appId: "duplicate-b", name: "ClawChat Connect · duplicate", publicUrl: null },
    );
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });

    await expect(
      lifecycle.ensurePrivate({ bindingId: "duplicate", deviceId: "device-duplicate" }),
    ).resolves.toMatchObject({
      status: "degraded",
      transition: "create-app",
      diagnostic: "multiple owned Apps match the publication correlation key",
      appId: null,
    });
    expect(remote.calls.some((call) => call.startsWith("app:create:"))).toBeFalse();
    expect(remote.calls.some((call) => call.startsWith("tunnel:bind:"))).toBeFalse();
    expect(remote.calls.some((call) => call.startsWith("registration:create:"))).toBeFalse();
  });

  it("performs no create when authoritative correlation-key lookup is unavailable", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.appLookupError = new Error("control plane unavailable");
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });

    await expect(
      lifecycle.ensurePrivate({ bindingId: "unavailable", deviceId: "device-unavailable" }),
    ).resolves.toMatchObject({
      status: "degraded",
      transition: "create-app",
      diagnostic: "App correlation-key lookup failed: control plane unavailable",
    });
    expect(remote.calls.some((call) => call.startsWith("app:create:"))).toBeFalse();
  });

  it("adopts a tunnel after a lost bind response without binding it twice", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.afterBind = () => {
      throw new Error("lost tunnel response");
    };
    const options = {
      activationGeneration: 2,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    };

    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "tunnel-recovery",
        deviceId: "device-tunnel",
      }),
    ).rejects.toThrow("lost tunnel response");
    remote.afterBind = undefined;
    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "tunnel-recovery",
        deviceId: "device-tunnel",
      }),
    ).resolves.toMatchObject({ status: "active", publicUrl: "https://app-1.liveware.example" });
    expect(remote.calls.filter((call) => call.startsWith("tunnel:bind:"))).toHaveLength(1);
  });

  it("adopts an exact launcher after a lost registration response without registering twice", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.afterRegister = () => {
      throw new Error("lost registration response");
    };
    const options = {
      activationGeneration: 2,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    };

    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "registration-recovery",
        deviceId: "device-registration",
      }),
    ).rejects.toThrow("lost registration response");
    remote.afterRegister = undefined;
    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "registration-recovery",
        deviceId: "device-registration",
      }),
    ).resolves.toMatchObject({ status: "active", registrationId: "app-1" });
    expect(remote.calls.filter((call) => call.startsWith("registration:create:"))).toHaveLength(1);
  });

  it("durably retires the exact launcher and App without a separate tunnel unbind", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 5,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const target = { bindingId: "retire", deviceId: "device-retire" };
    await lifecycle.ensurePrivate(target);
    remote.calls.length = 0;

    await expect(lifecycle.retire(target)).resolves.toMatchObject({
      desired: "retired",
      status: "retired",
      transition: null,
      appId: "app-1",
      registrationId: "app-1",
    });
    expect(remote.calls).toEqual([
      "registration:list:retire:device-retire",
      "registration:delete:retire:device-retire:app-1",
      "connect:retire",
      "app:list",
      "app:delete:app-1",
      "app:list",
    ]);
    expect(remote.calls.some((call) => call.includes("unbind"))).toBeFalse();
    expect(remote.apps).toHaveLength(0);
    expect(remote.registrations).toHaveLength(0);
  });

  it("keeps retirement durable after cleanup failure and resumes only on an explicit retry", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 9,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const target = { bindingId: "retry-retirement", deviceId: "device-retry" };
    await lifecycle.ensurePrivate(target);
    remote.calls.length = 0;
    remote.deleteError = new Error("remote App deletion failed");

    await expect(lifecycle.retire(target)).rejects.toThrow("remote App deletion failed");
    expect((await state.read(target.bindingId))?.value).toMatchObject({
      desired: "retired",
      status: "retiring",
      transition: "delete-app",
      diagnostic: "remote App deletion failed",
      appId: "app-1",
      registrationId: "app-1",
    });
    expect(remote.registrations).toHaveLength(0);
    expect(remote.apps).toHaveLength(1);
    const callsAfterFailure = [...remote.calls];
    await expect(lifecycle.ensurePrivate(target)).rejects.toThrow("retiring and cannot be reprovisioned");
    expect(remote.calls).toEqual(callsAfterFailure);

    remote.deleteError = null;
    await expect(lifecycle.retire(target)).resolves.toMatchObject({ status: "retired", transition: null });
    expect(remote.apps).toHaveLength(0);
    expect(remote.calls.filter((call) => call.startsWith("registration:delete:"))).toHaveLength(1);
  });

  it("serializes one publication and rejects every stale-generation operation before remote dispatch", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const target = { bindingId: "generation", deviceId: "device-generation" };
    const first = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const [left, right] = await Promise.all([first.ensurePrivate(target), first.ensurePrivate(target)]);
    expect(left).toEqual(right);
    expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);

    const selected = new BindingLivewarePublicationLifecycle({
      activationGeneration: 2,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });
    await expect(selected.ensurePrivate(target)).resolves.toMatchObject({ activationGeneration: 2, status: "active" });
    const callsAfterCutover = [...remote.calls];
    await expect(first.ensurePrivate(target)).rejects.toThrow("stale Liveware publication Activation Generation");
    await expect(first.retire(target)).rejects.toThrow("stale Liveware publication Activation Generation");
    expect(remote.calls).toEqual(callsAfterCutover);
  });

  it("fences a generation during an in-flight lookup before it can issue the next remote effect", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    let releaseLookup!: () => void;
    let observeLookup!: () => void;
    const lookupEntered = new Promise<void>((resolve) => {
      observeLookup = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    remote.beforeListApps = async () => {
      observeLookup();
      await lookupGate;
    };
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 4,
      upstream: "http://127.0.0.1:47890",
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const pending = lifecycle.ensurePrivate({ bindingId: "fenced", deviceId: "device-fenced" });
    await lookupEntered;

    const disposal = lifecycle.dispose();
    releaseLookup();
    await expect(pending).rejects.toThrow("Liveware publication generation is fenced");
    await disposal;
    expect(remote.calls.some((call) => call.startsWith("app:create:"))).toBeFalse();
    await expect(lifecycle.ensurePrivate({ bindingId: "fenced", deviceId: "device-fenced" })).rejects.toThrow(
      "Liveware publication generation is fenced",
    );
  });

  it("recovers publication identity from Binding-scoped Plugin Durable State after process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-publication-"));
    try {
      const dbPath = join(directory, "state.sqlite");
      const remote = new FakePublicationRemote();
      const target = { bindingId: "durable", deviceId: "device-durable" };
      const firstDatabase = createStateStore({ dbPath });
      const first = new BindingLivewarePublicationLifecycle({
        activationGeneration: 1,
        upstream: "http://127.0.0.1:47890",
        state: new ConnectBindingLivewarePublicationStateStore(firstDatabase),
        controlPlane: remote,
        registrations: remote,
      });
      await first.ensurePrivate(target);
      await firstDatabase.close();

      const restartedDatabase = createStateStore({ dbPath });
      const restarted = new BindingLivewarePublicationLifecycle({
        activationGeneration: 2,
        upstream: "http://127.0.0.1:47890",
        state: new ConnectBindingLivewarePublicationStateStore(restartedDatabase),
        controlPlane: remote,
        registrations: remote,
      });
      await expect(restarted.ensurePrivate(target)).resolves.toMatchObject({
        activationGeneration: 2,
        status: "active",
        appId: "app-1",
      });
      expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);
      expect(remote.calls.filter((call) => call.startsWith("tunnel:bind:"))).toHaveLength(2);
      await restartedDatabase.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes current Bindings through the release-verified official Exposure entry and releases its gateway", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    let provider: ConnectPluginExposureProvider | undefined;
    const hostCapabilities = {
      get(id: "runtime-provider" | "exposure-provider") {
        if (id !== "exposure-provider") throw new Error("unexpected Host Capability");
        return {
          interfaceVersion: "1",
          register(candidate: ConnectPluginExposureProvider) {
            provider = candidate;
          },
        };
      },
    } as ManagedConnectPluginHostCapabilities;
    await createOfficialLivewarePluginEntry().activate({
      activationGeneration: 12,
      interfaceVersion: "1",
      installationConfiguration: {},
      hostCapabilities,
    });
    let gatewayReleases = 0;
    let gatewayAcquisitions = 0;
    const bindingTargets = [
      { bindingId: "official-a", deviceId: "device-official" },
      { bindingId: "official-b", deviceId: "device-official" },
    ];
    const officialLiveware: OfficialLivewareExposureServices = {
      async listBindings() {
        return bindingTargets;
      },
      state,
      controlPlane: remote,
      registrations: remote,
      async acquireGateway(activationGeneration) {
        if (activationGeneration !== 12) throw new Error("off policy must not acquire the gateway");
        gatewayAcquisitions += 1;
        return {
          upstream: `http://127.0.0.1:${47889 + gatewayAcquisitions}`,
          async release() {
            gatewayReleases += 1;
          },
        };
      },
    };
    const activation = {
      activationGeneration: 12,
      configuration: { accessPolicy: "private" },
      client: {
        async fetch() {
          return new Response(null, { status: 204 });
        },
      },
      officialLiveware,
    } as ConnectPluginExposureActivation & { officialLiveware: OfficialLivewareExposureServices };

    let dispose = await provider?.activate(activation);

    expect(provider?.capabilityId).toBe("liveware");
    expect(remote.apps.map((app) => app.name)).toEqual([
      "ClawChat Connect · official-a",
      "ClawChat Connect · official-b",
    ]);
    expect(remote.registrations).toHaveLength(2);
    await dispose?.();
    expect(gatewayReleases).toBe(1);
    dispose = await provider?.activate(activation);
    expect(gatewayAcquisitions).toBe(2);
    expect(remote.calls.filter((call) => call.endsWith(":http://127.0.0.1:47891"))).toHaveLength(2);
    remote.afterCreate = () => {
      remote.afterCreate = undefined;
      throw new Error("simulated lost App-create response");
    };
    bindingTargets.push({ bindingId: "official-c", deviceId: "device-official" });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if ((await state.read("official-c"))?.value.status === "active") break;
      await Bun.sleep(5);
    }
    expect(remote.apps.map((app) => app.name)).toEqual([
      "ClawChat Connect · official-a",
      "ClawChat Connect · official-b",
      "ClawChat Connect · official-c",
    ]);
    expect((await state.read("official-c"))?.value).toMatchObject({ status: "active", diagnostic: null });
    expect(remote.calls.filter((call) => call === "app:create:ClawChat Connect · official-c")).toHaveLength(1);
    const managed = dispose as typeof dispose & { retireBindings(bindingIds: readonly string[]): Promise<void> };
    await managed.retireBindings(["official-a", "official-c"]);
    expect(remote.apps.map((app) => app.name)).toEqual(["ClawChat Connect · official-b"]);
    expect(gatewayReleases).toBe(1);
    bindingTargets.splice(0);
    await managed.retireBindings(["official-b"]);
    expect(remote.apps).toHaveLength(0);
    expect(gatewayReleases).toBe(2);
    state.records.delete("official-b");
    bindingTargets.push({ bindingId: "official-b", deviceId: "device-official" });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if ((await state.read("official-b"))?.value.status === "active") break;
      await Bun.sleep(5);
    }
    expect((await state.read("official-b"))?.value).toMatchObject({ status: "active" });
    expect(remote.apps.map((app) => app.name)).toEqual(["ClawChat Connect · official-b"]);
    expect(gatewayAcquisitions).toBe(3);
    await dispose?.();
    expect(gatewayReleases).toBe(3);

    const retire = await provider?.activate({
      ...activation,
      activationGeneration: 13,
      configuration: { accessPolicy: "off" },
    });
    expect(remote.apps).toHaveLength(0);
    expect(remote.registrations).toHaveLength(0);
    expect((await state.read("official-b"))?.value).toMatchObject({
      activationGeneration: 13,
      status: "retired",
    });
    await retire?.();
    expect(gatewayReleases).toBe(3);
  });

  it("activates the installed official Bundle with Core-held Binding credentials and one shared gateway", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-plugin-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.agents = {
      "binding-a": {
        runtime: { pluginId: "fixture.runtime", capabilityId: "runtime" },
        runtimeConfig: {},
      },
      "binding-b": {
        runtime: { pluginId: "fixture.runtime", capabilityId: "runtime" },
        runtimeConfig: {},
      },
    };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
    const activation = (localAgentId: string, accessToken: string) => ({
      localAgentId,
      accessToken,
      refreshToken: null,
      serverAgentId: `${localAgentId}-remote`,
      userId: "owner",
      ownerUserId: "owner",
      conversationId: null,
    });
    await stateStore.upsertActivation(activation("binding-a", "token-a"));
    await stateStore.upsertActivation(activation("binding-b", "token-b"));
    const built = await buildOfficialPlugin(livewareDescriptor, {
      target: `${process.platform}-${process.arch}`,
      write: false,
    });
    const bundlePath = join(directory, built.filename);
    await writeFile(bundlePath, `${JSON.stringify(built.bundle)}\n`);
    const remote = new FakePublicationRemote();
    const tokens: string[] = [];
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      livewareDependencies: {
        controlPlane: {
          async connect(accessToken) {
            tokens.push(accessToken);
            return {
              listApps: async () =>
                (await remote.listApps()).map((app) => ({ ...app, publicUrl: app.publicUrl ?? "" })),
              inspectApp: async (appId) => {
                const app = await remote.inspectApp(appId);
                return { ...app, publicUrl: app.publicUrl ?? "" };
              },
              createApp: async (correlationKey) => {
                const app = await remote.createApp(correlationKey);
                return { ...app, publicUrl: app.publicUrl ?? "" };
              },
              setAccessPolicy: async () => undefined,
              bindTunnel: remote.bindTunnel.bind(remote),
              deleteApp: remote.deleteApp.bind(remote),
              startAgent: async () => ({ exited: new Promise<number>(() => undefined), stop: async () => undefined }),
            };
          },
        },
        clawChat: {
          list: async (principal, deviceId) => await remote.list(principal.localAgentId, deviceId),
          register: async (principal, deviceId, registration) =>
            await remote.register(principal.localAgentId, deviceId, registration),
          unregister: async (principal, deviceId, livewareId) =>
            await remote.unregister(principal.localAgentId, deviceId, livewareId),
        },
      },
    });
    const forwarded = {
      origin: null as string | null,
      bindingScope: null as string | null,
      surface: null as "client" | "private" | null,
    };
    await host.bindClientInterface({
      origin: "http://127.0.0.1:49777",
      async fetch(request) {
        forwarded.origin = request.headers.get("origin");
        forwarded.bindingScope = request.headers.get("x-clawchat-connect-binding-scope");
        forwarded.surface = "client";
        return new Response("shared-client");
      },
      async fetchPrivateGateway(request) {
        forwarded.origin = request.headers.get("origin");
        forwarded.bindingScope = request.headers.get("x-clawchat-connect-binding-scope");
        forwarded.surface = "private";
        return new Response("private-client");
      },
    });
    try {
      const artifact = built.bundle.manifest.artifacts[0];
      expect(artifact).toBeDefined();
      if (!artifact) throw new Error("official Liveware Bundle has no artifact");
      await host.install({
        source: bundlePath,
        target: artifact.target,
        exposureConfigurations: { liveware: { accessPolicy: "private" } },
      });

      expect(tokens.sort()).toEqual(["token-a", "token-b"]);
      expect(await new ConnectBindingLivewarePublicationStateStore(stateStore).read("binding-a")).toMatchObject({
        value: { activationGeneration: 1, status: "active" },
      });
      await host.reinstall(OFFICIAL_LIVEWARE_PLUGIN_ID);
      expect(await new ConnectBindingLivewarePublicationStateStore(stateStore).read("binding-a")).toMatchObject({
        value: { activationGeneration: 2, status: "active" },
      });
      expect(tokens.sort()).toEqual(["token-a", "token-a", "token-b", "token-b"]);
      expect(remote.apps).toHaveLength(2);
      const gatewayCall = remote.calls.findLast((call) => call.startsWith("tunnel:bind:"));
      const upstream = gatewayCall?.slice(gatewayCall.lastIndexOf(":http") + 1);
      if (!upstream) throw new Error("official Liveware Bundle did not bind the Shared Client Gateway");
      const response = await fetch(new URL("/client", upstream), {
        headers: {
          origin: "https://untrusted.example",
          "x-clawchat-connect-binding-scope": "spoofed",
        },
      });
      expect(await response.text()).toBe("private-client");
      expect(forwarded.origin).toBe("http://127.0.0.1:49777");
      expect(forwarded.bindingScope).toBeNull();
      expect(forwarded.surface).toBe("private");
      const reserved = await fetch(new URL("/client/v1/plugins", upstream));
      expect(reserved.status).toBe(200);
      expect(await reserved.text()).toBe("private-client");
      expect(forwarded.surface).toBe("private");
      await host.disable(OFFICIAL_LIVEWARE_PLUGIN_ID);
      expect(remote.apps).toHaveLength(0);
      expect(await new ConnectBindingLivewarePublicationStateStore(stateStore).read("binding-a")).toMatchObject({
        value: { desired: "retired", status: "retired" },
      });

      await host.enable(OFFICIAL_LIVEWARE_PLUGIN_ID);
      expect(remote.apps).toHaveLength(2);
      remote.failUnregister = true;
      await expect(host.disable(OFFICIAL_LIVEWARE_PLUGIN_ID)).rejects.toThrow("managed resource retirement failed");
      expect((await host.list()).find((entry) => entry.pluginId === OFFICIAL_LIVEWARE_PLUGIN_ID)?.status).toBe(
        "active",
      );
      expect(remote.apps).toHaveLength(2);
      remote.failUnregister = false;
      await host.remove(OFFICIAL_LIVEWARE_PLUGIN_ID);
      expect(remote.apps).toHaveLength(0);
      expect(await new ConnectBindingLivewarePublicationStateStore(stateStore).read("binding-a")).toBeNull();
    } finally {
      await host.close();
      await stateStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
