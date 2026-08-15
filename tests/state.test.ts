import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";

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
  it("persists authoritative group settings snapshots per Agent Binding", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath });

    await store.replaceGroupSettingsSnapshot("work", [
      {
        conversationId: "shared-group",
        muted: false,
        replyMode: "all",
        batchDelaySeconds: 60,
        version: 4,
      },
      {
        conversationId: "removed-group",
        muted: true,
        replyMode: "mention",
        batchDelaySeconds: 5,
        version: 2,
      },
    ]);
    await store.replaceGroupSettingsSnapshot("personal", [
      {
        conversationId: "shared-group",
        muted: true,
        replyMode: "mention",
        batchDelaySeconds: 0,
        version: 9,
      },
    ]);
    await store.replaceGroupSettingsSnapshot("work", [
      {
        conversationId: "shared-group",
        muted: false,
        replyMode: "all",
        batchDelaySeconds: 5,
        version: 5,
      },
    ]);
    await store.markGroupSettingsSnapshotStale("work");
    await store.close();

    const reopened = createStateStore({ dbPath });
    await expect(reopened.getGroupSettingsSnapshot("work")).resolves.toEqual({
      authoritative: true,
      stale: true,
      rows: [
        {
          conversationId: "shared-group",
          muted: false,
          replyMode: "all",
          batchDelaySeconds: 5,
          version: 5,
        },
      ],
    });
    await expect(reopened.getGroupSettingsSnapshot("personal")).resolves.toEqual({
      authoritative: true,
      stale: false,
      rows: [
        {
          conversationId: "shared-group",
          muted: true,
          replyMode: "mention",
          batchDelaySeconds: 0,
          version: 9,
        },
      ],
    });

    await reopened.replaceGroupSettingsSnapshot("work", []);
    await expect(reopened.getGroupSettingsSnapshot("work")).resolves.toEqual({
      authoritative: true,
      stale: false,
      rows: [],
    });
    await reopened.close();
  });

  it("scopes output visibility by Agent Binding and migrates legacy overrides", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const initial = createStateStore({ dbPath });
    await initial.upsertActivation({
      localAgentId: "work",
      accessToken: "work-token",
      refreshToken: null,
      serverAgentId: "work-agent",
      userId: "work-user",
      ownerUserId: "owner",
      conversationId: null,
    });
    await initial.upsertActivation({
      localAgentId: "personal",
      accessToken: "personal-token",
      refreshToken: null,
      serverAgentId: "personal-agent",
      userId: "personal-user",
      ownerUserId: "owner",
      conversationId: null,
    });
    await initial.close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE output_visibility;
      CREATE TABLE output_visibility(
        chat_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO output_visibility(chat_id, mode, updated_at) VALUES ('shared-chat', 'full', 1);
    `);
    legacy.close();

    const migrated = createStateStore({ dbPath });
    await expect(migrated.getOutputVisibility("work", "shared-chat")).resolves.toBe("full");
    await expect(migrated.getOutputVisibility("personal", "shared-chat")).resolves.toBe("full");
    await migrated.setOutputVisibility("work", "shared-chat", "minimal");
    await expect(migrated.getOutputVisibility("work", "shared-chat")).resolves.toBe("minimal");
    await expect(migrated.getOutputVisibility("personal", "shared-chat")).resolves.toBe("full");
    await migrated.close();
  });

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

  it("deduplicates reordered protocol delivery content recursively", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    const original = {
      version: "2",
      event: "message.reply",
      trace_id: "trace-original",
      emitted_at: 1,
      dseq: 1,
      payload: {
        message_id: "msg-reordered",
        message: {
          body: { fragments: [{ kind: "text", text: "same content" }] },
          context: { mentions: [], reply: null },
        },
      },
    };
    const reordered = {
      payload: {
        message: {
          context: { reply: null, mentions: [] },
          body: { fragments: [{ text: "same content", kind: "text" }] },
        },
        message_id: "msg-reordered",
      },
      dseq: 2,
      emitted_at: 2,
      trace_id: "trace-replay",
      event: "message.reply",
      version: "2",
    };
    const input = (raw: typeof original | typeof reordered) => ({
      agentId: "codex",
      direction: "inbound" as const,
      kind: "message" as const,
      eventType: "message.reply",
      traceId: raw.trace_id,
      chatId: "chat-reordered",
      messageId: "msg-reordered",
      text: "same content",
      raw,
    });

    await expect(store.upsertInboundMessage(input(original))).resolves.toBe("inserted");
    await store.markInboundMessageHandled("codex", "msg-reordered", original);
    await expect(store.upsertInboundMessage(input(reordered))).resolves.toBe("duplicate");
    await expect(store.hasHandledInboundMessage("codex", "msg-reordered", reordered)).resolves.toBe(true);

    await store.close();
  });

  it("marks a batch atomically and exposes only mention-context discards", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    const inbound = (messageId: string, text: string) => ({
      agentId: "codex",
      direction: "inbound" as const,
      kind: "message" as const,
      eventType: "message.send",
      traceId: `trace-${messageId}`,
      chatId: "group-1",
      messageId,
      text,
      raw: { messageId, text },
    });
    const mentionContext = inbound("context", "eligible context");
    const muted = inbound("muted", "muted content");
    const oversized = inbound("oversized", "oversized content");
    for (const message of [mentionContext, muted, oversized]) await store.upsertInboundMessage(message);
    await store.markInboundMessageHandled("codex", mentionContext.messageId, mentionContext.raw, "mention-context");
    await store.markInboundMessageHandled("codex", muted.messageId, muted.raw, "muted");
    await store.markInboundMessageHandled("codex", oversized.messageId, oversized.raw, "oversized");
    await expect(store.listRecentGroupContext("codex", "group-1", "later", 10)).resolves.toEqual([mentionContext.raw]);

    const boundedContext = Array.from({ length: 12 }, (_, index) =>
      inbound(`bounded-${index}`, `bounded context ${index}`),
    );
    for (const message of boundedContext) {
      await store.upsertInboundMessage(message);
      await store.markInboundMessageHandled("codex", message.messageId, message.raw, "mention-context");
    }
    const current = inbound("current", "current addressed message");
    await store.upsertInboundMessage(current);
    await expect(store.listRecentGroupContext("codex", "group-1", current.messageId, 10)).resolves.toEqual(
      boundedContext.slice(2).map((message) => message.raw),
    );

    const first = inbound("batch-first", "first");
    await store.upsertInboundMessage(first);
    await expect(
      store.markInboundMessagesHandled(
        "codex",
        [
          { messageId: first.messageId, raw: first.raw },
          { messageId: "missing", raw: { messageId: "missing" } },
        ],
        "runtime",
      ),
    ).rejects.toThrow("inbound message was not persisted before handling: missing");
    await expect(store.hasHandledInboundMessage("codex", first.messageId, first.raw)).resolves.toBe(false);
    await store.close();
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
    });
    await expect(store.countRuntimeSessionsForProject("project-1")).resolves.toBe(1);
    await store.close();
  });
  it("removes persisted Project additional directories from an earlier database", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(`
      CREATE TABLE projects(
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        root_path TEXT NOT NULL UNIQUE,
        additional_directories_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO projects VALUES ('project-legacy', 'legacy', '/repo', '["/shared"]', 1, 1);
    `);
    legacy.close();

    const store = createStateStore({ dbPath });
    await expect(store.getProject("project-legacy")).resolves.toEqual({
      projectId: "project-legacy",
      name: "legacy",
      rootPath: "/repo",
      createdAt: 1,
      updatedAt: 1,
    });
    await store.close();

    const migrated = new Database(dbPath);
    const columns = migrated.query<{ name: string }, []>("PRAGMA table_info(projects)").all();
    expect(columns.map((column) => column.name)).not.toContain("additional_directories_json");
    migrated.close();
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

  it("migrates the singleton Liveware Exposure without reactivation", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(`
      CREATE TABLE liveware_exposure(
        id INTEGER PRIMARY KEY CHECK(id = 1),
        owner_user_id TEXT NOT NULL,
        local_agent_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        public_url TEXT NOT NULL,
        access_policy TEXT NOT NULL CHECK(access_policy IN ('private', 'public')),
        updated_at INTEGER NOT NULL
      );
      INSERT INTO liveware_exposure VALUES (
        1,
        'owner-existing',
        'codex',
        'app-existing',
        'https://app-existing.apps.example',
        'private',
        1
      );
    `);
    legacy.close();

    const store = createStateStore({ dbPath });
    await expect(store.listLivewareExposures()).resolves.toEqual([
      {
        ownerUserId: "owner-existing",
        localAgentId: "codex",
        appId: "app-existing",
        publicUrl: "https://app-existing.apps.example",
        accessPolicy: "private",
      },
    ]);
    await store.close();
  });

  it("upgrades the pre-Project runtime Session schema without replacing local state", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(
      "CREATE TABLE runtime_sessions(chat_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, runtime_session_id TEXT, name TEXT, mode TEXT, cwd TEXT, is_current INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, session_id)); INSERT INTO runtime_sessions VALUES ('chat-1', 'session-1', 'codex', 'thread-1', 'Legacy Session', NULL, '/legacy/workspace', 1, 1, 1);",
    );
    legacy.close();

    const store = createStateStore({ dbPath });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      name: "Legacy Session",
      projectId: null,
      runtimeSessionId: "thread-1",
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      runtimeSessionId: "thread-1",
      projectId: null,
      name: "Migrated Session",
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      name: "Migrated Session",
      projectId: null,
    });
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

  it("preserves empty Sessions created by the schema that defines binding locking", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const initial = createStateStore({ dbPath });
    await initial.setSessionIntent({
      chatId: "chat-fresh",
      agentId: "codex",
      projectId: null,
      name: "Fresh empty Session",
    });
    await initial.resolveOrMaterializeRuntimeSession({
      chatId: "chat-fresh",
      agentId: "codex",
      sessionId: "empty-fresh",
      acceptedTurn: false,
    });
    await initial.close();

    const reopened = createStateStore({ dbPath });
    await expect(reopened.getCurrentRuntimeSession("chat-fresh", "codex")).resolves.toMatchObject({
      sessionId: "empty-fresh",
      name: "Fresh empty Session",
      hasMessages: false,
    });
    await expect(reopened.getSessionIntent("chat-fresh", "codex")).resolves.toBeNull();
    await reopened.close();
  });

  it("rolls back every legacy empty Session migration step and retries after an injected failure", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const bootstrap = createStateStore({ dbPath });
    await bootstrap.initialize();
    await bootstrap.close();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE runtime_sessions;
      CREATE TABLE runtime_sessions(
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        runtime_session_id TEXT,
        name TEXT,
        mode TEXT,
        is_current INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, agent_id, session_id)
      );
      INSERT INTO runtime_sessions VALUES (
        'chat-retry', 'empty-current', 'codex', NULL, 'Retry me', 'read-only', 1, 1, 1
      );
      INSERT INTO runtime_sessions VALUES (
        'chat-message', 'message-backed', 'codex', NULL, 'Keep me', NULL, 1, 1, 1
      );
      INSERT INTO clawchat_messages(
        platform, local_agent_id, kind, direction, event_type, chat_id, message_id, text, created_at
      ) VALUES (
        'clawchat-connect', 'codex', 'message', 'inbound', 'message.created',
        'chat-message', 'message-1', 'hello', 2
      );
      CREATE TRIGGER fail_legacy_intent_migration
      BEFORE INSERT ON session_intents
      BEGIN
        SELECT RAISE(ABORT, 'injected legacy migration failure');
      END;
    `);
    legacy.close();

    const interrupted = createStateStore({ dbPath });
    await expect(interrupted.initialize()).rejects.toThrow("injected legacy migration failure");
    const afterFailure = new Database(dbPath);
    const columnsAfterFailure = afterFailure
      .query<{ name: string }, []>("PRAGMA table_info(runtime_sessions)")
      .all()
      .map((column) => column.name);
    expect(columnsAfterFailure).not.toContain("binding_locked");
    expect(
      afterFailure.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runtime_sessions").get()?.count,
    ).toBe(2);
    expect(
      afterFailure.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_intents").get()?.count,
    ).toBe(0);
    afterFailure.exec("DROP TRIGGER fail_legacy_intent_migration");
    afterFailure.close();

    const retried = createStateStore({ dbPath });
    await expect(retried.getCurrentRuntimeSession("chat-retry", "codex")).resolves.toBeNull();
    await expect(retried.getSessionIntent("chat-retry", "codex")).resolves.toMatchObject({
      name: "Retry me",
      mode: "read-only",
    });
    await expect(retried.getCurrentRuntimeSession("chat-message", "codex")).resolves.toMatchObject({
      sessionId: "message-backed",
      hasMessages: true,
    });
    await retried.close();
  });

  it("keeps transcript projection updates idempotent and rekeys explicit Runtime Activity aliases", async () => {
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
    const rekeyed = await store.rekeyTranscriptBlock(session.sessionRef, "turn_local_user", {
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
    await store.rekeyTranscriptBlock(session.sessionRef, "turn_local_user", {
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
    const consolidated = await store.rekeyTranscriptBlock(session.sessionRef, "b_live_reply", historical);
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

  it("bounds Client Event history and reports an expired cursor without reusing cursors", async () => {
    const dir = await tempDir();
    const store = createStateStore({
      dbPath: join(dir, "state.sqlite"),
      sessionRefFactory: () => "EVNTREF2",
      clientEventRetentionLimit: 3,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-events",
      sessionId: "session-events",
      agentId: "codex",
      runtimeSessionId: "thread-events",
      hasMessages: true,
    });
    const session = await store.getCurrentRuntimeSession("chat-events", "codex");
    if (!session) throw new Error("test session was not created");
    const cursors: number[] = [];
    for (let revision = 1; revision <= 5; revision += 1) {
      const result = await store.upsertTranscriptBlock(session.sessionRef, {
        id: "changing-block",
        type: "message",
        origin: "runtime",
        state: "complete",
        plainText: `revision ${revision}`,
        role: "assistant",
        author: "Agent",
        markdown: `revision ${revision}`,
      });
      cursors.push(result.cursor);
    }

    expect(cursors).toEqual([...cursors].sort((left, right) => left - right));
    await expect(store.listClientEvents(cursors[1] ?? 0)).resolves.toMatchObject([
      { event: { previousCursor: cursors[1], type: "transcript.block-upserted" } },
      { event: { type: "transcript.block-upserted" } },
      { event: { type: "transcript.block-upserted" } },
    ]);
    await expect(store.listClientEvents(cursors[0] ?? 0)).resolves.toMatchObject([
      {
        cursor: cursors[4],
        event: { cursor: cursors[4], previousCursor: cursors[0], type: "snapshot-required", reason: "cursor-expired" },
      },
    ]);
    expect(await store.getClientEventCursor()).toBe(cursors[4]);
    await store.close();
  });

  it("keeps an oversized Transcript block authoritative without duplicating it into Client Events", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite"), sessionRefFactory: () => "LARGREF2" });
    await store.upsertRuntimeSession({
      chatId: "chat-large-event",
      sessionId: "session-large-event",
      agentId: "codex",
      runtimeSessionId: "thread-large-event",
      hasMessages: true,
    });
    const session = await store.getCurrentRuntimeSession("chat-large-event", "codex");
    if (!session) throw new Error("test session was not created");
    const text = "large transcript content ".repeat(8_000);

    const inserted = await store.upsertTranscriptBlock(session.sessionRef, {
      id: "large-block",
      type: "message",
      origin: "runtime",
      state: "complete",
      plainText: text,
      role: "assistant",
      author: "Agent",
      markdown: text,
    });

    await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toMatchObject([{ plainText: text }]);
    await expect(store.listClientEvents(0)).resolves.toMatchObject([
      {
        cursor: inserted.cursor,
        event: { cursor: inserted.cursor, type: "snapshot-required", reason: "revision-gap" },
      },
    ]);
    await store.close();
  });

  it("deduplicates legacy Subagent blocks and reclaims their freed database pages on reopen", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const createStore = () =>
      createStateStore({
        dbPath,
        sessionRefFactory: () => "BNDREF23",
        storageCompactionThresholdBytes: 1,
      });
    let store = createStore();
    await store.upsertRuntimeSession({
      chatId: "chat-legacy-subagent",
      sessionId: "session-legacy-subagent",
      agentId: "codex",
      runtimeSessionId: "thread-legacy-subagent",
      hasMessages: true,
    });
    const session = await store.getCurrentRuntimeSession("chat-legacy-subagent", "codex");
    if (!session) throw new Error("test session was not created");
    const repeatedText = "legacy nested output ".repeat(600);
    await store.upsertTranscriptBlock(session.sessionRef, {
      id: "legacy-subagent",
      type: "subagent",
      origin: "runtime",
      state: "complete",
      plainText: "Legacy worker",
      title: "Legacy worker",
      role: null,
      activityKind: "interacted",
      blocks: Array.from({ length: 100 }, (_, index) => ({
        id: "legacy-child",
        type: "message" as const,
        origin: "runtime" as const,
        state: "complete" as const,
        plainText: `${repeatedText}${index}`,
        role: "assistant" as const,
        author: "Agent",
        markdown: `${repeatedText}${index}`,
      })),
    });
    await store.close();
    const legacyDatabase = new Database(dbPath);
    legacyDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    legacyDatabase.exec("PRAGMA auto_vacuum = NONE");
    legacyDatabase.exec("VACUUM");
    legacyDatabase.close();
    const beforeBytes = (await stat(dbPath)).size;

    store = createStore();
    const [bounded] = await store.listTranscriptBlocks(session.sessionRef);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(50_000);
    expect(JSON.stringify(bounded).match(/legacy-child/gu)).toHaveLength(1);
    expect(JSON.stringify(bounded)).toContain(`${repeatedText}99`);
    await store.close();
    const afterCheckpoint = new Database(dbPath);
    afterCheckpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(afterCheckpoint.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(2);
    afterCheckpoint.close();
    expect((await stat(dbPath)).size).toBeLessThan(beforeBytes);
  });

  it("backfills an opaque ClawChat sender id with its resolved display name", async () => {
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
      origin: "clawchat",
      state: "complete",
      plainText: "commit",
      role: "user",
      author: "usr_owner",
      sender: { id: "usr_owner", displayName: "usr_owner" },
      conversationType: "direct",
      markdown: "commit",
    });

    await expect(store.updateTranscriptSenderDisplayName("usr_owner", "ColinShen")).resolves.toBe(1);
    await expect(store.listTranscriptBlocks(session.sessionRef)).resolves.toEqual([
      expect.objectContaining({
        author: "ColinShen",
        sender: { id: "usr_owner", displayName: "ColinShen" },
      }),
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

  it("waits for a transient external writer instead of failing the Connect Service", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const store = createStateStore({ dbPath });
    await store.initialize();
    const holder = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures", "sqlite-lock-holder.ts"), dbPath, "250"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = holder.stdout.getReader();
    const started = await reader.read();
    expect(new TextDecoder().decode(started.value).trim()).toBe("locked");

    await expect(
      store.upsertRuntimeStatus({
        websocketConnected: true,
        activeAgent: "codex",
        activeChats: 0,
        globalRunning: 0,
        globalQueued: 0,
        recentError: null,
      }),
    ).resolves.toBeUndefined();
    expect(await holder.exited).toBe(0);
    await store.close();
  });

  it("keeps a cancelled Turn Submission terminal across a state-store restart", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const first = createStateStore({ dbPath });
    await expect(first.cancelTurnSubmission("submission-restart", "NKEP79B8")).resolves.toBe(true);
    await first.close();

    const restarted = createStateStore({ dbPath });
    await expect(restarted.isTurnSubmissionCancelled("submission-restart", "NKEP79B8")).resolves.toBe(true);
    await expect(restarted.cancelTurnSubmission("submission-restart", "OTHER123")).resolves.toBe(false);
    await restarted.close();
  });

  it("claims each Tool Request once and returns the settled record for a reused request id", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.submitToolRequest({
      requestId: "request-1",
      bindingId: "codex",
      toolName: "clawchat_get_account_profile",
      normalizedInput: {},
      timeoutMs: 30_000,
    });
    await expect(store.claimNextToolRequest("codex")).resolves.toMatchObject({
      requestId: "request-1",
      state: "running",
    });
    await expect(store.claimNextToolRequest("codex")).resolves.toBeNull();
    await store.settleToolRequest("request-1", { state: "succeeded", result: { nickname: "Agent" } });
    await expect(
      store.submitToolRequest({
        requestId: "request-1",
        bindingId: "codex",
        toolName: "clawchat_get_account_profile",
        normalizedInput: {},
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({
      state: "succeeded",
      result: { nickname: "Agent" },
    });
    await store.close();
  });

  it("expires unclaimed Tool Requests and never retries requests interrupted after claim", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.submitToolRequest({
      requestId: "expired-request",
      bindingId: "codex",
      toolName: "clawchat_get_account_profile",
      normalizedInput: {},
      timeoutMs: -1,
    });
    await expect(store.claimNextToolRequest("codex")).resolves.toBeNull();
    await expect(store.getToolRequest("expired-request")).resolves.toMatchObject({
      state: "expired",
      attemptCount: 0,
    });

    await store.submitToolRequest({
      requestId: "interrupted-request",
      bindingId: "codex",
      toolName: "clawchat_get_account_profile",
      normalizedInput: {},
      timeoutMs: 30_000,
    });
    await store.claimNextToolRequest("codex");
    await store.markInterruptedToolRequestsIndeterminate("codex");
    await expect(store.getToolRequest("interrupted-request")).resolves.toMatchObject({
      state: "indeterminate",
      attemptCount: 1,
    });
    await expect(store.claimNextToolRequest("codex")).resolves.toBeNull();
    await store.close();
  });

  it("redacts settled Tool Request inputs and records truncation and provenance", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.submitToolRequest({
      requestId: "record-request",
      bindingId: "codex",
      toolName: "clawchat_upload_avatar_image",
      normalizedInput: { filePath: "/private/secret/avatar.png" },
      recordedInput: { filePath: "avatar.png" },
      timeoutMs: 30_000,
      provenance: { sessionRef: "ABC12345", turnId: "turn-1", origin: "clawchat" },
    });
    await expect(store.claimNextToolRequest("codex")).resolves.toMatchObject({
      input: { filePath: "/private/secret/avatar.png" },
    });
    await store.settleToolRequest("record-request", {
      state: "failed",
      error: "失败".repeat(5_000),
    });
    await expect(store.getToolRequest("record-request")).resolves.toMatchObject({
      input: { filePath: "avatar.png" },
      state: "failed",
      errorTruncated: true,
      resultTruncated: false,
      sessionRef: "ABC12345",
      turnId: "turn-1",
      origin: "clawchat",
    });
    await store.close();
  });

  it("bounds the final encoded Tool Request result after JSON escaping", async () => {
    const dir = await tempDir();
    const store = createStateStore({ dbPath: join(dir, "state.sqlite") });
    await store.submitToolRequest({
      requestId: "oversized-result",
      bindingId: "codex",
      toolName: "clawchat_get_account_profile",
      normalizedInput: {},
      timeoutMs: 30_000,
    });
    await store.claimNextToolRequest("codex");
    await store.settleToolRequest("oversized-result", {
      state: "succeeded",
      result: { escaped: "\\".repeat(100_000) },
    });

    const record = await store.getToolRequest("oversized-result");
    expect(record?.resultTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(record?.result), "utf8")).toBeLessThanOrEqual(64 * 1024);
    await store.close();
  });

  it("retains at most 10,000 settled Tool Requests for 90 days without pruning indeterminate outcomes", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.sqlite");
    const initializingStore = createStateStore({ dbPath });
    await initializingStore.getToolRequest("initialize");
    await initializingStore.close();
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO tool_requests(
         request_id, binding_id, tool_name, input_json, record_input_json, state, result_json,
         created_at, claimed_at, settled_at, expires_at, attempt_count
       ) VALUES (?, ?, 'clawchat_get_account_profile', '{}', '{}', ?, '{}', ?, ?, ?, ?, 1)`,
    );
    const now = Date.now();
    db.transaction(() => {
      for (let index = 0; index < 10_001; index += 1) {
        const timestamp = now + index;
        insert.run(
          `count-${String(index).padStart(5, "0")}`,
          "codex",
          "succeeded",
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        );
      }
      const old = now - 91 * 24 * 60 * 60 * 1_000;
      insert.run("aged-settled", "aged", "failed", old, old, old, now);
      insert.run("aged-indeterminate", "aged", "indeterminate", old, old, old, now);
    })();
    db.close();

    const store = createStateStore({ dbPath });
    await store.pruneSettledToolRequests("codex", now);
    await expect(store.getToolRequest("count-00000")).resolves.toBeNull();
    await expect(store.getToolRequest("count-10000")).resolves.toMatchObject({ state: "succeeded" });
    await store.pruneSettledToolRequests("aged", now);
    await expect(store.getToolRequest("aged-settled")).resolves.toBeNull();
    await expect(store.getToolRequest("aged-indeterminate")).resolves.toMatchObject({ state: "indeterminate" });
    await store.close();
  });
});
