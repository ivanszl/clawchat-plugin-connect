import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleChatCommand } from "../src/chat-commands";
import { runConnectCli } from "../src/cli";
import { defaultConfig, loadConfig, upsertAgent } from "../src/config";
import type { NormalizedInboundMessage } from "../src/protocol";
import type { ConnectStateStore } from "../src/state";

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
      runConnectCli(["init", "--config", path, "--agent", "codex", "--command", "codex"], output.deps),
    ).resolves.toBe(0);
    const text = await readFile(path, "utf8");
    expect(text).toContain('"defaultAgent": "codex"');
    expect(text).not.toMatch(new RegExp(["pro", "jects"].join(""), "u"));
    expect(text).not.toMatch(new RegExp(["work", "Dir"].join(""), "u"));
  });

  it("initializes first-party Codex without an ACP command", async () => {
    const path = await tempConfig();
    const output = io();
    await expect(runConnectCli(["init", "--config", path, "--agent", "codex"], output.deps)).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({
      defaultAgent: "codex",
      agents: { codex: { kind: "codex" } },
    });
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

  it("adds ACP agents without activating them", async () => {
    const path = await tempConfig();
    const output = io();
    await runConnectCli(["init", "--config", path], output.deps);
    await expect(
      runConnectCli(["agent", "add", "claude", "--command", "claude-acp", "--config", path], output.deps),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({
      agents: { claude: { kind: "acp", command: "claude-acp" } },
    });
  });

  it("activates through injectable activation action without printing invite code", async () => {
    const output = io();
    const activateConnect = vi.fn(async () => ({
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
    const startService = vi.fn(async () => ({
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
    const store = { setOutputVisibility: vi.fn(async () => undefined) } as unknown as ConnectStateStore;
    const config = upsertAgent(defaultConfig(), "codex", { kind: "acp", command: "codex" });
    await expect(
      handleChatCommand({ message: message("/clawchat-output full"), agentId: "codex", config, stateStore: store }),
    ).resolves.toMatchObject({ handled: true });
    expect(store.setOutputVisibility).toHaveBeenCalledWith("chat-1", "full");
  });

  it("handles session and directory commands without unsupported routing leakage", async () => {
    const sessions: Array<{
      chatId?: string;
      sessionId: string;
      agentId?: string;
      cwd?: string | null;
      name?: string | null;
      isCurrent: boolean;
      [key: string]: unknown;
    }> = [];
    const store = {
      getRuntimeStatus: vi.fn(async () => null),
      getCurrentRuntimeSession: vi.fn(async () => sessions.find((session) => session.isCurrent) ?? null),
      upsertRuntimeSession: vi.fn(async (session) => {
        sessions.forEach((existing) => {
          existing.isCurrent = false;
        });
        sessions.push({ ...session, isCurrent: true });
      }),
      listRuntimeSessions: vi.fn(async () => sessions),
      switchRuntimeSession: vi.fn(async (_chatId, id) => {
        const found = sessions.find((session) => session.sessionId === id);
        if (!found) return false;
        sessions.forEach((session) => {
          session.isCurrent = false;
        });
        found.isCurrent = true;
        return true;
      }),
      setCurrentSessionDirectory: vi.fn(async (_chatId, agentId, cwd) => {
        sessions.forEach((session) => {
          session.isCurrent = false;
        });
        sessions.push({ chatId: "chat-1", sessionId: "default", agentId, cwd, isCurrent: true });
      }),
    } as unknown as ConnectStateStore;
    const config = upsertAgent(defaultConfig(), "codex", { kind: "codex" });
    const closeRuntimeSession = vi.fn(async () => true);
    const invalidateRuntimeSession = vi.fn(async () => true);
    for (const command of [
      "/status",
      "/new",
      "/list",
      "/current",
      "/dir",
      "/dir /tmp/repo",
      "/cd /tmp/other",
      "/mode read-only",
      "/cancel",
    ]) {
      const result = await handleChatCommand({
        message: message(command, "group"),
        agentId: "codex",
        config,
        stateStore: store,
        closeRuntimeSession,
        invalidateRuntimeSession,
      });
      expect(result.handled, command).toBe(true);
      expect(result.text, command).toBeTruthy();
    }
    expect(closeRuntimeSession).toHaveBeenCalled();
    expect(invalidateRuntimeSession).toHaveBeenCalled();
  });
});
