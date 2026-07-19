import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCommand } from "../src/chat-commands";
import { runConnectCli } from "../src/cli";
import { defaultConfig, loadConfig, upsertAgent } from "../src/config";
import { ProjectCatalog } from "../src/projects";
import type { NormalizedInboundMessage } from "../src/protocol";
import { type ConnectStateStore, createStateStore } from "../src/state";

async function tempConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clawchat-connect-cli-"));
  return join(dir, "config.json");
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
    },
  };
}

function message(text: string, chatType: "direct" | "group" = "direct"): NormalizedInboundMessage {
  return {
    event: "message.send",
    chatId: "chat-1",
    chatType,
    messageId: "msg-1",
    traceId: "trace-1",
    sender: { id: "usr", type: "direct", nick_name: "User" },
    emittedAt: 1,
    text,
    fragments: [{ kind: "text", text }],
    mentions: [],
    replyToMessageId: null,
    raw: {} as never,
  };
}

describe("runConnectCli", () => {
  it("initializes minimal config without unsupported config surfaces", async () => {
    const path = await tempConfig();
    const output = io();
    await expect(
      runConnectCli(["init", "--config", path, "--agent", "codex", "--kind", "codex"], output.deps),
    ).resolves.toBe(0);
    const text = await readFile(path, "utf8");
    expect(text).toContain('"defaultAgent": "codex"');
    expect(text).not.toMatch(new RegExp(["pro", "jects"].join(""), "u"));
    expect(text).not.toMatch(new RegExp(["work", "Dir"].join(""), "u"));
  });

  it("requires an explicit runtime kind instead of inferring it from the agent id", async () => {
    const path = await tempConfig();
    const output = io();
    await expect(runConnectCli(["init", "--config", path, "--agent", "codex"], output.deps)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("--kind codex is required");
  });

  it("adds an explicitly named first-party Codex agent", async () => {
    const path = await tempConfig();
    const output = io();
    await runConnectCli(["init", "--config", path], output.deps);
    await expect(
      runConnectCli(
        ["agent", "add", "work", "--kind", "codex", "--codex-path", "/opt/codex", "--config", path],
        output.deps,
      ),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({
      agents: { work: { kind: "codex", codexPathOverride: "/opt/codex" } },
    });
  });

  it("rejects agent bindings without an explicit supported runtime kind", async () => {
    const path = await tempConfig();
    const output = io();
    await runConnectCli(["init", "--config", path], output.deps);
    await expect(runConnectCli(["agent", "add", "claude", "--config", path], output.deps)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("--kind codex is required");
  });

  it("activates through injectable activation action without printing invite code", async () => {
    const output = io();
    const activateConnect = mock(async () => ({
      localAgentId: "codex",
      accessToken: "token",
      refreshToken: null,
      serverAgentId: "agt",
      userId: "usr-agent",
      ownerUserId: "usr-owner",
      conversationId: "chat-owner",
    }));
    await expect(runConnectCli(["activate", "codex", "A1B2C3"], { ...output.deps, activateConnect })).resolves.toBe(0);
    expect(activateConnect).toHaveBeenCalledWith(expect.objectContaining({ agentId: "codex", code: "A1B2C3" }));
    expect(output.stdout.join("")).not.toContain("A1B2C3");
  });

  it("runs service through injectable service starter with agent", async () => {
    const output = io();
    const startService = mock(async () => ({
      connected: true,
      websocketUrl: "wss://example/ws",
      deviceId: "device-1",
      agentId: "codex",
    }));
    await expect(runConnectCli(["run", "--agent", "codex"], { ...output.deps, startService })).resolves.toBe(0);
    expect(startService).toHaveBeenCalledWith(expect.objectContaining({ agentId: "codex" }));
  });
});

describe("handleChatCommand", () => {
  it("persists /clawchat-output overrides", async () => {
    const store = { setOutputVisibility: mock(async () => undefined) } as unknown as ConnectStateStore;
    const config = upsertAgent(defaultConfig(), "codex", { kind: "codex" });
    await expect(
      handleChatCommand({
        message: message("/clawchat-output full"),
        agentId: "codex",
        config,
        stateStore: store,
        projects: {} as ProjectCatalog,
        ownerUserId: "usr",
      }),
    ).resolves.toMatchObject({ handled: true });
    expect(store.setOutputVisibility).toHaveBeenCalledWith("chat-1", "full");
  });

  it("rejects control commands from users other than the Agent Binding owner", async () => {
    const store = {} as ConnectStateStore;
    const projects = { list: mock(async () => []) } as unknown as ProjectCatalog;
    const config = upsertAgent(defaultConfig(), "codex", { kind: "codex" });
    const result = await handleChatCommand({
      message: message("/project list"),
      agentId: "codex",
      ownerUserId: "owner-user",
      config,
      stateStore: store,
      projects,
    });
    expect(result).toMatchObject({ handled: true, text: expect.stringContaining("owner") });
    expect(projects.list).not.toHaveBeenCalled();
  });

  it("handles Session and Project commands while removing legacy directory commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-commands-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const config = upsertAgent(defaultConfig(), "codex", { kind: "codex" });
    const closeRuntimeSession = mock(async () => true);
    const invalidateRuntimeSession = mock(async () => true);
    for (const command of [
      "/status",
      "/new",
      "/list",
      "/current",
      `/project add repo ${root}`,
      "/project list",
      "/project use repo",
      "/project current",
      "/project clear",
      "/project remove repo",
      "/mode read-only",
      "/cancel",
    ]) {
      const result = await handleChatCommand({
        message: message(command, "group"),
        agentId: "codex",
        ownerUserId: "usr",
        config,
        stateStore: store,
        projects,
        closeRuntimeSession,
        invalidateRuntimeSession,
      });
      expect(result.handled, command).toBe(true);
      expect(result.text, command).toBeTruthy();
    }
    for (const command of ["/dir", "/dir /tmp/repo", "/cd /tmp/other"]) {
      await expect(
        handleChatCommand({
          message: message(command),
          agentId: "codex",
          ownerUserId: "usr",
          config,
          stateStore: store,
          projects,
        }),
      ).resolves.toEqual({ handled: false });
    }
    expect(closeRuntimeSession).toHaveBeenCalled();
    expect(invalidateRuntimeSession).toHaveBeenCalled();
    await store.close();
  });

  it("creates a new Session and Runtime Thread boundary when changing Project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-project-switch-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const project = await projects.add("repo", root);
    const config = upsertAgent(defaultConfig(), "work", { kind: "codex" });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "before",
      agentId: "work",
      runtimeSessionId: "thread-before",
      projectId: null,
    });
    const closeRuntimeSession = mock(async () => true);

    await handleChatCommand({
      message: message("/project use repo"),
      agentId: "work",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      closeRuntimeSession,
    });
    const projectSession = await store.getCurrentRuntimeSession("chat-1", "work");
    expect(projectSession).toMatchObject({ projectId: project.projectId, runtimeSessionId: null });
    expect(projectSession?.sessionId).not.toBe("before");
    if (!projectSession) throw new Error("expected Project Session");
    await store.setRuntimeSessionId("chat-1", "work", projectSession.sessionId, "thread-project");

    await handleChatCommand({
      message: message("/project clear"),
      agentId: "work",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      closeRuntimeSession,
    });
    const nonProjectSession = await store.getCurrentRuntimeSession("chat-1", "work");
    expect(nonProjectSession).toMatchObject({ projectId: null, runtimeSessionId: null });
    expect(nonProjectSession?.sessionId).not.toBe(projectSession.sessionId);
    expect(closeRuntimeSession).toHaveBeenCalledTimes(2);
    await store.close();
  });
});
