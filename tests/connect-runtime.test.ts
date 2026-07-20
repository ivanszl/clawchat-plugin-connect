import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import type { RuntimeOutputEvent } from "../src/output-visibility";
import type { NormalizedInboundMessage } from "../src/protocol";
import { ConnectRuntime } from "../src/runtime/connect-runtime";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
} from "../src/runtime/types";
import { createStateStore } from "../src/state";
import type { ConnectWsClient } from "../src/ws-client";

function message(text = "hello"): NormalizedInboundMessage {
  return {
    event: "message.send",
    chatId: "chat-1",
    chatType: "direct",
    messageId: "message-1",
    traceId: "trace-1",
    sender: { id: "user-1", type: "direct", nick_name: "User" },
    emittedAt: Date.now(),
    text,
    fragments: [{ kind: "text", text }],
    mentions: [],
    replyToMessageId: null,
    raw: {} as never,
  };
}

function session(
  prompt: (context: ConnectRuntimeStartContext) => AsyncIterable<RuntimeOutputEvent>,
  context: ConnectRuntimeStartContext,
): ConnectRuntimeSession {
  return {
    prompt: () => prompt(context),
    close: mock(async () => undefined),
    cancel: mock(async () => true),
  };
}

async function runtimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-runtime-"));
  const config = upsertAgentBinding(defaultConfig(), "codex", { kind: "codex" });
  config.stateDbPath = join(directory, "state.sqlite");
  const store = createStateStore({ dbPath: config.stateDbPath });
  await store.upsertRuntimeSession({
    chatId: "chat-1",
    sessionId: "session-1",
    agentId: "codex",
    projectId: null,
    isCurrent: true,
  });
  const wsClient = { sendMessageEnvelope: mock(async () => ({ payload: {} })) } as unknown as ConnectWsClient;
  return { config, store, wsClient, configPath: join(directory, "config.json") };
}

describe("ConnectRuntime Agent Binding sessions", () => {
  it("starts the first message in a Non-Project Session with an isolated workspace", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.deleteRuntimeSession("chat-1", "codex", "session-1");
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield { kind: "final", text: "done" } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await runtime.handleInboundMessage(message());

    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({ projectId: null });
    const promptInput = prompts[0];
    if (!promptInput) throw new Error("expected runtime prompt");
    expect(promptInput.workspace).toMatchObject({ projectId: null, skipGitRepoCheck: true });
    expect((await stat(promptInput.workspace.workingDirectory)).isDirectory()).toBe(true);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("serializes lifecycle commands behind an active turn for the same chat", async () => {
    const fixture = await runtimeFixture();
    let releaseTurn: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const order: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* () {
          order.push("turn-started");
          markStarted?.();
          await release;
          order.push("turn-finished");
          yield { kind: "final", text: "done" } as const;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    const turn = runtime.handleInboundMessage(message());
    await started;
    const command = runtime.handleInboundMessage(message("/project clear"), async () => {
      order.push("command");
      return true;
    });
    await Bun.sleep(5);
    expect(order).toEqual(["turn-started"]);
    releaseTurn?.();
    await Promise.all([turn, command]);
    expect(order).toEqual(["turn-started", "turn-finished", "command"]);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("persists a Codex thread id and resumes it after runtime restart", async () => {
    const fixture = await runtimeFixture();
    const starts: ConnectRuntimeStartContext[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async (_agent, context) => {
        starts.push(context);
        return session(async function* (startContext) {
          await startContext.onRuntimeSessionId("thread-1");
          yield { kind: "final", text: "done" };
        }, context);
      }),
    };

    const first = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });
    await first.handleInboundMessage(message());
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await first.dispose();

    const second = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });
    await second.handleInboundMessage(message("again"));

    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ runtimeSessionId: null, configPath: fixture.configPath });
    expect(starts[1]).toMatchObject({ runtimeSessionId: "thread-1", configPath: fixture.configPath });
    await second.dispose();
    await fixture.store.close();
  });

  it("preserves a thread when closing and clears it when invalidating", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.setRuntimeSessionId("chat-1", "codex", "session-1", "thread-1");
    const createdSessions: ConnectRuntimeSession[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async (_agent, context) => {
        const created = session(async function* () {
          yield { kind: "final", text: "done" };
        }, context);
        createdSessions.push(created);
        return created;
      }),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([adapter]),
    });

    await runtime.handleInboundMessage(message());
    await expect(runtime.closeSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await runtime.handleInboundMessage(message("resume"));
    await expect(runtime.invalidateSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: null,
    });
    expect(createdSessions.every((created) => (created.close as ReturnType<typeof mock>).mock.calls.length === 1)).toBe(
      true,
    );
    await fixture.store.close();
  });
});
