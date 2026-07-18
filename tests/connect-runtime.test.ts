import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, upsertAgent } from "../src/config";
import type { RuntimeOutputEvent } from "../src/output-visibility";
import type { NormalizedInboundMessage } from "../src/protocol";
import { ConnectRuntime } from "../src/runtime/connect-runtime";
import type { ConnectRuntimeAdapter, ConnectRuntimeSession, ConnectRuntimeStartContext } from "../src/runtime/types";
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
    toolsAlreadyExposed: true,
    prompt: () => prompt(context),
    close: vi.fn(async () => undefined),
    cancel: vi.fn(async () => true),
    registerTools: vi.fn(async () => true),
  };
}

async function runtimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-runtime-"));
  const config = upsertAgent(defaultConfig(), "codex", { kind: "codex" });
  config.stateDbPath = join(directory, "state.sqlite");
  const store = createStateStore({ dbPath: config.stateDbPath });
  await store.upsertRuntimeSession({
    chatId: "chat-1",
    sessionId: "session-1",
    agentId: "codex",
    cwd: "/repo",
    isCurrent: true,
  });
  const wsClient = { sendMessageEnvelope: vi.fn(async () => ({ payload: {} })) } as unknown as ConnectWsClient;
  return { config, store, wsClient, configPath: join(directory, "config.json") };
}

describe("ConnectRuntime Codex sessions", () => {
  it("persists a Codex thread id and resumes it after runtime restart", async () => {
    const fixture = await runtimeFixture();
    const starts: ConnectRuntimeStartContext[] = [];
    const adapter: ConnectRuntimeAdapter = {
      start: vi.fn(async (_agent, context) => {
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
      runtimeAdapters: { codex: adapter },
    });
    await first.handleInboundMessage(message());
    await expect(fixture.store.getCurrentRuntimeSession("chat-1")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await first.dispose();

    const second = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: { codex: adapter },
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
    await fixture.store.setRuntimeSessionId("chat-1", "session-1", "thread-1");
    const createdSessions: ConnectRuntimeSession[] = [];
    const adapter: ConnectRuntimeAdapter = {
      start: vi.fn(async (_agent, context) => {
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
      runtimeAdapters: { codex: adapter },
    });

    await runtime.handleInboundMessage(message());
    await expect(runtime.closeSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await runtime.handleInboundMessage(message("resume"));
    await expect(runtime.invalidateSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1")).resolves.toMatchObject({ runtimeSessionId: null });
    expect(
      createdSessions.every((created) => (created.close as ReturnType<typeof vi.fn>).mock.calls.length === 1),
    ).toBe(true);
    await fixture.store.close();
  });
});
