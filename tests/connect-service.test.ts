import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingRuntimeHandle } from "../src/binding-runtime";
import { defaultConfig } from "../src/config";
import { startConnectService } from "../src/connect-service";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { createStateStore } from "../src/state";
import type { ActivationCredentials, AgentBindingConfig, ConnectConfig } from "../src/types";

function activation(agentId: string): ActivationCredentials {
  return {
    localAgentId: agentId,
    accessToken: `token-${agentId}`,
    refreshToken: null,
    serverAgentId: `server-${agentId}`,
    userId: `user-${agentId}`,
    ownerUserId: `owner-${agentId}`,
    conversationId: `chat-${agentId}`,
  };
}

describe("Connect Service", () => {
  it("starts every activated Agent Binding in one process and closes them together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("codex-work"));
    await stateStore.upsertActivation(activation("codex-review"));
    const config = serviceConfig(["codex-work", "codex-review", "not-activated"]);
    config.stateDbPath = stateStore.dbPath;
    const closed: string[] = [];
    const startBindingRuntime = mock(
      async (options): Promise<BindingRuntimeHandle> => ({
        agentId: options.agentId,
        websocketUrl: config.websocketUrl,
        deviceId: "device-1",
        close: async () => {
          closed.push(options.agentId);
        },
      }),
    );
    const stopClientInterface = mock(async () => undefined);
    const startClientInterface = mock(async () => ({ origin: "http://127.0.0.1:47823", stop: stopClientInterface }));
    const closeRuntimeAdapter = mock(async () => undefined);
    const onProtocolEvent = mock(() => undefined);
    const createRuntimeAdapterRegistry = () =>
      new RuntimeAdapterRegistry([
        {
          kind: "codex",
          modes: ["read-only"],
          start: async () => {
            throw new Error("not used by this service lifecycle test");
          },
          close: closeRuntimeAdapter,
        },
      ]);

    const result = await startConnectService(
      {
        config,
        configPath: join(directory, "config.json"),
        stateStore,
        waitUntilShutdown: async () => undefined,
        writeOutput: () => undefined,
        onProtocolEvent,
      },
      { startBindingRuntime, startClientInterface, createRuntimeAdapterRegistry },
    );

    expect(result.startedAgentIds).toEqual(["codex-work", "codex-review"]);
    expect(startBindingRuntime).toHaveBeenCalledTimes(2);
    expect(startBindingRuntime.mock.calls.map(([options]) => options.agentId)).toEqual(["codex-work", "codex-review"]);
    expect(startBindingRuntime.mock.calls.every(([options]) => options.onProtocolEvent === onProtocolEvent)).toBe(true);
    expect(closed).toEqual(["codex-work", "codex-review"]);
    expect(startClientInterface).toHaveBeenCalledTimes(1);
    expect(stopClientInterface).toHaveBeenCalledTimes(1);
    expect(closeRuntimeAdapter).toHaveBeenCalledTimes(1);
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
        { startBindingRuntime, startClientInterface },
      ),
    ).resolves.toEqual({ startedAgentIds: ["healthy"] });
    expect(errors.join("")).toContain("broken: invalid credentials");
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
  return config;
}
