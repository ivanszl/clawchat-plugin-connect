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
    expect(current?.sessionRef).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u);
    await store.close();
  });

  it("tracks runtime status by active agent", async () => {
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
    await expect(store.getRuntimeStatus()).resolves.toMatchObject({ websocketConnected: true, activeAgent: "codex" });
    await store.close();
  });
});
