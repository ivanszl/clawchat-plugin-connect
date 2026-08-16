import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConnect } from "../src/account/activation";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { pluginBinding } from "./runtime-adapter-fixture";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "clawchat-connect-activation-"));
}
function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("activateConnect", () => {
  it("exchanges invite code for a named configured agent and persists credentials", async () => {
    const dir = await tempDir();
    const config = upsertAgentBinding(defaultConfig(), "codex", pluginBinding());
    config.livewareAccessPolicy = "off";
    config.stateDbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    const fetchImpl = mock(async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? response({
            code: 0,
            msg: "ok",
            data: {
              access_token: "token-1",
              refresh_token: "refresh-1",
              agent: { id: "agt-1", user_id: "usr-agent", owner_id: "usr-owner" },
              conversation: { id: "cnv-1" },
            },
          })
        : response({ code: 0, data: { nickname: "codex" } }),
    ) as unknown as typeof fetch;
    const result = await activateConnect({ agentId: "codex", code: "A1B2C3", config, store, fetchImpl });
    const deviceId = await store.getDeviceId();
    expect(deviceId).toBeString();
    expect(deviceId).not.toBe("");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.clawling.com/v1/agents/connect",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/json", "x-device-id": deviceId }),
        body: JSON.stringify({ code: "A1B2C3", platform: "clawchat-connect", type: "clawbot" }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.clawling.com/v1/users/me",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer token-1",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ nickname: "codex" }),
      }),
    );
    expect(result).toMatchObject({
      localAgentId: "codex",
      accessToken: "token-1",
      userId: "usr-agent",
      ownerUserId: "usr-owner",
      conversationId: "cnv-1",
    });
    await expect(store.getActivation("codex")).resolves.toMatchObject({ accessToken: "token-1", userId: "usr-agent" });
    await expect(store.getInstallationOwner()).resolves.toBe("usr-owner");
    await store.close();
  });
  it("sends stored agent user_id when reactivating the same local agent", async () => {
    const dir = await tempDir();
    const config = upsertAgentBinding(defaultConfig(), "codex", pluginBinding());
    config.livewareAccessPolicy = "off";
    config.stateDbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.commitActivationForInstallationOwner({
      localAgentId: "codex",
      accessToken: "old",
      refreshToken: null,
      serverAgentId: "agt-old",
      userId: "usr-old",
      ownerUserId: "usr-owner",
      conversationId: null,
    });
    const fetchImpl = mock(async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? response({
            code: 0,
            data: { access_token: "new", agent: { id: "agt-new", user_id: "usr-old", owner_id: "usr-owner" } },
          })
        : response({ code: 0, data: { nickname: "codex" } }),
    ) as unknown as typeof fetch;
    await activateConnect({ agentId: "codex", code: "NEWCODE", config, store, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.clawling.com/v1/agents/connect",
      expect.objectContaining({
        body: JSON.stringify({ code: "NEWCODE", platform: "clawchat-connect", type: "clawbot", user_id: "usr-old" }),
      }),
    );
    await store.close();
  });
  it("rejects a different-owner Agent Binding without changing local state", async () => {
    const dir = await tempDir();
    const config = upsertAgentBinding(defaultConfig(), "personal", pluginBinding());
    config.agents.work = {
      ...config.agents.personal,
    };
    config.livewareAccessPolicy = "off";
    config.stateDbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.commitActivationForInstallationOwner({
      localAgentId: "personal",
      accessToken: "personal-token",
      refreshToken: null,
      serverAgentId: "personal-agent",
      userId: "personal-user",
      ownerUserId: "personal-owner",
      conversationId: "personal-conversation",
    });
    const fetchImpl = mock(async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? response({
            code: 0,
            data: {
              access_token: "work-token",
              agent: { id: "work-agent", user_id: "work-user", owner_id: "work-owner" },
              conversation: { id: "work-conversation" },
            },
          })
        : response({ code: 0, data: { nickname: "work" } }),
    ) as unknown as typeof fetch;

    await expect(activateConnect({ agentId: "work", code: "WORKCODE", config, store, fetchImpl })).rejects.toThrow(
      "this Connect installation is owned by personal-owner",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(store.listActivations()).resolves.toEqual([
      expect.objectContaining({ localAgentId: "personal", ownerUserId: "personal-owner" }),
    ]);
    await expect(store.getActivation("work")).resolves.toBeNull();
    await expect(store.getInstallationOwner()).resolves.toBe("personal-owner");
    await store.close();
  });
  it("backfills a legacy single-owner installation and rejects another owner without mutation", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const legacy = createStateStore({ dbPath });
    await legacy.upsertActivation({
      localAgentId: "personal",
      accessToken: "legacy-token",
      refreshToken: null,
      serverAgentId: "legacy-agent",
      userId: "legacy-user",
      ownerUserId: "legacy-owner",
      conversationId: "legacy-conversation",
    });
    await expect(
      legacy.commitActivationForInstallationOwner({
        localAgentId: "work",
        accessToken: "other-token",
        refreshToken: null,
        serverAgentId: "other-agent",
        userId: "other-user",
        ownerUserId: "other-owner",
        conversationId: "other-conversation",
      }),
    ).resolves.toBe("installation-owner-mismatch");
    await expect(legacy.getActivation("work")).resolves.toBeNull();
    await legacy.close();

    const upgraded = createStateStore({ dbPath });
    await expect(upgraded.getInstallationOwner()).resolves.toBe("legacy-owner");
    await expect(upgraded.listActivations()).resolves.toEqual([
      expect.objectContaining({
        localAgentId: "personal",
        accessToken: "legacy-token",
        ownerUserId: "legacy-owner",
      }),
    ]);
    await expect(
      upgraded.commitActivationForInstallationOwner({
        localAgentId: "work",
        accessToken: "other-token",
        refreshToken: null,
        serverAgentId: "other-agent",
        userId: "other-user",
        ownerUserId: "other-owner",
        conversationId: "other-conversation",
      }),
    ).resolves.toBe("installation-owner-mismatch");
    await expect(upgraded.getActivation("work")).resolves.toBeNull();
    await upgraded.close();
  });
  it("rejects assigning an occupied Agent Binding to a different Binding Owner", async () => {
    const dir = await tempDir();
    const config = upsertAgentBinding(defaultConfig(), "personal", pluginBinding());
    config.livewareAccessPolicy = "off";
    config.stateDbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.commitActivationForInstallationOwner({
      localAgentId: "personal",
      accessToken: "original-token",
      refreshToken: null,
      serverAgentId: "original-agent",
      userId: "original-user",
      ownerUserId: "original-owner",
      conversationId: "original-conversation",
    });
    const fetchImpl = mock(async () =>
      response({
        code: 0,
        data: {
          access_token: "intruder-token",
          agent: { id: "intruder-agent", user_id: "original-user", owner_id: "different-owner" },
        },
      }),
    ) as unknown as typeof fetch;

    await expect(
      activateConnect({ agentId: "personal", code: "DIFFERENTOWNER", config, store, fetchImpl }),
    ).rejects.toThrow("re-pair ownership contract was violated");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.clawling.com/v1/agents/connect",
      expect.objectContaining({
        body: JSON.stringify({
          code: "DIFFERENTOWNER",
          platform: "clawchat-connect",
          type: "clawbot",
          user_id: "original-user",
        }),
      }),
    );
    await expect(store.getActivation("personal")).resolves.toMatchObject({
      accessToken: "original-token",
      ownerUserId: "original-owner",
    });
    await store.close();
  });
  it("allows one Binding Owner to activate a second Agent Binding", async () => {
    const dir = await tempDir();
    const config = upsertAgentBinding(defaultConfig(), "personal", pluginBinding());
    config.agents.work = {
      ...config.agents.personal,
    };
    config.livewareAccessPolicy = "off";
    config.stateDbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.commitActivationForInstallationOwner({
      localAgentId: "personal",
      accessToken: "personal-token",
      refreshToken: null,
      serverAgentId: "personal-agent",
      userId: "personal-user",
      ownerUserId: "shared-owner",
      conversationId: "personal-conversation",
    });
    const fetchImpl = mock(async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? response({
            code: 0,
            data: {
              access_token: "work-token",
              agent: { id: "work-agent", user_id: "work-user", owner_id: "shared-owner" },
            },
          })
        : response({ code: 0, data: { nickname: "work" } }),
    ) as unknown as typeof fetch;

    await expect(
      activateConnect({ agentId: "work", code: "SAMEOWNER", config, store, fetchImpl }),
    ).resolves.toMatchObject({ localAgentId: "work", ownerUserId: "shared-owner" });
    await expect(store.getActivation("work")).resolves.toMatchObject({
      localAgentId: "work",
      ownerUserId: "shared-owner",
      accessToken: "work-token",
    });
    await store.close();
  });
  it("leaves credentials and Installation Owner unset when Profile synchronization fails", async () => {
    const dir = await tempDir();
    const config = upsertAgentBinding(defaultConfig(), "work", pluginBinding());
    config.livewareAccessPolicy = "off";
    config.stateDbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    const fetchImpl = mock(async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? response({
            code: 0,
            data: {
              access_token: "token-1",
              agent: { id: "agt-1", user_id: "usr-agent", owner_id: "usr-owner" },
            },
          })
        : response({ code: 500, msg: "profile unavailable" }),
    ) as unknown as typeof fetch;

    await expect(activateConnect({ agentId: "work", code: "A1B2C3", config, store, fetchImpl })).rejects.toThrow(
      "local credentials and Installation Owner were preserved",
    );
    await expect(store.getActivation("work")).resolves.toBeNull();
    await expect(store.getInstallationOwner()).resolves.toBeNull();
    await store.close();
  });

  it("requires the named agent to exist and does not create project or directory state", async () => {
    const config = defaultConfig();
    const fetchImpl = mock() as unknown as typeof fetch;
    await expect(activateConnect({ agentId: "codex", code: "A1B2C3", config, fetchImpl })).rejects.toThrow(
      /Unknown clawchat-connect agent|No clawchat-connect agent/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects incomplete activation responses", async () => {
    const dir = await tempDir();
    const config = upsertAgentBinding(defaultConfig(), "codex", pluginBinding());
    config.livewareAccessPolicy = "off";
    config.stateDbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    const fetchImpl = mock(async () => response({ code: 0, data: { agent: {} } })) as unknown as typeof fetch;
    await expect(activateConnect({ agentId: "codex", code: "A1B2C3", config, store, fetchImpl })).rejects.toThrow(
      /access_token/,
    );
    await store.close();
  });
});
