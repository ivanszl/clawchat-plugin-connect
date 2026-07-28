import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/state";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "clawchat-connect-"));
}

describe("agent-only config", () => {
  it("writes owner-only JSON config without project or directory config", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    await saveConfig(config, path);
    const text = await readFile(path, "utf8");
    expect(text).toContain('"agents"');
    expect(text).not.toMatch(/"defaultProject"|"projects"|"workDir"/u);
    await expect(loadConfig(path)).resolves.toMatchObject({
      defaultAgent: "codex",
      agents: { codex: { kind: "codex" } },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("normalizes empty config to no default agent", () => {
    const config = defaultConfig();
    expect(config.defaultAgent).toBeNull();
    expect(config.agents).toEqual({});
  });
});

describe("state store", () => {
  it("persists Protocol v2 negative acknowledgements on outbound messages", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath });
    await store.claimMessageOnce({
      agentId: "codex",
      direction: "outbound",
      kind: "message",
      eventType: "message.send",
      traceId: "trace-send",
      messageId: "trace-send",
    });

    await expect(
      store.markMessageFailed({
        messageId: "trace-send",
        protocolMessageId: "msg-client-stable",
        rejectedAt: 1234,
        error: "chat_not_found: chat missing",
      }),
    ).resolves.toBe(true);
    await store.close();

    const database = new Database(dbPath);
    expect(
      database.query("SELECT send_status, protocol_message_id, rejected_at, send_error FROM clawchat_messages").get(),
    ).toEqual({
      send_status: "failed",
      protocol_message_id: "msg-client-stable",
      rejected_at: 1234,
      send_error: "chat_not_found: chat missing",
    });
    database.close();
  });

  it("durably records a Protocol v2 delivery before advancing its dseq high-water", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath });
    await store.beginProtocolDeliveryEpoch("codex", "01JXYZ8K3MNPQRSTVWXYZ0AB");

    await expect(
      store.recordProtocolDelivery({
        agentId: "codex",
        ackEpoch: "01JXYZ8K3MNPQRSTVWXYZ0AB",
        dseq: 1,
        eventKey: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
        eventType: "message.send",
        traceId: "down-1",
        chatId: "chat-1",
        messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
        raw: { version: "2", event: "message.send", dseq: 1 },
      }),
    ).resolves.toBe("inserted");
    await expect(store.getProtocolDeliveryState("codex")).resolves.toEqual({
      ackEpoch: "01JXYZ8K3MNPQRSTVWXYZ0AB",
      lastReadDseq: 1,
      ackHighWater: 1,
    });

    await store.close();
    const reopened = createStateStore({ dbPath });
    await expect(reopened.getProtocolDeliveryState("codex")).resolves.toEqual({
      ackEpoch: "01JXYZ8K3MNPQRSTVWXYZ0AB",
      lastReadDseq: 1,
      ackHighWater: 1,
    });
    await reopened.close();
  });

  it("distinguishes coalesced updates from redelivery metadata and deduplicates event ids", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.beginProtocolDeliveryEpoch("codex", "epoch-1");
    const delivery = (dseq: number, text: string) =>
      store.recordProtocolDelivery({
        agentId: "codex",
        ackEpoch: "epoch-1",
        dseq,
        eventKey: "message:msg-1",
        eventType: "message.reply",
        traceId: "trace-1",
        messageId: "msg-1",
        raw: { version: "2", event: "message.reply", trace_id: "trace-1", dseq, payload: { text } },
      });

    await expect(delivery(1, "draft")).resolves.toBe("inserted");
    await expect(delivery(2, "draft")).resolves.toBe("duplicate");
    await expect(delivery(3, "final")).resolves.toBe("updated");

    const message = (text: string) => ({
      agentId: "codex",
      direction: "inbound" as const,
      kind: "message" as const,
      eventType: "message.reply",
      traceId: "trace-1",
      chatId: "chat-1",
      messageId: "msg-1",
      text,
      raw: { payload: { text } },
    });
    await expect(store.upsertInboundMessage(message("draft"))).resolves.toBe("inserted");
    await expect(store.upsertInboundMessage(message("draft"))).resolves.toBe("duplicate");
    await expect(store.hasHandledInboundMessage("codex", "msg-1", message("draft").raw)).resolves.toBe(false);
    await expect(store.listUnhandledInboundMessages("codex")).resolves.toEqual([message("draft").raw]);
    await store.markInboundMessageHandled("codex", "msg-1", message("draft").raw);
    await expect(store.hasHandledInboundMessage("codex", "msg-1", message("draft").raw)).resolves.toBe(true);
    await expect(store.listUnhandledInboundMessages("codex")).resolves.toEqual([]);
    await expect(store.upsertInboundMessage(message("final"))).resolves.toBe("updated");
    await expect(store.hasHandledInboundMessage("codex", "msg-1", message("final").raw)).resolves.toBe(false);
    await expect(store.listUnhandledInboundMessages("codex")).resolves.toEqual([message("final").raw]);
    await store.markInboundMessageHandled("codex", "msg-1", message("final").raw);
    await store.markInboundMessageHandled("codex", "msg-1", message("draft").raw);
    await expect(store.hasHandledInboundMessage("codex", "msg-1", message("final").raw)).resolves.toBe(true);
    await expect(store.listUnhandledInboundMessages("codex")).resolves.toEqual([]);
    await expect(store.hasProtocolEvent("codex", "event-1")).resolves.toBe(false);
    await expect(store.claimProtocolEvent("codex", "event-1")).resolves.toBe(true);
    await expect(store.hasProtocolEvent("codex", "event-1")).resolves.toBe(true);
    await expect(store.claimProtocolEvent("codex", "event-1")).resolves.toBe(false);
    await store.close();
    const reopened = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await expect(reopened.hasProtocolEvent("codex", "event-1")).resolves.toBe(true);
    await expect(reopened.claimProtocolEvent("codex", "event-1")).resolves.toBe(false);
    await reopened.close();
  });

  it("quarantines an unpersistable Protocol v2 frame without stalling its dseq", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.beginProtocolDeliveryEpoch("codex", "epoch-poison");

    await store.quarantineProtocolDelivery({
      agentId: "codex",
      ackEpoch: "epoch-poison",
      dseq: 1,
      eventType: "message.send",
      traceId: "poison-1",
      raw: { version: "2", event: "message.send", dseq: 1, payload: {} },
      error: "invalid message.send payload",
    });

    await expect(store.getProtocolDeliveryState("codex")).resolves.toMatchObject({
      lastReadDseq: 1,
      ackHighWater: 1,
    });
    await expect(store.listProtocolDeliveryQuarantine("codex")).resolves.toEqual([
      expect.objectContaining({
        ackEpoch: "epoch-poison",
        dseq: 1,
        traceId: "poison-1",
        error: "invalid message.send payload",
      }),
    ]);
    await store.close();
  });

  it("stores activation per local agent and exposes previous user id", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.upsertActivation({
      localAgentId: "codex",
      accessToken: "token-codex",
      refreshToken: null,
      serverAgentId: "agt-codex",
      userId: "usr-codex",
      ownerUserId: "usr-owner",
      conversationId: "chat-owner",
    });
    await store.upsertActivation({
      localAgentId: "claude",
      accessToken: "token-claude",
      refreshToken: null,
      serverAgentId: "agt-claude",
      userId: "usr-claude",
      ownerUserId: "usr-owner",
      conversationId: null,
    });
    await expect(store.getActivation("codex")).resolves.toMatchObject({
      userId: "usr-codex",
      accessToken: "token-codex",
    });
    await expect(store.getActivationUserId("claude")).resolves.toBe("usr-claude");
    await store.close();
  });
  it("stores global Projects and associates a Session with at most one Project", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    const project = await store.insertProject({
      projectId: "project-1",
      name: "work",
      rootPath: "/repo",
      additionalDirectories: ["/shared"],
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      projectId: project.projectId,
      isCurrent: true,
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      projectId: "project-1",
    });
    await expect(store.getProject("work")).resolves.toMatchObject({
      projectId: "project-1",
      rootPath: "/repo",
      additionalDirectories: ["/shared"],
    });
    await expect(store.countRuntimeSessionsForProject("project-1")).resolves.toBe(1);
    await store.close();
  });
  it("scopes current Sessions by Agent Binding while keeping Projects global", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.upsertRuntimeSession({ chatId: "chat-1", sessionId: "shared-id", agentId: "work" });
    await store.upsertRuntimeSession({ chatId: "chat-1", sessionId: "shared-id", agentId: "personal" });

    await expect(store.getCurrentRuntimeSession("chat-1", "work")).resolves.toMatchObject({ agentId: "work" });
    await expect(store.getCurrentRuntimeSession("chat-1", "personal")).resolves.toMatchObject({
      agentId: "personal",
    });
    await expect(store.listRuntimeSessions("chat-1", "work")).resolves.toHaveLength(1);
    await expect(store.listRuntimeSessions("chat-1", "personal")).resolves.toHaveLength(1);
    await store.close();
  });

  it("keeps a Session Intent mutually exclusive with the current Session", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    const project = await store.insertProject({
      projectId: "project-1",
      name: "work",
      rootPath: "/repo",
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-before",
      agentId: "codex",
    });

    await store.setSessionIntent({
      chatId: "chat-1",
      agentId: "codex",
      projectId: project.projectId,
      name: "Planned work",
      mode: "read-only",
    });

    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toBeNull();
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      projectId: "project-1",
      name: "Planned work",
      mode: "read-only",
    });

    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-after",
      agentId: "codex",
      projectId: project.projectId,
      name: "Planned work",
      mode: "read-only",
    });

    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toBeNull();
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      sessionId: "session-after",
      hasMessages: true,
    });
    await store.close();
  });

  it("persists model selection from Session Intent into a materialized Session", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath });

    await store.setSessionIntent({
      chatId: "chat-model",
      agentId: "codex",
      projectId: null,
      name: "Deep review",
      mode: "workspace-write",
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
    });
    await expect(store.getSessionIntent("chat-model", "codex")).resolves.toMatchObject({
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
    });

    await store.upsertRuntimeSession({
      chatId: "chat-model",
      sessionId: "session-model",
      agentId: "codex",
      projectId: null,
      name: "Deep review",
      mode: "workspace-write",
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
    });
    await store.close();

    const reopened = createStateStore({ dbPath });
    await expect(reopened.getCurrentRuntimeSession("chat-model", "codex")).resolves.toMatchObject({
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
    });
    await reopened.close();
  });

  it("atomically materializes one Session for concurrent first messages", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.setSessionIntent({
      chatId: "chat-race",
      agentId: "codex",
      projectId: null,
      name: "Planned",
      mode: "read-only",
      model: "gpt-planned",
      reasoningEffort: "high",
    });

    const [first, second] = await Promise.all([
      store.resolveOrMaterializeRuntimeSession({ chatId: "chat-race", agentId: "codex", sessionId: "first" }),
      store.resolveOrMaterializeRuntimeSession({ chatId: "chat-race", agentId: "codex", sessionId: "second" }),
    ]);

    expect(first.sessionId).toBe(second.sessionId);
    expect(first).toMatchObject({
      name: "Planned",
      mode: "read-only",
      model: "gpt-planned",
      reasoningEffort: "high",
    });
    await expect(store.listRuntimeSessions("chat-race", "codex")).resolves.toHaveLength(1);
    await expect(store.getSessionIntent("chat-race", "codex")).resolves.toBeNull();
    await store.close();
  });

  it("updates the runtime thread id for one logical session", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.upsertRuntimeSession({ chatId: "chat-1", sessionId: "old", agentId: "codex", isCurrent: false });
    await store.upsertRuntimeSession({ chatId: "chat-1", sessionId: "current", agentId: "codex", isCurrent: true });

    await expect(store.setRuntimeSessionId("chat-1", "codex", "old", "thread-old")).resolves.toBe(true);
    await expect(store.setRuntimeSessionId("chat-1", "codex", "missing", "thread-missing")).resolves.toBe(false);
    await expect(store.listRuntimeSessions("chat-1", "codex")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "old", runtimeSessionId: "thread-old", isCurrent: false }),
        expect.objectContaining({ sessionId: "current", runtimeSessionId: null, isCurrent: true }),
      ]),
    );
    await store.close();
  });

  it("updates Session model fields without overwriting a concurrently assigned Runtime Thread", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.upsertRuntimeSession({
      chatId: "chat-model-update",
      sessionId: "session-model-update",
      agentId: "codex",
      model: "gpt-old",
      reasoningEffort: "medium",
    });
    await store.setRuntimeSessionId("chat-model-update", "codex", "session-model-update", "thread-concurrent");

    await expect(
      store.setRuntimeSessionModelSelection("chat-model-update", "codex", "session-model-update", "gpt-new", "high"),
    ).resolves.toBe(true);
    await expect(store.getCurrentRuntimeSession("chat-model-update", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-concurrent",
      model: "gpt-new",
      reasoningEffort: "high",
    });
    await store.close();
  });

  it("allocates stable 8-character Session Refs and preserves a discovered Ref when adopting its thread", async () => {
    const dir = await tempDir();
    const generated = ["23456789", "23456789", "ABCDEFGH", "JKLMNPQR"];
    const store = createStateStore({
      dbPath: join(dir, "state.sqlite"),
      sessionRefFactory: () => generated.shift() ?? "STUVWXYZ",
    });

    const discoveredRef = await store.getOrCreateSessionRef({
      chatId: "chat-1",
      agentId: "codex",
      runtimeSessionId: "thread-discovered",
    });
    const otherRef = await store.getOrCreateSessionRef({
      chatId: "chat-1",
      agentId: "codex",
      runtimeSessionId: "thread-other",
    });
    expect(discoveredRef).toBe("23456789");
    expect(otherRef).toBe("ABCDEFGH");

    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-imported",
      agentId: "codex",
      runtimeSessionId: "thread-discovered",
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      sessionRef: discoveredRef,
      runtimeSessionId: "thread-discovered",
    });

    await store.setRuntimeSessionId("chat-1", "codex", "session-imported", null);
    await expect(
      store.getOrCreateSessionRef({
        chatId: "chat-1",
        agentId: "codex",
        runtimeSessionId: "thread-discovered",
      }),
    ).resolves.toBe("JKLMNPQR");
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      sessionRef: discoveredRef,
      runtimeSessionId: null,
    });

    await store.close();
    const reopened = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await expect(reopened.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      sessionRef: discoveredRef,
    });
    await reopened.close();
  });

  it("backfills Session Refs when opening a database created by an earlier version", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(
      "CREATE TABLE runtime_sessions(chat_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, runtime_session_id TEXT, project_id TEXT, name TEXT, mode TEXT, is_current INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, agent_id, session_id)); INSERT INTO runtime_sessions VALUES ('chat-1', 'session-1', 'codex', 'thread-1', NULL, 'Legacy Session', NULL, 1, 1, 1);",
    );
    legacy.close();

    const store = createStateStore({ dbPath });
    const current = await store.getCurrentRuntimeSession("chat-1", "codex");
    expect(current).toMatchObject({ name: "Legacy Session", runtimeSessionId: "thread-1" });
    expect(current?.hasMessages).toBe(true);
    expect(current?.sessionRef).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u);
    await store.close();
  });

  it("migrates the current legacy empty Session to an Intent and removes empty history", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(
      "CREATE TABLE runtime_sessions(chat_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, runtime_session_id TEXT, project_id TEXT, name TEXT, mode TEXT, is_current INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, agent_id, session_id)); INSERT INTO runtime_sessions VALUES ('chat-1', 'materialized', 'codex', 'thread-1', NULL, 'Existing work', NULL, 0, 1, 1); INSERT INTO runtime_sessions VALUES ('chat-1', 'empty-history', 'codex', NULL, NULL, NULL, NULL, 0, 2, 2); INSERT INTO runtime_sessions VALUES ('chat-1', 'empty-current', 'codex', NULL, NULL, 'Planned work', 'read-only', 1, 3, 3);",
    );
    legacy.close();

    const store = createStateStore({ dbPath });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toBeNull();
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      name: "Planned work",
      mode: "read-only",
      projectId: null,
    });
    await expect(store.listRuntimeSessions("chat-1", "codex")).resolves.toEqual([
      expect.objectContaining({
        sessionId: "materialized",
        runtimeSessionId: "thread-1",
        hasMessages: true,
      }),
    ]);
    await store.close();
  });

  it("keeps transcript projection updates idempotent and rekeys optimistic user messages", async () => {
    const dir = await tempDir();
    const store = createStateStore({
      dbPath: join(dir, "state.sqlite"),
      sessionRefFactory: () => "ABCDEFGH",
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      runtimeSessionId: "thread-1",
      hasMessages: true,
    });
    const session = await store.getCurrentRuntimeSession("chat-1", "codex");
    if (!session) throw new Error("test session was not created");
    const assistant = {
      id: "b_stable_assistant",
      type: "message" as const,
      origin: "runtime" as const,
      state: "complete" as const,
      plainText: "done",
      role: "assistant" as const,
      author: "Agent",
      markdown: "done",
    };
    const inserted = await store.upsertTranscriptBlock(session.sessionRef, assistant);
    const repeated = await store.upsertTranscriptBlock(session.sessionRef, assistant);
    expect(inserted.cursor).toBeGreaterThan(0);
    expect(repeated.cursor).toBe(0);
    expect(await store.listClientEvents(0)).toHaveLength(1);

    const optimistic = await store.upsertTranscriptBlock(session.sessionRef, {
      id: "turn_local_user",
      type: "message",
      origin: "client",
      state: "complete",
      plainText: "same prompt",
      role: "user",
      author: "You",
      markdown: "same prompt",
    });
    const rekeyed = await store.rekeyMatchingTranscriptBlock(session.sessionRef, {
      id: "b_native_user",
      type: "message",
      origin: "runtime",
      state: "complete",
      plainText: "same prompt",
      role: "user",
      author: "You",
      markdown: "same prompt",
    });
    expect(rekeyed).toMatchObject({ id: "b_native_user", origin: "client", sequence: optimistic.block.sequence });
    expect(await store.listTranscriptBlocks(session.sessionRef)).toEqual([
      expect.objectContaining({ id: "b_stable_assistant" }),
      expect.objectContaining({ id: "b_native_user", origin: "client" }),
    ]);
    await store.rekeyMatchingTranscriptBlock(session.sessionRef, {
      id: "b_native_user",
      type: "message",
      origin: "runtime",
      state: "complete",
      plainText: "same prompt",
      role: "user",
      author: "You",
      markdown: "same prompt",
    });
    await store.upsertTranscriptBlock(session.sessionRef, {
      id: "b_native_user",
      type: "message",
      origin: "runtime",
      state: "complete",
      plainText: "same prompt",
      role: "user",
      author: "You",
      markdown: "same prompt",
    });
    expect(await store.listTranscriptBlocks(session.sessionRef)).toContainEqual(
      expect.objectContaining({ id: "b_native_user", origin: "client" }),
    );

    const live = await store.upsertTranscriptBlock(session.sessionRef, {
      id: "b_live_reply",
      type: "message",
      origin: "runtime",
      runtimeSource: "live",
      state: "complete",
      plainText: "same reply",
      role: "assistant",
      author: "Agent",
      markdown: "same reply",
    });
    const historical = {
      id: "b_history_reply",
      type: "message" as const,
      origin: "runtime" as const,
      runtimeSource: "history" as const,
      state: "complete" as const,
      plainText: "same reply",
      role: "assistant" as const,
      author: "Agent",
      markdown: "same reply",
    };
    await store.upsertTranscriptBlock(session.sessionRef, historical);
    const consolidated = await store.rekeyMatchingTranscriptBlock(session.sessionRef, historical);
    expect(consolidated).toMatchObject({
      id: "b_history_reply",
      runtimeSource: "history",
      sequence: live.block.sequence,
    });
    expect(await store.listTranscriptBlocks(session.sessionRef)).toEqual([
      expect.objectContaining({ id: "b_stable_assistant" }),
      expect.objectContaining({ id: "b_native_user", origin: "client" }),
      expect.objectContaining({ id: "b_history_reply", runtimeSource: "history" }),
    ]);
    await store.close();
  });

  it("deletes a Session Ref together with its managed Session and transcript projection", async () => {
    const dir = await tempDir();
    const store = createStateStore({
      dbPath: join(dir, "state.sqlite"),
      sessionRefFactory: () => "ABCDEFGH",
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      runtimeSessionId: "thread-1",
      hasMessages: true,
    });
    const session = await store.getCurrentRuntimeSession("chat-1", "codex");
    if (!session) throw new Error("test session was not created");
    await store.upsertTranscriptBlock(session.sessionRef, {
      id: "message-1",
      type: "message",
      origin: "runtime",
      state: "complete",
      plainText: "hello",
      role: "user",
      author: "You",
      markdown: "hello",
    });

    await expect(store.deleteSessionByRef(session.sessionRef)).resolves.toBe(true);

    await expect(store.getSessionRefTarget(session.sessionRef)).resolves.toBeNull();
    await expect(store.getRuntimeSessionByRef(session.sessionRef)).resolves.toBeNull();
    await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toEqual([]);
    await expect(store.deleteSessionByRef(session.sessionRef)).resolves.toBe(false);
    await store.close();
  });

  it("tracks runtime status independently for every Agent Binding", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: "codex",
      activeChats: 1,
      globalRunning: 1,
      globalQueued: 0,
      recentError: null,
    });
    await store.upsertRuntimeStatus({
      websocketConnected: false,
      activeAgent: "claude",
      activeChats: 2,
      globalRunning: 0,
      globalQueued: 1,
      recentError: "offline",
    });
    await expect(store.getRuntimeStatus("codex")).resolves.toMatchObject({
      websocketConnected: true,
      activeAgent: "codex",
      activeChats: 1,
    });
    await store.setRuntimeConnectionStatus("codex", false, "reconnecting");
    await expect(store.getRuntimeStatus("codex")).resolves.toMatchObject({
      websocketConnected: false,
      activeChats: 1,
      globalRunning: 1,
      recentError: "reconnecting",
    });
    await expect(store.getRuntimeStatus("claude")).resolves.toMatchObject({
      websocketConnected: false,
      activeAgent: "claude",
      activeChats: 2,
      recentError: "offline",
    });
    await store.close();
  });
});
