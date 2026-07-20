import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingRuntimeHandle } from "../src/binding-runtime";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import { startConnectService } from "../src/connect-service";
import { createStateStore } from "../src/state";
import type { ActivationCredentials } from "../src/types";

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
    let config = upsertAgentBinding(defaultConfig(), "codex-work", { kind: "codex" });
    config = upsertAgentBinding(config, "codex-review", { kind: "codex" });
    config = upsertAgentBinding(config, "not-activated", { kind: "codex" });
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

    const result = await startConnectService(
      {
        config,
        configPath: join(directory, "config.json"),
        stateStore,
        waitUntilShutdown: async () => undefined,
        writeOutput: () => undefined,
      },
      { startBindingRuntime },
    );

    expect(result.startedAgentIds).toEqual(["codex-work", "codex-review"]);
    expect(startBindingRuntime).toHaveBeenCalledTimes(2);
    expect(startBindingRuntime.mock.calls.map(([options]) => options.agentId)).toEqual(["codex-work", "codex-review"]);
    expect(closed).toEqual(["codex-work", "codex-review"]);
  });

  it("keeps healthy Bindings running when another activated Binding fails to start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-service-partial-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertActivation(activation("healthy"));
    await stateStore.upsertActivation(activation("broken"));
    let config = upsertAgentBinding(defaultConfig(), "healthy", { kind: "codex" });
    config = upsertAgentBinding(config, "broken", { kind: "codex" });
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
        { startBindingRuntime },
      ),
    ).resolves.toEqual({ startedAgentIds: ["healthy"] });
    expect(errors.join("")).toContain("broken: invalid credentials");
  });
});
