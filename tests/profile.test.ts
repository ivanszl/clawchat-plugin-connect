import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateAccountProfile } from "../src/account/profile";
import { createClawChatApiClient } from "../src/clawchat/api-client";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { pluginBinding } from "./runtime-adapter-fixture";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ClawChat user profiles", () => {
  it("resolves a user's presentation nickname by stable user id", async () => {
    const fetchImpl = mock(async () => response({ code: 0, data: { nickname: "ColinShen" } }));
    const client = createClawChatApiClient({
      baseUrl: "https://app.clawling.com",
      deviceId: "device-local",
      token: "secret-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getUserProfile("usr_owner")).resolves.toEqual({ nickname: "ColinShen" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.clawling.com/v1/users/usr_owner",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
          "x-device-id": "device-local",
        }),
      }),
    );
  });
});

describe("ClawChat group settings", () => {
  it("accepts only a completely validated authoritative snapshot", async () => {
    const payloads = [
      { code: 0, data: {} },
      {
        code: 0,
        data: {
          settings: [
            {
              conversation_id: "group-1",
              muted: false,
              reply_mode: "all",
              batch_delay_seconds: 60,
              version: 2,
            },
            { conversation_id: "group-2", muted: "false", reply_mode: "mention" },
          ],
        },
      },
      {
        code: 0,
        data: {
          settings: [
            {
              conversation_id: "group-1",
              muted: false,
              reply_mode: "all",
              batch_delay_seconds: 60,
              version: 2,
            },
          ],
        },
      },
    ];
    const fetchImpl = mock(async () => response(payloads.shift()));
    const client = createClawChatApiClient({
      baseUrl: "https://app.clawling.com",
      deviceId: "device-local",
      token: "secret-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getMyGroupSettings()).resolves.toEqual({ authoritative: false, rows: [] });
    await expect(client.getMyGroupSettings()).resolves.toEqual({ authoritative: false, rows: [] });
    await expect(client.getMyGroupSettings()).resolves.toEqual({
      authoritative: true,
      rows: [
        {
          conversationId: "group-1",
          muted: false,
          replyMode: "all",
          batchDelaySeconds: 60,
          version: 2,
        },
      ],
    });
  });
});

describe("updateAccountProfile", () => {
  it("updates the activated account with its stored access token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-profile-"));
    const config = upsertAgentBinding(defaultConfig(), "work", pluginBinding());
    config.stateDbPath = join(directory, "state.sqlite");
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
    await stateStore.setDeviceId("device-local");
    await stateStore.upsertActivation({
      localAgentId: "work",
      accessToken: "secret-token",
      refreshToken: null,
      serverAgentId: "agent-1",
      userId: "user-1",
      ownerUserId: "owner-1",
      conversationId: null,
    });
    const fetchImpl = mock(async () => response({ code: 0, data: { nickname: "Luna", bio: "Coding agent" } }));

    await expect(
      updateAccountProfile({
        agentId: "work",
        config,
        stateStore,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        patch: { nickname: "Luna", bio: "Coding agent" },
      }),
    ).resolves.toEqual({ agentId: "work", profile: { nickname: "Luna", bio: "Coding agent" } });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.clawling.com/v1/users/me",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          "x-device-id": "device-local",
        }),
        body: JSON.stringify({ nickname: "Luna", bio: "Coding agent" }),
      }),
    );
    await stateStore.close();
  });

  it("requires an activated Agent Binding and a non-empty patch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-profile-"));
    const config = upsertAgentBinding(defaultConfig(), "work", pluginBinding());
    config.stateDbPath = join(directory, "state.sqlite");
    const stateStore = createStateStore({ dbPath: config.stateDbPath });

    await expect(
      updateAccountProfile({ agentId: "work", config, stateStore, patch: { nickname: "Luna" } }),
    ).rejects.toThrow("not activated");
    await expect(updateAccountProfile({ agentId: "work", config, stateStore, patch: {} })).rejects.toThrow(
      "at least one Profile field",
    );
    await stateStore.close();
  });
});
