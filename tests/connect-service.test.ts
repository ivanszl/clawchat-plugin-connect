import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { CORE_CONTROL_CONFIG_HEADER, CORE_CONTROL_ORIGIN } from "../src/service/core-control";
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
async function corePluginRequest(configPath: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Origin", CORE_CONTROL_ORIGIN);
  headers.set(CORE_CONTROL_CONFIG_HEADER, configPath);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${CORE_CONTROL_ORIGIN}/core/v1/plugins${path}`, { ...init, headers });
  const value = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? `Core control failed with HTTP ${response.status}`);
  return value;
}

describe("Connect Service", () => {
  it("blocks every downstream module when the mandatory persistence provider fails", async () => {
    const createRuntimeAdapterRegistry = mock(() => new RuntimeAdapterRegistry([]));
    const persistenceService = {
      state: {} as never,
      initialize: async () => {
        throw new Error("persistence schema validation failed");
      },
      close: async () => undefined,
    };

    await expect(
      startConnectService(
        {
          config: serviceConfig(["codex"]),
          persistenceService,
          writeOutput: () => undefined,
          writeError: () => undefined,
        },
        { createRuntimeAdapterRegistry },
      ),
    ).rejects.toThrow("persistence schema validation failed");
    expect(createRuntimeAdapterRegistry).not.toHaveBeenCalled();
  });

  it("rejects startup when the release-managed Agent skills do not match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-skills-failure-"));
    const config = serviceConfig(["codex"]);
    await expect(
      startConnectService(
        {
          config,
          configPath: join(directory, "config.json"),
          writeOutput: () => undefined,
          writeError: () => undefined,
        },
        {
          verifyInstalledSkills: async () => {
            throw new Error("managed skills mismatch");
          },
        },
      ),
    ).rejects.toThrow("managed skills mismatch");
  });

  it("starts and disposes the headless service without a mandatory Client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-headless-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex"));
    const config = serviceConfig(["codex"]);
    config.stateDbPath = stateStore.dbPath;
    const events: string[] = [];
    const output: string[] = [];

    await expect(
      startConnectService(
        {
          config,
          configPath: join(directory, "config.json"),
          stateStore,
          waitUntilShutdown: async () => undefined,
          writeOutput: (message) => output.push(message),
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
          verifyInstalledSkills: async () => undefined,
        },
      ),
    ).resolves.toEqual({ startedAgentIds: ["codex"] });

    expect(events).toEqual(["binding-close"]);
    expect(output.join("")).not.toContain("Connect Client");
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
        createRuntimeAdapterRegistry,
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
    expect(closed).toEqual(["codex-work", "codex-review"]);
    expect(closeRuntimeAdapter).toHaveBeenCalledTimes(2);
  });

  it("retires dependent Binding transports through the Core control seam before force removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-force-removal-"));
    const configPath = join(directory, "config.json");
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const pluginId = "test.force-removal";
    const removedBindingId = "removed";
    const unrelatedBindingId = "unrelated";
    const config = serviceConfig([removedBindingId, unrelatedBindingId]);
    config.stateDbPath = stateStore.dbPath;
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
    let enqueueRetiredBinding = async (): Promise<void> => {
      throw new Error("retired queue was not created");
    };
    let enqueueUnrelatedBinding = async (): Promise<void> => {
      throw new Error("unrelated queue was not created");
    };
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
    let signalCoreReady: () => void = () => undefined;
    const coreReady = new Promise<void>((resolve) => {
      signalCoreReady = resolve;
    });
    let finishShutdown: () => void = () => undefined;
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    const waitUntilShutdown = async () => {
      signalCoreReady();
      await shutdown;
    };
    const running = startConnectService(
      {
        config,
        configPath,
        stateStore,
        waitUntilShutdown,
        writeOutput: () => undefined,
        writeError: () => undefined,
      },
      {
        startBindingRuntime,
        verifyInstalledSkills: async () => undefined,
      },
    );

    await Promise.race([
      coreReady,
      running.then(() => {
        throw new Error("Connect Service stopped before Core control became ready");
      }),
    ]);
    try {
      await expect(
        corePluginRequest(configPath, `/${encodeURIComponent(pluginId)}`, { method: "DELETE" }),
      ).rejects.toThrow("required by Agent Bindings");
      expect(connected).toEqual(new Set([removedBindingId, unrelatedBindingId]));

      await expect(
        corePluginRequest(configPath, `/${encodeURIComponent(pluginId)}?force=1`, { method: "DELETE" }),
      ).rejects.toThrow("dependent transport close failed");
      expect(config.agents[removedBindingId]).toBeDefined();
      expect(connected).toEqual(new Set([removedBindingId, unrelatedBindingId]));
      await expect(enqueueRetiredBinding()).rejects.toThrow("lifecycle operation");
      await expect(enqueueUnrelatedBinding()).resolves.toBeUndefined();

      await expect(
        corePluginRequest(configPath, `/${encodeURIComponent(pluginId)}?force=1`, { method: "DELETE" }),
      ).rejects.toThrow("dependent Binding purge failed");
      expect(config.agents[removedBindingId]).toEqual(serviceBinding(pluginId));
      await expect(loadConfig(configPath)).resolves.toMatchObject({
        agents: { [removedBindingId]: serviceBinding(pluginId) },
      });
      await expect(stateStore.getActivation(removedBindingId)).resolves.toMatchObject({
        localAgentId: removedBindingId,
      });
      await expect(corePluginRequest(configPath, "")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ pluginId, status: "disabled" })]),
      );

      await expect(
        corePluginRequest(configPath, `/${encodeURIComponent(pluginId)}?force=1`, { method: "DELETE" }),
      ).resolves.toMatchObject({ pluginId });

      expect(dependentConfigurationPresentWhenClosed).toBe(true);
      expect(connected).toEqual(new Set([unrelatedBindingId]));
      expect(closeCounts.get(removedBindingId)).toBe(2);
      expect(config.agents[removedBindingId]).toBeUndefined();
      expect(config.agents[unrelatedBindingId]).toBeDefined();
      expect(startBindingRuntime).toHaveBeenCalledTimes(2);
    } finally {
      finishShutdown();
      await running;
    }

    await expect(running).resolves.toEqual({ startedAgentIds: [removedBindingId, unrelatedBindingId] });
    expect(closeCounts.get(removedBindingId)).toBe(2);
    expect(closeCounts.get(unrelatedBindingId)).toBe(1);
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
          configPath: join(directory, "config.json"),
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
          verifyInstalledSkills: async () => undefined,
        },
      ),
    ).resolves.toEqual({ startedAgentIds: ["codex"] });

    expect(events).toEqual(["binding-close", "store-close"]);
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
        { startBindingRuntime, verifyInstalledSkills: async () => undefined },
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
          verifyInstalledSkills: async () => undefined,
        },
      ),
    ).resolves.toEqual({ startedAgentIds: [] });

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
        configPath: join(directory, "config.json"),
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
