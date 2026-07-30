import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCommand, isConnectControlMessage, requiresOrderedSessionControl } from "../src/chat-commands";
import { runConnectCli } from "../src/cli";
import { defaultConfig, loadConfig, saveConfig, upsertAgentBinding } from "../src/config";
import type { UpdateAccountProfileResult } from "../src/profile";
import { ProjectCatalog } from "../src/projects";
import type { NormalizedInboundMessage } from "../src/protocol";
import type { SelectableRuntimeThread } from "../src/runtime/types";
import { type ConnectStateStore, createStateStore } from "../src/state";
import { CONNECT_VERSION } from "../src/version";
import { workspaceView } from "../src/workspace-catalog";

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
  it("reports the build version pinned by the release manifest", async () => {
    const output = io();
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };

    await expect(runConnectCli(["--version"], output.deps)).resolves.toBe(0);

    expect(CONNECT_VERSION).toBe(manifest.version);
    expect(output.stdout).toEqual([`clawchat-connect v${manifest.version}\n`]);
  });

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

  it("reads and updates config through the config subcommands", async () => {
    const path = await tempConfig();
    const stateDbPath = `${path}.sqlite`;
    const output = io();
    await runConnectCli(["init", "--config", path, "--agent", "codex", "--kind", "codex"], output.deps);

    output.stdout.length = 0;
    await expect(
      runConnectCli(["config", "set", "stateDbPath", stateDbPath, "--config", path], output.deps),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({ stateDbPath });
    expect(output.stdout.join("")).toContain("Updated config:");

    await expect(
      runConnectCli(["config", "set", "clientHost", "0.0.0.0", "--config", path], output.deps),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({ clientHost: "0.0.0.0" });

    await expect(
      runConnectCli(
        ["config", "set", "mediaUploadUrl", "https://media.example/media/upload", "--config", path],
        output.deps,
      ),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({
      mediaUploadUrl: "https://media.example/media/upload",
    });

    await expect(
      runConnectCli(["config", "set", "livewareAccessPolicy", "public", "--config", path], output.deps),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({ livewareAccessPolicy: "public" });

    output.stdout.length = 0;
    await expect(runConnectCli(["config", "get", "stateDbPath", "--config", path], output.deps)).resolves.toBe(0);
    expect(output.stdout).toEqual([`${JSON.stringify(stateDbPath)}\n`]);
  });

  it("reports the configured and active Liveware Exposure", async () => {
    const path = await tempConfig();
    const config = upsertAgentBinding(defaultConfig(), "work", { kind: "codex" });
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.setLivewareExposure({
      ownerUserId: "owner-1",
      localAgentId: "work",
      appId: "app-1",
      publicUrl: "https://app-1.apps.example",
      accessPolicy: "private",
    });
    await store.close();
    const output = io();

    await expect(runConnectCli(["status", "--config", path], output.deps)).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("liveware policy: private");
    expect(output.stdout.join("")).toContain("liveware exposure: https://app-1.apps.example");
  });

  it("checks the bundled Liveware executable when exposure is enabled", async () => {
    const path = await tempConfig();
    const config = defaultConfig();
    config.livewareAccessPolicy = "private";
    await saveConfig(config, path);
    const output = io();
    const resolveLivewareExecutablePath = mock(async () => "/bundle/liveware");

    await expect(
      runConnectCli(["doctor", "--config", path], {
        ...output.deps,
        resolveLivewareExecutablePath,
      }),
    ).resolves.toBe(0);
    expect(resolveLivewareExecutablePath).toHaveBeenCalledTimes(1);
    expect(output.stdout.join("")).toContain("liveware: /bundle/liveware");
  });

  it("updates Connect through the release installer and refreshes the configured service", async () => {
    const output = io();
    const updateConnect = mock(async () => ({
      version: "v0.1.0-alpha.16",
      executablePath: "/opt/connect/clawchat-connect",
    }));

    await expect(
      runConnectCli(["update", "--version", "v0.1.0-alpha.16", "--config", "/tmp/connect.json"], {
        ...output.deps,
        updateConnect,
      }),
    ).resolves.toBe(0);

    expect(updateConnect).toHaveBeenCalledWith({
      version: "v0.1.0-alpha.16",
      configPath: "/tmp/connect.json",
    });
    expect(output.stdout.join("")).toContain("Updated ClawChat Connect to v0.1.0-alpha.16");
  });

  it("manages Projects only through the local CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-project-cli-"));
    const configPath = join(directory, "config.json");
    const root = join(directory, "repo");
    const shared = join(directory, "shared");
    await mkdir(root);
    await mkdir(shared);
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    await saveConfig(config, configPath);
    const output = io();

    await expect(
      runConnectCli(["project", "add", root, "--additional-directory", shared, "--config", configPath], output.deps),
    ).resolves.toBe(0);
    output.stdout.length = 0;
    await expect(runConnectCli(["project", "list", "--config", configPath], output.deps)).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("repo");
    expect(output.stdout.join("")).toContain(root);
    const workspaceId = workspaceView(await realpath(root))?.id;
    expect(workspaceId).toBeTruthy();
    if (!workspaceId) throw new Error("expected Workspace ID");

    output.stdout.length = 0;
    await expect(runConnectCli(["project", "remove", workspaceId, "--config", configPath], output.deps)).resolves.toBe(
      0,
    );
    expect(output.stdout.join("")).toContain("Removed Project repo");
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

  it("reserves process execution for the native background service", async () => {
    const output = io();
    const startConnectService = mock(async () => ({ startedAgentIds: ["codex", "claude"] }));
    await expect(
      runConnectCli(["service", "exec", "--config", "/tmp/connect.json"], {
        ...output.deps,
        startConnectService,
      }),
    ).resolves.toBe(0);
    expect(startConnectService).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/connect.json",
        writeOutput: expect.any(Function),
        writeError: expect.any(Function),
      }),
    );

    output.stdout.length = 0;
    await expect(runConnectCli(["run"], { ...output.deps, startConnectService })).resolves.toBe(1);
    expect(startConnectService).toHaveBeenCalledTimes(1);
    expect(output.stdout.join("")).not.toContain("run [--config");
  });

  it("opens the fixed loopback Connect Client URL", async () => {
    const path = await tempConfig();
    const config = defaultConfig();
    config.stateDbPath = `${path}.sqlite`;
    config.clientPort = 49_123;
    await saveConfig(config, path);
    const output = io();
    const openUrl = mock(async (_url: string) => undefined);

    await expect(runConnectCli(["web", "--config", path], { ...output.deps, openUrl })).resolves.toBe(0);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:49123/");
    expect(output.stdout.join("")).toContain("Connect Client URL: http://127.0.0.1:49123/");

    await expect(runConnectCli(["web", "--no-open", "--config", path], { ...output.deps, openUrl })).resolves.toBe(0);
    expect(openUrl).toHaveBeenCalledTimes(1);

    config.clientHost = "0.0.0.0";
    await saveConfig(config, path);
    output.stdout.length = 0;
    await expect(runConnectCli(["web", "--no-open", "--config", path], { ...output.deps, openUrl })).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("LAN Host mode is enabled on 0.0.0.0:49123");
  });

  it("manages one native background service for the complete Connect installation", async () => {
    const path = await tempConfig();
    const output = io();
    await runConnectCli(["init", "--config", path, "--agent", "work", "--kind", "codex"], output.deps);
    const manageBackgroundService = mock(async () => ({ message: "background ok\n", running: true }));

    await expect(
      runConnectCli(["service", "logs", "--lines", "25", "--follow", "--config", path], {
        ...output.deps,
        manageBackgroundService,
      }),
    ).resolves.toBe(0);
    expect(manageBackgroundService).toHaveBeenCalledWith({
      action: "logs",
      configPath: path,
      lines: 25,
      follow: true,
    });
    expect(output.stdout.join("")).toContain("background ok");

    await expect(runConnectCli(["service", "status", "--agent", "work", "--config", path], output.deps)).resolves.toBe(
      1,
    );
    expect(output.stderr.join("")).toContain("manages all activated Agent Bindings");
  });

  it("updates the connected ClawChat Profile through the CLI", async () => {
    const output = io();
    const updateAccountProfile = mock(
      async (): Promise<UpdateAccountProfileResult> => ({ agentId: "work", profile: { nickname: "Luna" } }),
    );

    await expect(
      runConnectCli(
        [
          "profile",
          "update",
          "--agent",
          "work",
          "--nickname",
          "Luna",
          "--avatar-url",
          "https://example.com/luna.png",
          "--bio",
          "Local coding agent",
          "--config",
          "/tmp/connect.json",
        ],
        { ...output.deps, updateAccountProfile },
      ),
    ).resolves.toBe(0);
    expect(updateAccountProfile).toHaveBeenCalledWith({
      agentId: "work",
      configPath: "/tmp/connect.json",
      patch: {
        nickname: "Luna",
        avatar_url: "https://example.com/luna.png",
        bio: "Local coding agent",
      },
    });
    expect(output.stdout.join("")).toContain("Updated ClawChat Profile for work");
  });

  it("rejects empty Profile updates and no longer exposes an MCP server command", async () => {
    const output = io();
    const updateAccountProfile = mock(
      async (): Promise<UpdateAccountProfileResult> => ({
        agentId: "work",
        profile: {},
      }),
    );

    await expect(
      runConnectCli(["profile", "update", "--agent", "work"], { ...output.deps, updateAccountProfile }),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("at least one Profile field");
    expect(updateAccountProfile).not.toHaveBeenCalled();

    output.stdout.length = 0;
    output.stderr.length = 0;
    await expect(runConnectCli(["mcp-server", "--agent", "work"], output.deps)).resolves.toBe(1);
    expect(output.stdout.join("")).not.toContain("mcp-server");
  });

  it("exposes tool-name calls through the SQLite request record and returns reused settled results", async () => {
    const path = await tempConfig();
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.submitToolRequest({
      requestId: "known-request",
      bindingId: "codex",
      toolName: "clawchat_get_account_profile",
      normalizedInput: {},
      timeoutMs: 30_000,
    });
    await store.claimNextToolRequest("codex");
    await store.settleToolRequest("known-request", { state: "succeeded", result: { nickname: "Connect" } });
    await store.close();
    const output = io();

    await expect(
      runConnectCli(
        [
          "tool",
          "call",
          "clawchat_get_account_profile",
          "--input-json",
          "{}",
          "--request-id",
          "known-request",
          "--config",
          path,
        ],
        output.deps,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(output.stdout.at(-1) ?? "{}")).toMatchObject({
      requestId: "known-request",
      toolName: "clawchat_get_account_profile",
      status: "succeeded",
      result: { nickname: "Connect" },
    });
    expect(JSON.parse(output.stdout.at(-1) ?? "{}")).not.toHaveProperty("agent");
  });

  it("settles a locally timed-out Tool Request to a terminal state", async () => {
    const path = await tempConfig();
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    const output = io();

    await expect(
      runConnectCli(
        [
          "tool",
          "call",
          "clawchat_get_account_profile",
          "--input-json",
          "{}",
          "--request-id",
          "deadline-request",
          "--config",
          path,
        ],
        { ...output.deps, toolRequestWaitMs: 0 },
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(output.stdout.at(-1) ?? "{}")).toMatchObject({
      requestId: "deadline-request",
      status: "expired",
    });
  });

  it("lists the static 24-entry tool catalog without opening state", async () => {
    const output = io();
    await expect(runConnectCli(["tool", "list"], output.deps)).resolves.toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "{}").tools).toHaveLength(24);
  });

  it("describes tools, reads stdin JSON, and honors explicit, runtime, then default Binding precedence", async () => {
    const path = await tempConfig();
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    const store = createStateStore({ dbPath: config.stateDbPath });
    for (const requestId of ["explicit-request", "default-request"]) {
      await store.submitToolRequest({
        requestId,
        bindingId: "codex",
        toolName: "clawchat_get_user_profile",
        normalizedInput: { userId: "user-1" },
        timeoutMs: 30_000,
      });
      await store.claimNextToolRequest("codex");
      await store.settleToolRequest(requestId, { state: "succeeded", result: { userId: "user-1" } });
    }
    await store.close();
    const output = io();

    await expect(runConnectCli(["tool", "describe", "clawchat_get_user_profile"], output.deps)).resolves.toBe(0);
    expect(JSON.parse(output.stdout.pop() ?? "{}")).toMatchObject({
      name: "clawchat_get_user_profile",
      inputSchema: { required: ["userId"] },
    });

    const previousBinding = process.env.CLAWCHAT_CONNECT_AGENT_ID;
    try {
      process.env.CLAWCHAT_CONNECT_AGENT_ID = "missing-runtime-binding";
      await expect(
        runConnectCli(
          [
            "tool",
            "call",
            "clawchat_get_user_profile",
            "--input-json",
            "-",
            "--request-id",
            "explicit-request",
            "--agent",
            "codex",
            "--config",
            path,
          ],
          { ...output.deps, readStdin: async () => '{"userId":"user-1"}' },
        ),
      ).resolves.toBe(0);
      await expect(
        runConnectCli(
          ["tool", "call", "clawchat_get_user_profile", "--input-json", '{"userId":"user-1"}', "--config", path],
          output.deps,
        ),
      ).resolves.toBe(1);
      expect(output.stderr.join("")).toContain("missing-runtime-binding");

      delete process.env.CLAWCHAT_CONNECT_AGENT_ID;
      await expect(
        runConnectCli(
          [
            "tool",
            "call",
            "clawchat_get_user_profile",
            "--input-json",
            '{"userId":"user-1"}',
            "--request-id",
            "default-request",
            "--config",
            path,
          ],
          output.deps,
        ),
      ).resolves.toBe(0);
    } finally {
      if (previousBinding === undefined) delete process.env.CLAWCHAT_CONNECT_AGENT_ID;
      else process.env.CLAWCHAT_CONNECT_AGENT_ID = previousBinding;
    }
  });
});

describe("handleChatCommand", () => {
  it("orders only controls that change Session routing or turn settings", () => {
    for (const text of ["/new", "/new Plan", "/switch ABCDEFGH", "/project none", "/model default", "/mode read-only"])
      expect(requiresOrderedSessionControl(text)).toBe(true);
    for (const text of [
      "/help",
      "/status",
      "/sessions",
      "/switch",
      "/project",
      "/project add repo /tmp/repo",
      "/model",
      "/mode",
      "/clawchat-output full",
    ])
      expect(requiresOrderedSessionControl(text)).toBe(false);
    expect(isConnectControlMessage("/status")).toBe(true);
    expect(isConnectControlMessage("ordinary work")).toBe(false);
  });

  it("uses /help as the only Connect help command", async () => {
    const context = {
      agentId: "codex",
      ownerUserId: "someone-else",
      config: upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" }),
      stateStore: {} as ConnectStateStore,
      projects: {} as ProjectCatalog,
    };

    const help = await handleChatCommand({ ...context, message: message("/help") });
    const helpText = help.text ?? "";
    expect(help.handled).toBe(true);
    expect(helpText.includes("/sessions")).toBe(true);
    expect(helpText.includes("/model")).toBe(true);
    expect(helpText.includes("/project add")).toBe(false);
    expect(helpText.includes("/current")).toBe(false);
    await expect(handleChatCommand({ ...context, message: message("/clawchat-help") })).resolves.toMatchObject({
      handled: true,
      text: expect.stringContaining("Unknown ClawChat command: /clawchat-help"),
    });
    await expect(handleChatCommand({ ...context, message: message("/list") })).resolves.toMatchObject({
      handled: true,
      text: expect.stringContaining("Unknown Connect command: /list"),
    });
  });

  it("persists /clawchat-output overrides", async () => {
    const store = { setOutputVisibility: mock(async () => undefined) } as unknown as ConnectStateStore;
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
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
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    const result = await handleChatCommand({
      message: message("/project"),
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
    const project = await projects.add(root);
    const workspaceId = projects.workspaceId(project);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    const closeRuntimeSession = mock(async () => true);
    const invalidateRuntimeSession = mock(async () => true);
    for (const command of [
      "/status",
      "/new",
      "/sessions",
      "/project",
      `/project ${workspaceId}`,
      "/project none",
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
        runtimeModesFor: () => ["read-only", "workspace-write", "danger-full-access"],
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
    expect(invalidateRuntimeSession).not.toHaveBeenCalled();

    await expect(
      handleChatCommand({
        message: message("/mode unsupported"),
        agentId: "codex",
        ownerUserId: "usr",
        config,
        stateStore: store,
        projects,
        runtimeModesFor: () => ["read-only", "workspace-write", "danger-full-access"],
      }),
    ).resolves.toMatchObject({ handled: true, text: expect.stringContaining("Usage for codex") });
    await store.close();
  });

  it("records Project changes without creating a Session before the first message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-project-switch-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const project = await projects.add(root);
    const workspaceId = projects.workspaceId(project);
    const config = upsertAgentBinding(defaultConfig(), "work", { kind: "codex" });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "before",
      agentId: "work",
      runtimeSessionId: "thread-before",
      projectId: null,
    });
    const closeRuntimeSession = mock(async () => true);

    const selected = await handleChatCommand({
      message: message(`/project ${workspaceId}`),
      agentId: "work",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      closeRuntimeSession,
    });
    expect(selected.text).toContain("next message");
    expect(await store.getCurrentRuntimeSession("chat-1", "work")).toBeNull();
    expect(await store.listRuntimeSessions("chat-1", "work")).toHaveLength(1);
    await expect(store.getSessionIntent("chat-1", "work")).resolves.toMatchObject({
      projectId: expect.any(String),
    });
    await expect(
      handleChatCommand({
        message: message("/status"),
        agentId: "work",
        ownerUserId: "usr",
        config,
        stateStore: store,
        projects,
      }),
    ).resolves.toMatchObject({ text: expect.stringContaining("next Session (not started)") });
    const selectedList = await handleChatCommand({
      message: message("/sessions"),
      agentId: "work",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
    });
    expect(selectedList.text).toContain("No Sessions in Project `repo`");
    expect(selectedList.text).not.toContain("thread-before");

    const cleared = await handleChatCommand({
      message: message("/project none"),
      agentId: "work",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      closeRuntimeSession,
    });
    expect(cleared.text).toContain("next message");
    expect(await store.getCurrentRuntimeSession("chat-1", "work")).toBeNull();
    expect(await store.listRuntimeSessions("chat-1", "work")).toHaveLength(1);
    await expect(store.getSessionIntent("chat-1", "work")).resolves.toMatchObject({ projectId: null });
    expect(closeRuntimeSession).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it("uses synchronized Project Workspace IDs and labels from Connect Client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-workspace-command-"));
    const registeredRoot = join(directory, "clawchat-plugin-connect");
    const discoveredRoot = join(directory, "clawpet");
    await Promise.all([mkdir(registeredRoot), mkdir(discoveredRoot)]);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const registered = await projects.add(registeredRoot);
    const discovered = await projects.add(discoveredRoot);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    const listRuntimeWorkspaces = async () => [
      {
        workspaceId: projects.workspaceId(registered),
        name: "clawchat-plugin-connect",
        rootPath: registeredRoot,
        projectId: registered.projectId,
        projectName: registered.name,
      },
      {
        workspaceId: projects.workspaceId(discovered),
        name: "clawpet",
        rootPath: discoveredRoot,
        projectId: discovered.projectId,
        projectName: discovered.name,
      },
    ];

    const listed = await handleChatCommand({
      message: message("/project"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      listRuntimeWorkspaces,
    });
    expect(listed.text).toContain("clawchat-plugin-connect");
    expect(listed.text).toContain("clawpet");
    expect(listed.text).not.toContain("Runtime Workspace");

    const rejectedName = await handleChatCommand({
      message: message("/project clawpet"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      listRuntimeWorkspaces,
    });
    expect(rejectedName.text).toContain("Unknown Workspace ID");
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toBeNull();

    await handleChatCommand({
      message: message(`/project ${projects.workspaceId(discovered)}`),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      listRuntimeWorkspaces,
      closeRuntimeSession: async () => true,
    });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      projectId: expect.any(String),
    });
    await expect(projects.list()).resolves.toHaveLength(2);
    await store.close();
  });

  it("records /new without creating an empty Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-new-intent-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-existing",
      agentId: "codex",
      name: "Existing work",
    });

    const result = await handleChatCommand({
      message: message("/new Planned work"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      closeRuntimeSession: mock(async () => true),
    });

    expect(result.text).toContain("next message");
    expect(await store.getCurrentRuntimeSession("chat-1", "codex")).toBeNull();
    expect(await store.listRuntimeSessions("chat-1", "codex")).toHaveLength(1);
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      name: "Planned work",
      projectId: null,
    });
    await store.close();
  });

  it("selects and clears a validated model without replacing the Runtime Thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-model-command-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex", model: "gpt-default" });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-model",
      agentId: "codex",
      runtimeSessionId: "thread-stable",
    });
    const context = {
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      listRuntimeModels: async () => [
        {
          id: "gpt-default",
          displayName: "Default",
          description: "Default model",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          inputModalities: ["text" as const],
        },
        {
          id: "gpt-deep",
          displayName: "Deep",
          description: "Deep model",
          isDefault: false,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["high", "xhigh"],
          inputModalities: ["text" as const, "image" as const],
        },
      ],
    };

    await expect(handleChatCommand({ ...context, message: message("/model gpt-deep xhigh") })).resolves.toMatchObject({
      text: expect.stringContaining("gpt-deep"),
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-stable",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
    });

    await handleChatCommand({
      ...context,
      listRuntimeModels: async () => {
        throw new Error("catalog temporarily unavailable");
      },
      message: message("/model default"),
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-stable",
      model: null,
      reasoningEffort: null,
    });
    await store.close();
  });

  it("validates a pending Session model atomically and preserves it through /new", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-model-intent-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    const models = async () => [
      {
        id: "gpt-deep",
        displayName: "Deep",
        description: "Deep model",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["high", "xhigh"],
        inputModalities: ["text" as const],
      },
    ];
    const context = {
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      listRuntimeModels: models,
    };

    await handleChatCommand({ ...context, message: message("/model gpt-deep") });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      model: "gpt-deep",
      reasoningEffort: "high",
    });
    await expect(handleChatCommand({ ...context, message: message("/model gpt-deep low") })).resolves.toMatchObject({
      text: expect.stringContaining("not supported"),
    });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      model: "gpt-deep",
      reasoningEffort: "high",
    });
    await handleChatCommand({ ...context, message: message("/new Continue") });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      name: "Continue",
      model: "gpt-deep",
      reasoningEffort: "high",
    });
    await expect(
      handleChatCommand({
        ...context,
        listRuntimeModels: undefined,
        message: message("/model gpt-deep"),
      }),
    ).resolves.toMatchObject({ text: expect.stringContaining("does not support model selection") });
    await store.close();
  });

  it("lists Session names and switches existing or discovered Runtime Threads by name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-named-sessions-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const project = await projects.add(root);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-current",
      agentId: "codex",
      projectId: project.projectId,
      name: "Current work",
      runtimeSessionId: "thread-current",
      isCurrent: true,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-release",
      agentId: "codex",
      projectId: project.projectId,
      name: "Release prep",
      runtimeSessionId: "thread-release",
      isCurrent: false,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-non-project",
      agentId: "codex",
      projectId: null,
      name: "Unrelated Non-Project work",
      runtimeSessionId: "thread-non-project",
      isCurrent: false,
    });
    const discovered: SelectableRuntimeThread[] = [
      {
        runtimeThreadId: "thread-external",
        name: "Fix login flow",
        updatedAt: 2,
        sessionRef: await store.getOrCreateSessionRef({
          chatId: "chat-1",
          agentId: "codex",
          runtimeSessionId: "thread-external",
        }),
      },
    ];
    const base = {
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
      closeRuntimeSession: mock(async () => true),
      discoverRuntimeThreads: mock(async () => discovered),
    };

    const listed = await handleChatCommand({ ...base, message: message("/sessions") });
    expect(listed.text).toContain("Current work");
    expect(listed.text).toContain("(current)");
    expect(listed.text).toContain("Release prep");
    expect(listed.text).toContain("Fix login flow");
    expect(listed.text).toContain("(available)");
    expect(listed.text).not.toContain("Unrelated Non-Project work");
    expect(listed.text).not.toContain("session-release");
    expect(listed.text).not.toContain("thread-external");

    const release = (await store.listRuntimeSessions("chat-1", "codex")).find(
      (session) => session.name === "Release prep",
    );
    if (!release) throw new Error("expected release Session");
    expect(listed.text).toContain(release.sessionRef);
    expect(listed.text).toContain(discovered[0].sessionRef);
    await expect(
      handleChatCommand({ ...base, message: message(`/switch ${release.sessionRef.toLowerCase()}`) }),
    ).resolves.toMatchObject({
      text: `Switched to Session \`Release prep\` (\`${release.sessionRef}\`).`,
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      sessionId: "session-release",
    });

    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-release-duplicate",
      agentId: "codex",
      projectId: project.projectId,
      name: "Release prep",
      runtimeSessionId: "thread-release-duplicate",
      isCurrent: false,
    });
    const duplicate = (await store.listRuntimeSessions("chat-1", "codex")).find(
      (session) => session.sessionId === "session-release-duplicate",
    );
    if (!duplicate) throw new Error("expected duplicate named Session");
    const ambiguous = await handleChatCommand({ ...base, message: message("/switch Release prep") });
    expect(ambiguous.text).toContain(release.sessionRef);
    expect(ambiguous.text).toContain(duplicate.sessionRef);
    expect(ambiguous.text).not.toContain("session-release");

    await expect(
      handleChatCommand({ ...base, message: message(`/switch ${discovered[0].sessionRef}`) }),
    ).resolves.toMatchObject({
      text: `Imported and switched to Runtime Thread \`Fix login flow\` (\`${discovered[0].sessionRef}\`).`,
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      name: "Fix login flow",
      runtimeSessionId: "thread-external",
      sessionRef: discovered[0].sessionRef,
      projectId: project.projectId,
    });
    await store.close();
  });

  it("switches a Client Catalog Session Ref without waiting for Runtime Thread discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-catalog-switch-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const generatedRefs = ["ABCDEFGH", "NKEP79B8"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => generatedRefs.shift() ?? "JKLMNPQR",
    });
    const projects = new ProjectCatalog(store);
    const project = await projects.add(root);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-current",
      agentId: "codex",
      projectId: project.projectId,
      runtimeSessionId: "thread-current",
      isCurrent: true,
    });
    const catalogRef = await store.getOrCreateSessionRef({
      chatId: "__connect_client_catalog__",
      agentId: "codex",
      runtimeSessionId: "thread-catalog",
    });
    expect(catalogRef).toBe("NKEP79B8");

    const switched = await Promise.race([
      handleChatCommand({
        message: message(`/switch ${catalogRef}`),
        agentId: "codex",
        ownerUserId: "usr",
        config,
        stateStore: store,
        projects,
        closeRuntimeSession: mock(async () => true),
        discoverRuntimeThreads: async () => await new Promise<SelectableRuntimeThread[]>(() => undefined),
      }),
      Bun.sleep(50).then(() => ({ handled: true, text: "timed out waiting for Runtime Thread discovery" })),
    ]);

    expect(switched.text).toBe(`Imported and switched to Session \`${catalogRef}\`.`);
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-catalog",
      sessionRef: catalogRef,
      projectId: project.projectId,
      isCurrent: true,
    });
    await store.close();
  });

  it("lists only the current Session in a Non-Project workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-non-project-list-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const projects = new ProjectCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-old",
      agentId: "codex",
      name: "Old isolated work",
      isCurrent: false,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-current",
      agentId: "codex",
      name: "Current isolated work",
      isCurrent: true,
    });

    const listed = await handleChatCommand({
      message: message("/sessions"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      projects,
    });
    expect(listed.text).toContain("Current isolated work");
    expect(listed.text).not.toContain("Old isolated work");
    await store.close();
  });
});
