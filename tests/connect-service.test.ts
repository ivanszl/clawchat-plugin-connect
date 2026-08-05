import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { BindingRuntimeHandle } from "../src/service/binding-runtime";
import { startConnectService } from "../src/service/connect-service";
import type {
  ClawChatLivewarePort,
  LivewareControlPlanePort,
  LivewareControlSession,
  startLivewareExposure as startLivewareExposureDefault,
} from "../src/service/liveware-exposure";
import type { ActivationCredentials, AgentBindingConfig, ConnectConfig } from "../src/types";

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

  it("starts multiple Agent Bindings for one Binding Owner in one process and closes them together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex-work"));
    await stateStore.upsertActivation(activation("codex-review"));
    const config = serviceConfig(["codex-work", "codex-review", "not-activated"]);
    config.agents["codex-review"] = { kind: "codex" };
    config.stateDbPath = stateStore.dbPath;
    const closed: string[] = [];
    let activeStarts = 0;
    let maxConcurrentStarts = 0;
    const startBindingRuntime = mock(async (options): Promise<BindingRuntimeHandle> => {
      activeStarts += 1;
      maxConcurrentStarts = Math.max(maxConcurrentStarts, activeStarts);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeStarts -= 1;
      await options.runtimeAdapters.prepare(getAgentBinding(options.config, options.agentId));
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
    const startClientInterface = mock(async () => ({ origin: "http://127.0.0.1:47823", stop: stopClientInterface }));
    const closeRuntimeAdapter = mock(async () => undefined);
    const notifyHandler = mock(() => undefined);
    const createRuntimeAdapterRegistry = () =>
      new RuntimeAdapterRegistry([
        {
          kind: "codex",
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
        startClientInterface,
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
    expect(closed).toEqual(["codex-work", "codex-review"]);
    expect(startClientInterface).toHaveBeenCalledTimes(1);
    expect(stopClientInterface).toHaveBeenCalledTimes(1);
    expect(closeRuntimeAdapter).toHaveBeenCalledTimes(2);
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
    config.agents.work = { kind: "codex" };
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
  config.defaultAgent = agentIds[0] ?? null;
  config.agents = Object.fromEntries(
    agentIds.map((agentId, index) => [
      agentId,
      { kind: index === 0 ? "codex" : `future-runtime-${index}` } as unknown as AgentBindingConfig,
    ]),
  );
  config.livewareAccessPolicy = "off";
  return config;
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
