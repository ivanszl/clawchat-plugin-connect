import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAgentBinding } from "../src/account/agent-binding-removal";
import { FileTurnSubmissionStaging } from "../src/client-interface/turn-submission-staging";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectBindingLivewarePublicationStateStore } from "../src/plugin/official/liveware-publication-state";
import type { ActivationCredentials } from "../src/types";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { pluginBinding } from "./runtime-adapter-fixture";

describe("Agent Binding removal", () => {
  it("stops Connect, retires only that Binding's Exposure, and purges its catalog data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-remove-binding-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.agents = { personal: pluginBinding(), work: pluginBinding() };
    config.defaultAgent = "work";
    config.stateDbPath = join(directory, "state.sqlite");
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: config.stateDbPath });
    const publicationState = new ConnectBindingLivewarePublicationStateStore(store);
    await store.upsertActivation(activation("personal"));
    await store.upsertActivation(activation("work"));
    await publicationState.compareAndSwap("personal", null, publication("personal"));
    await publicationState.compareAndSwap("work", null, publication("work"));
    await store.upsertRuntimeSession({
      chatId: "work-chat",
      sessionId: "work-session",
      agentId: "work",
      runtimeSessionId: "work-thread",
      workspaceRef: null,
      hasMessages: true,
    });
    await store.upsertRuntimeSession({
      chatId: "personal-chat",
      sessionId: "personal-session",
      agentId: "personal",
      runtimeSessionId: "personal-thread",
      workspaceRef: null,
      hasMessages: true,
    });
    const workSession = await store.getCurrentRuntimeSession("work-chat", "work");
    const personalSession = await store.getCurrentRuntimeSession("personal-chat", "personal");
    if (!workSession || !personalSession) throw new Error("test Sessions were not materialized");
    const workspaces = new WorkspaceCatalog(store);
    const workWorkspace = await workspaces.resolveWorkspace(workSession);
    const personalWorkspace = await workspaces.resolveWorkspace(personalSession);
    const staging = new FileTurnSubmissionStaging(config.stateDbPath);
    const stagedWork = await staging.stage({
      submissionId: "work-submission",
      sessionRef: workSession.sessionRef,
      prompt: "work",
      attachments: [attachment("work")],
    });
    stagedWork.transfer();
    const stagedPersonal = await staging.stage({
      submissionId: "personal-submission",
      sessionRef: personalSession.sessionRef,
      prompt: "personal",
      attachments: [attachment("personal")],
    });
    stagedPersonal.transfer();
    await store.claimClientCommand("work-command", "turn.submit", `${workSession.sessionRef}:work-digest`);
    await store.claimClientCommand("personal-command", "turn.submit", `${personalSession.sessionRef}:personal-digest`);
    await store.upsertTranscriptBlock(workSession.sessionRef, transcriptBlock("work-block"));
    await store.upsertTranscriptBlock(personalSession.sessionRef, transcriptBlock("personal-block"));
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
    const retireLivewarePublications = mock(async (bindingIds: readonly string[]) => {
      for (const bindingId of bindingIds) {
        actions.push(`retire:${bindingId}`);
      }
    });

    await removeAgentBinding(
      { agentId: "work", configPath },
      { store, getServiceStatus, stopService, startService, retireLivewarePublications },
    );

    expect(actions).toEqual(["status", "stop", "retire:work", "start"]);
    await expect(loadConfig(configPath)).resolves.toMatchObject({
      defaultAgent: "personal",
      agents: { personal: pluginBinding() },
    });
    expect((await loadConfig(configPath)).agents.work).toBeUndefined();
    await expect(store.getActivation("work")).resolves.toBeNull();
    await expect(store.getActivation("personal")).resolves.toMatchObject({ localAgentId: "personal" });
    await expect(store.listRuntimeSessions("work-chat", "work")).resolves.toEqual([]);
    await expect(store.getToolRequest("work-tool")).resolves.toBeNull();
    await expect(store.getRuntimeStatus("work")).resolves.toBeNull();
    await expect(publicationState.read("work")).resolves.toBeNull();
    await expect(publicationState.read("personal")).resolves.toMatchObject({
      value: { appId: "app-personal", bindingId: "personal" },
    });
    await expect(store.getClientCommandOutcome("work-command")).resolves.toEqual({ state: "missing" });
    await expect(store.getClientCommandOutcome("personal-command")).resolves.toMatchObject({ state: "pending" });
    expect((await store.listClientEvents(0)).map(({ event }) => "sessionRef" in event && event.sessionRef)).toEqual([
      personalSession.sessionRef,
    ]);
    expect((await stat(workWorkspace.workingDirectory)).isDirectory()).toBe(true);
    expect((await stat(personalWorkspace.workingDirectory)).isDirectory()).toBe(true);
    await expect(staging.attachment("work-submission", 0)).resolves.toBeNull();
    await expect(staging.attachment("personal-submission", 0)).resolves.toMatchObject({
      sessionRef: personalSession.sessionRef,
    });
    await expect(store.listWorkspaces()).resolves.toHaveLength(1);
    await store.close();
  });
});

function attachment(label: string) {
  const bytes = new TextEncoder().encode(label);
  return {
    name: `${label}.png`,
    mime: "image/png",
    size: bytes.byteLength,
    readBytes: async () => bytes,
  };
}

function transcriptBlock(id: string) {
  return {
    id,
    type: "message" as const,
    origin: "runtime" as const,
    state: "complete" as const,
    plainText: id,
    role: "assistant" as const,
    author: "Agent",
    markdown: id,
  };
}

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

function publication(bindingId: string) {
  return {
    bindingId,
    activationGeneration: 1,
    desired: "private" as const,
    status: "active" as const,
    transition: null,
    correlationKey: `publication:${bindingId}`,
    appId: `app-${bindingId}`,
    publicUrl: `https://${bindingId}.apps.example`,
    registrationId: `registration-${bindingId}`,
    diagnostic: null,
  };
}
