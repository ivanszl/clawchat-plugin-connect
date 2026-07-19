import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, upsertAgent } from "../src/config";
import { createStateStore } from "../src/state";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "clawchat-connect-"));
}

describe("agent-only config", () => {
  it("writes owner-only JSON config without project or directory config", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    const config = upsertAgent(defaultConfig(), "codex", { kind: "codex" });
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
