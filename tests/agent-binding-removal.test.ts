import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAgentBinding } from "../src/agent-binding-removal";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/state";
import type { ActivationCredentials } from "../src/types";

describe("Agent Binding removal", () => {
  it("stops Connect, retires only that Binding's Exposure, and purges its local data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-remove-binding-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.agents = { personal: { kind: "codex" }, work: { kind: "codex" } };
    config.defaultAgent = "work";
    config.stateDbPath = join(directory, "state.sqlite");
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.upsertActivation(activation("personal"));
    await store.upsertActivation(activation("work"));
    await store.setLivewareExposure(exposure("personal"));
    await store.setLivewareExposure(exposure("work"));
    await store.insertProject({ projectId: "shared-project", name: "Shared", rootPath: directory });
    await store.upsertRuntimeSession({
      chatId: "work-chat",
      sessionId: "work-session",
      agentId: "work",
      runtimeSessionId: "work-thread",
      projectId: "shared-project",
      hasMessages: true,
    });
    await store.upsertInboundMessage({
      agentId: "work",
      direction: "inbound",
      kind: "message",
      eventType: "message.created",
      chatId: "work-chat",
      messageId: "work-message",
      raw: {},
    });
    await store.submitToolRequest({
      requestId: "work-tool",
      bindingId: "work",
      toolName: "clawchat_get_my_profile",
      normalizedInput: {},
      timeoutMs: 60_000,
    });
    await store.setRuntimeConnectionStatus("work", true, null);
    const actions: string[] = [];
    const getServiceStatus = mock(async () => {
      actions.push("status");
      return { running: true };
    });
    const stopService = mock(async () => {
      actions.push("stop");
    });
    const startService = mock(async () => {
      actions.push("start");
    });
    const retireLivewareExposure = mock(async ({ activation: principal }: { activation: ActivationCredentials }) => {
      actions.push(`retire:${principal.localAgentId}`);
      await store.clearLivewareExposure(principal.localAgentId);
    });

    await removeAgentBinding(
      { agentId: "work", configPath },
      { store, getServiceStatus, stopService, startService, retireLivewareExposure },
    );

    expect(actions).toEqual(["status", "stop", "retire:work", "start"]);
    await expect(loadConfig(configPath)).resolves.toMatchObject({
      defaultAgent: "personal",
      agents: { personal: { kind: "codex" } },
    });
    expect((await loadConfig(configPath)).agents.work).toBeUndefined();
    await expect(store.getActivation("work")).resolves.toBeNull();
    await expect(store.getActivation("personal")).resolves.toMatchObject({ localAgentId: "personal" });
    await expect(store.listRuntimeSessions("work-chat", "work")).resolves.toEqual([]);
    await expect(store.getToolRequest("work-tool")).resolves.toBeNull();
    await expect(store.getRuntimeStatus("work")).resolves.toBeNull();
    await expect(store.getLivewareExposure("work")).resolves.toBeNull();
    await expect(store.getLivewareExposure("personal")).resolves.toMatchObject({ localAgentId: "personal" });
    await expect(store.listProjects()).resolves.toHaveLength(1);
    await store.close();
  });
});

function activation(localAgentId: string): ActivationCredentials {
  return {
    localAgentId,
    accessToken: `token-${localAgentId}`,
    refreshToken: null,
    serverAgentId: `agent-${localAgentId}`,
    userId: `user-${localAgentId}`,
    ownerUserId: `owner-${localAgentId}`,
    conversationId: `conversation-${localAgentId}`,
  };
}

function exposure(localAgentId: string) {
  return {
    localAgentId,
    ownerUserId: `owner-${localAgentId}`,
    appId: `app-${localAgentId}`,
    publicUrl: `https://${localAgentId}.apps.example`,
    accessPolicy: "private" as const,
  };
}
