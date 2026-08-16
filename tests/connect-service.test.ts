import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientInterfaceOptions } from "../src/client-interface/server";
import { defaultConfig, getAgentBinding, loadConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectPluginHost } from "../src/plugin/host";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectPluginBundleV1,
} from "../src/plugin/sdk";
import { currentConnectPluginTarget } from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { BindingRuntimeHandle } from "../src/service/binding-runtime";
import { startConnectService } from "../src/service/connect-service";
import type {
  ClawChatLivewarePort,
  LivewareControlPlanePort,
  LivewareControlSession,
  startLivewareExposure as startLivewareExposureDefault,
} from "../src/service/liveware-exposure";
import type { ActivationCredentials, ConnectConfig } from "../src/types";
import { pluginBinding } from "./runtime-adapter-fixture";

function activation(agentId: string, ownerUserId = "owner-1"): ActivationCredentials {
  return {
    localAgentId: agentId,
    accessToken: `token-${agentId}`,
    refreshToken: null,
    serverAgentId: `server-${agentId}`,
    userId: `user-${agentId}`,
    ownerUserId,
    conversationId: `chat-${agentId}`,
  };
}

describe("Connect Service", () => {
  it("rejects startup when the release-managed Agent skills do not match", async () => {
    const config = serviceConfig(["codex"]);
    await expect(
      startConnectService(
        { config, writeOutput: () => undefined, writeError: () => undefined },
        {
          verifyInstalledSkills: async () => {
            throw new Error("managed skills mismatch");
          },
        },
      ),
    ).rejects.toThrow("managed skills mismatch");
  });

  it("rejects startup after disposing composition resources that already started", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-startup-failure-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex"));
    const config = serviceConfig(["codex"]);
    config.stateDbPath = stateStore.dbPath;
    const events: string[] = [];

    await expect(
      startConnectService(
        {
          config,
          stateStore,
          waitUntilShutdown: async () => undefined,
          writeOutput: () => undefined,
          writeError: () => undefined,
        },
        {
          startBindingRuntime: async () => ({
            agentId: "codex",
            websocketUrl: config.websocketUrl,
            deviceId: "device-1",
            close: async () => {
              events.push("binding-close");
            },
          }),
          startClientInterface: async () => {
            throw new Error("client bind failed");
          },
          verifyInstalledSkills: async () => undefined,
        },
      ),
    ).rejects.toThrow("client bind failed");

    expect(events).toEqual(["binding-close"]);
  });

  it("starts multiple Agent Bindings for one Binding Owner in one process and closes them together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex-work"));
    await stateStore.upsertActivation(activation("codex-review"));
    const config = serviceConfig(["codex-work", "codex-review", "not-activated"]);
    config.agents["codex-review"] = serviceBinding("official.clawchat.codex");
    config.stateDbPath = stateStore.dbPath;
    const closed: string[] = [];
    let activeStarts = 0;
    let maxConcurrentStarts = 0;
    const startBindingRuntime = mock(async (options): Promise<BindingRuntimeHandle> => {
      activeStarts += 1;
      maxConcurrentStarts = Math.max(maxConcurrentStarts, activeStarts);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeStarts -= 1;
      await options.execution?.runtimeAdapters.prepare(getAgentBinding(options.config, options.agentId));
      return {
        agentId: options.agentId,
        websocketUrl: config.websocketUrl,
        deviceId: "device-1",
        close: async () => {
          closed.push(options.agentId);
        },
      };
    });
    const stopClientInterface = mock(async () => undefined);
    const startClientInterface = mock(async (_options: ClientInterfaceOptions) => ({
      origin: "http://127.0.0.1:47823",
      retireBindings: async () => undefined,
      stop: stopClientInterface,
    }));
    const closeRuntimeAdapter = mock(async () => undefined);
    const notifyHandler = mock(() => undefined);
    const createRuntimeAdapterRegistry = () =>
      new RuntimeAdapterRegistry([
        {
          runtime: { pluginId: "official.clawchat.codex", capabilityId: "runtime" },
          family: "codex",
          create: () => ({
            kind: "codex",
            modes: ["read-only"],
            start: async () => {
              throw new Error("not used by this service lifecycle test");
            },
            close: closeRuntimeAdapter,
          }),
        },
      ]);

    const clientAssetsPath = join(directory, "production-client");
    const result = await startConnectService(
      {
        config,
        configPath: join(directory, "config.json"),
        stateStore,
        waitUntilShutdown: async () => undefined,
        writeOutput: () => undefined,
        protocolEventHandlers: { notify: notifyHandler },
      },
      {
        startBindingRuntime,
        startClientInterface,
        createRuntimeAdapterRegistry,
        resolveClientAssetsPath: async () => clientAssetsPath,
        verifyInstalledSkills: async () => undefined,
      },
    );

    expect(result.startedAgentIds).toEqual(["codex-work", "codex-review"]);
    expect(startBindingRuntime).toHaveBeenCalledTimes(2);
    expect(startBindingRuntime.mock.calls.map(([options]) => options.agentId)).toEqual(["codex-work", "codex-review"]);
    expect(maxConcurrentStarts).toBe(1);
    expect(
      startBindingRuntime.mock.calls.every(([options]) => options.protocolEventHandlers?.notify === notifyHandler),
    ).toBe(true);
    const execution = startBindingRuntime.mock.calls[0]?.[0].execution;
    expect(execution).toBeDefined();
    expect(startBindingRuntime.mock.calls.every(([options]) => options.execution === execution)).toBe(true);
    const turnSurfaces = startBindingRuntime.mock.calls[0]?.[0].turnSurfaces;
    expect(turnSurfaces).toBeDefined();
    expect(startBindingRuntime.mock.calls.every(([options]) => options.turnSurfaces === turnSurfaces)).toBe(true);
    expect(startBindingRuntime.mock.calls.every(([options]) => options.runtimeAdapters === undefined)).toBe(true);
    expect(startClientInterface.mock.calls[0]?.[0].runtimeAdapters).toBe(execution?.runtimeAdapters);
    expect(startClientInterface.mock.calls[0]?.[0].transcriptProjection).toBe(execution?.transcriptProjection);
    expect(startClientInterface.mock.calls[0]?.[0].runtimeInteractions).toBe(execution?.runtimeInteractions);
    expect(startClientInterface.mock.calls[0]?.[0].assetsPath).toBe(clientAssetsPath);
    expect(closed).toEqual(["codex-work", "codex-review"]);
    expect(startClientInterface).toHaveBeenCalledTimes(1);
    expect(stopClientInterface).toHaveBeenCalledTimes(1);
    expect(closeRuntimeAdapter).toHaveBeenCalledTimes(2);
  });

  it("retires only dependent Binding transports before force removal purges them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-force-removal-"));
    const configPath = join(directory, "config.json");
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const pluginId = "test.force-removal";
    const removedBindingId = "removed";
    const unrelatedBindingId = "unrelated";
    const config = serviceConfig([removedBindingId, unrelatedBindingId]);
    config.stateDbPath = stateStore.dbPath;
    config.livewareAccessPolicy = "private";
    config.agents[removedBindingId] = serviceBinding(pluginId);
    config.agents[unrelatedBindingId] = serviceBinding("official.clawchat.codex");
    await saveConfig(config, configPath);
    await stateStore.initialize();
    await stateStore.upsertActivation(activation(removedBindingId));
    await stateStore.upsertActivation(activation(unrelatedBindingId));
    const purgeAgentBinding = stateStore.purgeAgentBinding.bind(stateStore);
    let rejectNextDependentPurge = true;
    stateStore.purgeAgentBinding = async (bindingId) => {
      if (bindingId === removedBindingId && rejectNextDependentPurge) {
        rejectNextDependentPurge = false;
        throw new Error("dependent Binding purge failed");
      }
      await purgeAgentBinding(bindingId);
    };

    const bundlePath = join(directory, "force-removal-plugin.json");
    await writeFile(bundlePath, `${JSON.stringify(runtimeBundle(pluginId))}\n`);
    const installer = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined);
    await installer.install({ source: `local:${bundlePath}` });
    await installer.close();

    const connected = new Set<string>();
    const closeCounts = new Map<string, number>();
    let dependentConfigurationPresentWhenClosed = false;
    let rejectNextDependentClose = true;
    const lifecycleEvents: string[] = [];
    const exposureCloseCounts = new Map<string, number>();
    const gatewayStopCounts = new Map<string, number>();
    const exposureDeviceIds = new Map<string, string>();
    let enqueueRetiredBinding = async (): Promise<void> => {
      throw new Error("retired queue was not created");
    };
    let enqueueUnrelatedBinding = async (): Promise<void> => {
      throw new Error("unrelated queue was not created");
    };
    const retireLiveware = mock(
      async (
        retirement: {
          activation: ActivationCredentials;
          deviceId: string;
        },
        _dependencies: unknown,
      ) => {
        lifecycleEvents.push(`remote-liveware:${retirement.activation.localAgentId}`);
        expect(retirement.activation.accessToken).toBe(`token-${retirement.activation.localAgentId}`);
        const exposureDeviceId = exposureDeviceIds.get(retirement.activation.localAgentId);
        if (!exposureDeviceId) throw new Error("Expected Liveware publication device ownership");
        expect(retirement.deviceId).toBe(exposureDeviceId);
        expect(config.agents[retirement.activation.localAgentId]).toBeDefined();
      },
    );
    const startBindingRuntime = mock(async (runtimeOptions): Promise<BindingRuntimeHandle> => {
      connected.add(runtimeOptions.agentId);
      const queue = runtimeOptions.execution?.createSessionQueue(runtimeOptions.agentId, {});
      if (!queue) throw new Error("Expected Binding Session queue");
      const enqueue = async () => await queue.enqueue("late-session", async () => undefined);
      if (runtimeOptions.agentId === removedBindingId) enqueueRetiredBinding = enqueue;
      else enqueueUnrelatedBinding = enqueue;
      return {
        agentId: runtimeOptions.agentId,
        websocketUrl: config.websocketUrl,
        deviceId: "device-1",
        close: async () => {
          lifecycleEvents.push(`transport:${runtimeOptions.agentId}`);
          if (runtimeOptions.agentId === removedBindingId) {
            dependentConfigurationPresentWhenClosed = config.agents[removedBindingId] !== undefined;
          }
          closeCounts.set(runtimeOptions.agentId, (closeCounts.get(runtimeOptions.agentId) ?? 0) + 1);
          if (runtimeOptions.agentId === removedBindingId && rejectNextDependentClose) {
            rejectNextDependentClose = false;
            throw new Error("dependent transport close failed");
          }
          connected.delete(runtimeOptions.agentId);
        },
      };
    });
    let signalClientReady: (options: ClientInterfaceOptions) => void = () => undefined;
    const clientReady = new Promise<ClientInterfaceOptions>((resolve) => {
      signalClientReady = resolve;
    });
    const retireClientBindings = mock(async (bindingIds: readonly string[]) => {
      lifecycleEvents.push(`client:${bindingIds.join(",")}`);
    });
    let finishShutdown: () => void = () => undefined;
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    const running = startConnectService(
      {
        config,
        configPath,
        stateStore,
        waitUntilShutdown: async () => await shutdown,
        writeOutput: () => undefined,
        writeError: () => undefined,
      },
      {
        startBindingRuntime,
        startClientInterface: async (options) => {
          signalClientReady(options);
          return {
            origin: "http://127.0.0.1:47823",
            retireBindings: retireClientBindings,
            stop: async () => undefined,
          };
        },
        startBindingScopedClientGateway: async ({ bindingId }) => ({
          bindingId,
          origin: `http://127.0.0.1/${bindingId}`,
          stop: async () => {
            lifecycleEvents.push(`gateway:${bindingId}`);
            gatewayStopCounts.set(bindingId, (gatewayStopCounts.get(bindingId) ?? 0) + 1);
          },
        }),
        startLivewareExposure: async ({ activation: exposureActivation, deviceId: exposureDeviceId }) => {
          exposureDeviceIds.set(exposureActivation.localAgentId, exposureDeviceId);
          return {
            record: {
              ownerUserId: exposureActivation.ownerUserId,
              localAgentId: exposureActivation.localAgentId,
              appId: `app-${exposureActivation.localAgentId}`,
              publicUrl: `https://${exposureActivation.localAgentId}.liveware.example`,
              accessPolicy: "private",
            },
            close: async () => {
              const bindingId = exposureActivation.localAgentId;
              lifecycleEvents.push(`agent:${bindingId}`);
              exposureCloseCounts.set(bindingId, (exposureCloseCounts.get(bindingId) ?? 0) + 1);
            },
          };
        },
        retireLivewareExposure: retireLiveware,
        livewareDependencies: {
          controlPlane: {
            connect: async () => {
              throw new Error("composite test must use the injected retirement port");
            },
          },
          clawChat: {
            list: async () => [],
            register: async () => undefined,
            unregister: async () => undefined,
          },
        },
        verifyInstalledSkills: async () => undefined,
      },
    );

    const clientOptions = await clientReady;
    const pluginManager = clientOptions.pluginManager;
    if (!pluginManager) throw new Error("Expected running Plugin Host");
    try {
      await expect(pluginManager.remove(pluginId)).rejects.toThrow("required by Agent Bindings");
      expect(connected).toEqual(new Set([removedBindingId, unrelatedBindingId]));

      await expect(pluginManager.remove(pluginId, true)).rejects.toThrow("dependent transport close failed");
      expect(config.agents[removedBindingId]).toBeDefined();
      expect(connected).toEqual(new Set([removedBindingId, unrelatedBindingId]));
      expect(clientOptions.runtimes.map((handle) => handle.agentId)).toEqual([removedBindingId, unrelatedBindingId]);
      await expect(enqueueRetiredBinding()).rejects.toThrow("lifecycle operation");
      await expect(enqueueUnrelatedBinding()).resolves.toBeUndefined();

      await expect(pluginManager.remove(pluginId, true)).rejects.toThrow("dependent Binding purge failed");
      expect(config.agents[removedBindingId]).toEqual(serviceBinding(pluginId));
      await expect(loadConfig(configPath)).resolves.toMatchObject({
        agents: { [removedBindingId]: serviceBinding(pluginId) },
      });
      await expect(stateStore.getActivation(removedBindingId)).resolves.toMatchObject({
        localAgentId: removedBindingId,
      });
      await expect(pluginManager.list()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ pluginId, status: "disabled" })]),
      );

      await expect(pluginManager.remove(pluginId, true)).resolves.toMatchObject({ pluginId });

      expect(dependentConfigurationPresentWhenClosed).toBe(true);
      expect(connected).toEqual(new Set([unrelatedBindingId]));
      expect(closeCounts.get(removedBindingId)).toBe(2);
      expect(retireClientBindings).toHaveBeenCalledTimes(3);
      expect(retireClientBindings).toHaveBeenNthCalledWith(1, [removedBindingId]);
      expect(retireClientBindings).toHaveBeenNthCalledWith(2, [removedBindingId]);
      expect(retireClientBindings).toHaveBeenNthCalledWith(3, [removedBindingId]);
      expect(clientOptions.runtimes.map((handle) => handle.agentId)).toEqual([unrelatedBindingId]);
      expect(config.agents[removedBindingId]).toBeUndefined();
      expect(config.agents[unrelatedBindingId]).toBeDefined();
      expect(startBindingRuntime).toHaveBeenCalledTimes(2);
      expect(retireLiveware).toHaveBeenCalledTimes(1);
      expect(exposureCloseCounts.get(removedBindingId)).toBe(1);
      expect(gatewayStopCounts.get(removedBindingId)).toBe(1);
      expect(lifecycleEvents.indexOf(`remote-liveware:${removedBindingId}`)).toBeLessThan(
        lifecycleEvents.indexOf(`agent:${removedBindingId}`),
      );
      expect(lifecycleEvents.indexOf(`agent:${removedBindingId}`)).toBeLessThan(
        lifecycleEvents.indexOf(`gateway:${removedBindingId}`),
      );
      expect(lifecycleEvents.indexOf(`client:${removedBindingId}`)).toBeLessThan(
        lifecycleEvents.indexOf(`transport:${removedBindingId}`),
      );
    } finally {
      finishShutdown();
      await running;
    }

    await expect(running).resolves.toEqual({ startedAgentIds: [removedBindingId, unrelatedBindingId] });
    expect(closeCounts.get(removedBindingId)).toBe(2);
    expect(closeCounts.get(unrelatedBindingId)).toBe(1);
    expect(exposureCloseCounts.get(removedBindingId)).toBe(1);
    expect(exposureCloseCounts.get(unrelatedBindingId)).toBe(1);
    expect(gatewayStopCounts.get(removedBindingId)).toBe(1);
    expect(gatewayStopCounts.get(unrelatedBindingId)).toBe(1);
  });

  it("reports disposal failures after awaiting every remaining cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-cleanup-failure-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex"));
    const config = serviceConfig(["codex"]);
    config.stateDbPath = stateStore.dbPath;
    const events: string[] = [];
    const errors: string[] = [];
    const closeStore = stateStore.close.bind(stateStore);
    stateStore.close = async () => {
      await closeStore();
      events.push("store-close");
      throw new Error("store cleanup failed");
    };

    await expect(
      startConnectService(
        {
          config,
          stateStore,
          waitUntilShutdown: async () => undefined,
          writeOutput: () => undefined,
          writeError: (message) => errors.push(message),
        },
        {
          startBindingRuntime: async () => ({
            agentId: "codex",
            websocketUrl: config.websocketUrl,
            deviceId: "device-1",
            close: async () => {
              events.push("binding-close");
              throw new Error("binding cleanup failed");
            },
          }),
          startClientInterface: async () => ({
            origin: "http://127.0.0.1:47823",
            retireBindings: async () => undefined,
            stop: async () => {
              events.push("client-stop");
              throw new Error("client cleanup failed");
            },
          }),
          verifyInstalledSkills: async () => undefined,
        },
      ),
    ).resolves.toEqual({ startedAgentIds: ["codex"] });

    expect(events).toEqual(["client-stop", "binding-close", "store-close"]);
    expect(errors.join("")).toContain("client cleanup failed");
    expect(errors.join("")).toContain("binding cleanup failed");
    expect(errors.join("")).toContain("store cleanup failed");
  });

  it("keeps healthy Bindings running when another activated Binding fails to start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-partial-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("healthy"));
    await stateStore.upsertActivation(activation("broken"));
    const config = serviceConfig(["healthy", "broken"]);
    config.stateDbPath = stateStore.dbPath;
    const errors: string[] = [];
    const startBindingRuntime = mock(async (options): Promise<BindingRuntimeHandle> => {
      if (options.agentId === "broken") throw new Error("invalid credentials");
      return {
        agentId: options.agentId,
        websocketUrl: config.websocketUrl,
        deviceId: "device-1",
        close: async () => undefined,
      };
    });
    const startClientInterface = mock(async () => ({
      origin: "http://127.0.0.1:47823",
      retireBindings: async () => undefined,
      stop: async () => undefined,
    }));

    await expect(
      startConnectService(
        {
          config,
          configPath: join(directory, "config.json"),
          stateStore,
          waitUntilShutdown: async () => undefined,
          writeOutput: () => undefined,
          writeError: (message) => errors.push(message),
        },
        { startBindingRuntime, startClientInterface, verifyInstalledSkills: async () => undefined },
      ),
    ).resolves.toEqual({ startedAgentIds: ["healthy"] });
    expect(errors.join("")).toContain("broken: invalid credentials");
  });

  it("keeps the service alive when every activated Binding is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-none-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("broken"));
    const config = serviceConfig(["broken"]);
    config.stateDbPath = stateStore.dbPath;
    const errors: string[] = [];
    const startClientInterface = mock(async () => ({
      origin: "http://127.0.0.1:47823",
      retireBindings: async () => undefined,
      stop: async () => undefined,
    }));

    await expect(
      startConnectService(
        {
          config,
          configPath: join(directory, "config.json"),
          stateStore,
          waitUntilShutdown: async () => undefined,
          writeOutput: () => undefined,
          writeError: (message) => errors.push(message),
        },
        {
          startBindingRuntime: async () => {
            throw new Error("runtime executable was not found");
          },
          startClientInterface,
          verifyInstalledSkills: async () => undefined,
        },
      ),
    ).resolves.toEqual({ startedAgentIds: [] });

    expect(startClientInterface).toHaveBeenCalledTimes(1);
    expect(errors.join("")).toContain("runtime executable was not found");
    expect(await stateStore.getRuntimeStatus("broken")).toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: "runtime executable was not found",
    });
    await stateStore.close();
  });

  it("keeps a Tool Request worker alive after a transient state-store failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-tool-worker-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("work"));
    const config = serviceConfig(["work"]);
    config.stateDbPath = stateStore.dbPath;
    let releaseShutdown: () => void = () => undefined;
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    let reportInjectedFailure: () => void = () => undefined;
    const injectedFailure = new Promise<void>((resolve) => {
      reportInjectedFailure = resolve;
    });
    const originalClaim = stateStore.claimNextToolRequest.bind(stateStore);
    let shouldFailClaim = true;
    stateStore.claimNextToolRequest = async (bindingId) => {
      if (shouldFailClaim) {
        shouldFailClaim = false;
        reportInjectedFailure();
        throw new Error("injected transient claim failure");
      }
      return await originalClaim(bindingId);
    };
    const errors: string[] = [];
    const service = startConnectService(
      {
        config,
        stateStore,
        waitUntilShutdown: async () => await shutdown,
        writeOutput: () => undefined,
        writeError: (message) => errors.push(message),
      },
      {
        startBindingRuntime: async () => ({
          agentId: "work",
          websocketUrl: config.websocketUrl,
          deviceId: "device-1",
          executeTool: async () => ({ nickname: "work" }),
          close: async () => undefined,
        }),
        startClientInterface: async () => ({
          origin: "http://127.0.0.1:47823",
          retireBindings: async () => undefined,
          stop: async () => undefined,
        }),
        verifyInstalledSkills: async () => undefined,
      },
    );

    try {
      await injectedFailure;
      await stateStore.submitToolRequest({
        requestId: "request-after-claim-failure",
        bindingId: "work",
        toolName: "clawchat_get_account_profile",
        normalizedInput: {},
        timeoutMs: 1_000,
      });
      const deadline = Date.now() + 800;
      let record = await stateStore.getToolRequest("request-after-claim-failure");
      while (record?.state === "pending" && Date.now() < deadline) {
        await Bun.sleep(10);
        record = await stateStore.getToolRequest("request-after-claim-failure");
      }
      expect(record).toMatchObject({ state: "succeeded", attemptCount: 1 });
      expect(errors.join("")).toContain("injected transient claim failure");
    } finally {
      releaseShutdown();
      await service;
    }
  });

  it("starts Liveware after the Client Interface and closes it before the Client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-liveware-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex"));
    const config = serviceConfig(["codex"]);
    config.stateDbPath = stateStore.dbPath;
    config.livewareAccessPolicy = "private";
    const events: string[] = [];
    const process = controlledAgentProcess(events);
    const controlPlane: LivewareControlPlanePort = {
      connect: async (): Promise<LivewareControlSession> => {
        events.push("liveware-connect");
        return {
          listApps: async () => [],
          createApp: async (name) => ({
            appId: "app-0000000000000001",
            name,
            publicUrl: "https://app-0000000000000001.apps.example",
          }),
          setAccessPolicy: async () => undefined,
          bindTunnel: async () => "https://app-0000000000000001.apps.example",
          deleteApp: async () => undefined,
          startAgent: async () => {
            events.push("liveware-agent-start");
            return process;
          },
        };
      },
    };
    const clawChat: ClawChatLivewarePort = {
      list: async () => [],
      register: async () => undefined,
      unregister: async () => undefined,
    };

    await startConnectService(
      {
        config,
        stateStore,
        waitUntilShutdown: async () => undefined,
        writeOutput: () => undefined,
        writeError: () => undefined,
      },
      {
        startBindingRuntime: async () => ({
          agentId: "codex",
          websocketUrl: config.websocketUrl,
          deviceId: "device-1",
          close: async () => {
            events.push("binding-close");
          },
        }),
        startClientInterface: async () => {
          events.push("client-start");
          return {
            origin: "http://127.0.0.1:47823",
            retireBindings: async () => undefined,
            stop: async () => {
              events.push("client-stop");
            },
          };
        },
        startBindingScopedClientGateway: async ({ bindingId }) => ({
          bindingId,
          origin: "http://127.0.0.1:48001",
          stop: async () => undefined,
        }),
        livewareDependencies: { controlPlane, clawChat },
        verifyInstalledSkills: async () => undefined,
      },
    );

    expect(events.indexOf("client-start")).toBeLessThan(events.indexOf("liveware-agent-start"));
    expect(events.indexOf("liveware-agent-stop")).toBeLessThan(events.indexOf("client-stop"));
  });

  it("starts one Binding-Scoped Client Gateway and Liveware Exposure for each Agent Binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-multi-liveware-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("personal", "shared-owner"));
    await stateStore.upsertActivation(activation("work", "shared-owner"));
    const config = serviceConfig(["personal", "work"]);
    config.agents.work = pluginBinding();
    config.stateDbPath = stateStore.dbPath;
    config.livewareAccessPolicy = "private";
    const gatewayStops: string[] = [];
    const exposureStops: string[] = [];
    const startBindingScopedClientGateway = mock(async ({ bindingId }: { bindingId: string }) => ({
      bindingId,
      origin: bindingId === "personal" ? "http://127.0.0.1:48001" : "http://127.0.0.1:48002",
      stop: async () => {
        gatewayStops.push(bindingId);
      },
    }));
    const startLivewareExposure = mock(async (input: Parameters<typeof startLivewareExposureDefault>[0]) => ({
      record: {
        ownerUserId: input.activation.ownerUserId,
        localAgentId: input.activation.localAgentId,
        appId: `app-${input.activation.localAgentId}`,
        publicUrl: `https://${input.activation.localAgentId}.apps.example`,
        accessPolicy: input.accessPolicy,
      },
      close: async () => {
        exposureStops.push(input.activation.localAgentId);
      },
    }));

    await startConnectService(
      {
        config,
        stateStore,
        waitUntilShutdown: async () => undefined,
        writeOutput: () => undefined,
        writeError: () => undefined,
      },
      {
        startBindingRuntime: async ({ agentId }) => ({
          agentId,
          websocketUrl: config.websocketUrl,
          deviceId: "device-1",
          close: async () => undefined,
        }),
        startClientInterface: async () => ({
          origin: "http://127.0.0.1:47823",
          retireBindings: async () => undefined,
          stop: async () => undefined,
        }),
        startBindingScopedClientGateway,
        startLivewareExposure,
        livewareDependencies: {
          controlPlane: { connect: async () => Promise.reject(new Error("not used")) },
          clawChat: {
            list: async () => [],
            register: async () => undefined,
            unregister: async () => undefined,
          },
        },
        verifyInstalledSkills: async () => undefined,
      },
    );

    expect(startBindingScopedClientGateway.mock.calls.map(([input]) => input.bindingId)).toEqual(["personal", "work"]);
    expect(startLivewareExposure.mock.calls.map(([input]) => [input.activation.localAgentId, input.upstream])).toEqual([
      ["personal", "http://127.0.0.1:48001"],
      ["work", "http://127.0.0.1:48002"],
    ]);
    expect(exposureStops).toEqual(["personal", "work"]);
    expect(gatewayStops).toEqual(["personal", "work"]);
  });

  it("keeps local Connect running when the optional Liveware Exposure cannot start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-liveware-failure-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex"));
    const config = serviceConfig(["codex"]);
    config.stateDbPath = stateStore.dbPath;
    config.livewareAccessPolicy = "private";
    const errors: string[] = [];
    const result = await startConnectService(
      {
        config,
        stateStore,
        waitUntilShutdown: async () => undefined,
        writeOutput: () => undefined,
        writeError: (message) => errors.push(message),
      },
      {
        startBindingRuntime: async () => ({
          agentId: "codex",
          websocketUrl: config.websocketUrl,
          deviceId: "device-1",
          close: async () => undefined,
        }),
        startClientInterface: async () => ({
          origin: "http://127.0.0.1:47823",
          retireBindings: async () => undefined,
          stop: async () => undefined,
        }),
        startBindingScopedClientGateway: async ({ bindingId }) => ({
          bindingId,
          origin: "http://127.0.0.1:48001",
          stop: async () => undefined,
        }),
        livewareDependencies: {
          controlPlane: {
            connect: async () => {
              throw new Error("control plane unavailable");
            },
          },
          clawChat: {
            list: async () => [],
            register: async () => undefined,
            unregister: async () => undefined,
          },
        },
        verifyInstalledSkills: async () => undefined,
      },
    );

    expect(result).toEqual({ startedAgentIds: ["codex"] });
    expect(errors.join("")).toContain("local Connect remains running: control plane unavailable");
  });
});

function serviceConfig(agentIds: string[]): ConnectConfig {
  const config = defaultConfig();
  config.defaultAgent = agentIds[0] ?? "";
  config.agents = Object.fromEntries(
    agentIds.map((agentId, index) => [
      agentId,
      serviceBinding(index === 0 ? "official.clawchat.codex" : `test.future-${index}`),
    ]),
  );
  config.livewareAccessPolicy = "off";
  return config;
}

function serviceBinding(pluginId: string) {
  return { ...pluginBinding(), runtime: { pluginId, capabilityId: "runtime" } };
}

function runtimeBundle(pluginId: string): ConnectPluginBundleV1 {
  const source = `
export default {
  async activate(context) {
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "force-removal-test",
      create() {
        return {
          modes: [],
          async start() { throw new Error("not exercised"); }
        };
      }
    });
  }
};
`.trim();
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId,
      version: "1.0.0",
      dependencies: [
        { type: "host", id: "runtime-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "runtime",
          type: "runtime",
          family: "force-removal-test",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}

function controlledAgentProcess(events: string[]) {
  let resolveExit: (exitCode: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    exited,
    stop: async () => {
      events.push("liveware-agent-stop");
      resolveExit(0);
    },
  };
}
