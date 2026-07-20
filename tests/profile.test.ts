import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, upsertAgent } from "../src/config";
import { updateAccountProfile } from "../src/profile";
import { createStateStore } from "../src/state";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("updateAccountProfile", () => {
  it("updates the activated account with its stored access token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-profile-"));
    const config = upsertAgent(defaultConfig(), "work", { kind: "codex" });
    config.stateDbPath = join(directory, "state.sqlite");
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
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
        }),
        body: JSON.stringify({ nickname: "Luna", bio: "Coding agent" }),
      }),
    );
    await stateStore.close();
  });

  it("requires an activated Agent Binding and a non-empty patch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-profile-"));
    const config = upsertAgent(defaultConfig(), "work", { kind: "codex" });
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
