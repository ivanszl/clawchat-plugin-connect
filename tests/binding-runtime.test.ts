import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BindingProtocolEvent, startBindingRuntime } from "../src/binding-runtime";
import { defaultConfig } from "../src/config";
import { ProjectCatalog } from "../src/projects";
import {
  type Envelope,
  EVENT,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/protocol";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimePrompt } from "../src/runtime/types";
import { createStateStore } from "../src/state";

class MemoryTransport implements Transport {
  state: TransportState = "closed";
  handlers: TransportEvents | null = null;
  sent: Envelope[] = [];

  async connect(_url: string, handlers: TransportEvents): Promise<void> {
    this.state = "open";
    this.handlers = handlers;
    handlers.onOpen();
  }

  send(data: string): void {
    this.sent.push(parseEnvelope(data));
  }

  close(): void {
    this.state = "closed";
  }

  receive(envelope: Envelope): void {
    this.handlers?.onMessage(JSON.stringify(envelope));
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Binding Runtime Protocol v2 assembly", () => {
  it("advertises each optional capability only when its production handler is installed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-capabilities-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: { kind: "codex", displayName: "Alice" } };
    const runtimeAdapters = new RuntimeAdapterRegistry([
      {
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      },
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      projects: new ProjectCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      protocolEventHandlers: {
        notify: async () => undefined,
      },
      writeError: () => undefined,
    });
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);

    expect(connect?.payload).toMatchObject({
      capabilities: {
        chat_meta_events: false,
        notify_signals: true,
        permission_events: false,
        history_sync: false,
      },
    });
    transport.close();
    await runtimeAdapters.close();
    await stateStore.close();
    void starting.catch(() => undefined);
  });

  it("waits for a reliable production handler before acknowledging its dseq", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-handler-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: { kind: "codex", displayName: "Alice" } };
    const runtimeAdapters = new RuntimeAdapterRegistry([
      {
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      },
    ]);
    const transport = new MemoryTransport();
    let handlerStarted = false;
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      projects: new ProjectCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      protocolEventHandlers: {
        notify: async () => {
          handlerStarted = true;
          await handlerGate;
        },
      },
      writeError: () => undefined,
    });
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "notify-1",
      emitted_at: 3,
      dseq: 1,
      payload: {
        type: "friend.added",
        entity_id: "usr_bob",
        version: 1,
        event_id: "event-1",
        message_id: "msg-1",
      },
    });
    await flush();

    try {
      expect(handlerStarted).toBe(true);
      expect(transport.sent.some((event) => event.event === EVENT.MESSAGE_SYNC_ACK)).toBe(false);
      releaseHandler?.();
      await Bun.sleep(220);
      expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    } finally {
      releaseHandler?.();
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("acknowledges durable handoff promptly and recovers unfinished messages after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-recovery-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: { kind: "codex", displayName: "Alice" } };
    const recoveredEnvelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "recovered-message",
      emitted_at: 1,
      chat_id: "chat-recovery",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-recovered",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "recover me" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: recoveredEnvelope.trace_id,
      chatId: recoveredEnvelope.chat_id,
      messageId: "msg-recovered",
      text: "recover me",
      raw: recoveredEnvelope,
    });
    const reconciledEnvelope: Envelope = {
      ...recoveredEnvelope,
      trace_id: "reconciled-message",
      chat_id: "chat-reconciled",
      payload: {
        message_id: "msg-reconciled",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "already accepted" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: reconciledEnvelope.trace_id,
      chatId: reconciledEnvelope.chat_id,
      messageId: "msg-reconciled",
      text: "already accepted",
      raw: reconciledEnvelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "chat-reconciled",
      sessionId: "session-reconciled",
      agentId: "codex",
      runtimeSessionId: "thread-reconciled",
      isCurrent: true,
      hasMessages: true,
    });
    const reconciledSession = await stateStore.getCurrentRuntimeSession("chat-reconciled", "codex");
    if (!reconciledSession) throw new Error("expected reconciled Session");
    await stateStore.upsertTranscriptBlock(reconciledSession.sessionRef, {
      id: "b_reconciled_runtime_message",
      type: "message",
      origin: "clawchat",
      state: "complete",
      plainText: "already accepted",
      role: "user",
      author: "ClawChat",
      markdown: "already accepted",
    });

    const prompts: ConnectRuntimePrompt[] = [];
    let releaseFirstPrompt: (() => void) | undefined;
    const firstPromptGate = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([
      {
        kind: "codex",
        modes: ["read-only"],
        start: async () => ({
          prompt: async function* (input: ConnectRuntimePrompt) {
            prompts.push(input);
            await input.onAccepted?.();
            if (prompts.length === 1) await firstPromptGate;
            yield {
              id: "processed",
              position: "0",
              parentId: null,
              kind: "progress",
              text: "processed",
              state: "complete",
              source: "live",
              data: { outputKind: "progress" },
            } as const;
          },
          close: mock(async () => undefined),
        }),
      },
    ]);
    const transport = new MemoryTransport();
    const errors: string[] = [];
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      projects: new ProjectCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      writeError: (message) => errors.push(message),
    });
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    for (let attempt = 0; attempt < 50 && prompts.length === 0; attempt += 1) await Bun.sleep(2);
    expect(prompts[0]?.prompt).toContain("recover me");
    await expect(stateStore.hasHandledInboundMessage("codex", "msg-recovered", recoveredEnvelope)).resolves.toBe(true);
    await expect(stateStore.hasHandledInboundMessage("codex", "msg-reconciled", reconciledEnvelope)).resolves.toBe(
      true,
    );
    expect(prompts.some((prompt) => prompt.prompt.includes("already accepted"))).toBe(false);

    const liveEnvelope: Envelope = {
      ...recoveredEnvelope,
      trace_id: "live-message",
      emitted_at: 4,
      dseq: 1,
      payload: {
        message_id: "msg-live",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "live message" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    transport.receive(liveEnvelope);

    try {
      await Bun.sleep(220);
      expect(prompts).toHaveLength(1);
      expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });

      releaseFirstPrompt?.();
      for (let attempt = 0; attempt < 50 && prompts.length < 2; attempt += 1) await Bun.sleep(2);
      expect(prompts[1]?.prompt).toContain("live message");
      for (
        let attempt = 0;
        attempt < 50 && !(await stateStore.hasHandledInboundMessage("codex", "msg-live", liveEnvelope));
        attempt += 1
      )
        await Bun.sleep(2);
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-recovered", recoveredEnvelope)).resolves.toBe(
        true,
      );
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-live", liveEnvelope)).resolves.toBe(true);
      expect(errors).toEqual([]);
    } finally {
      releaseFirstPrompt?.();
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("delivers inbound WS media fragments to the production Runtime Adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-media-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: { kind: "codex", displayName: "Alice" } };
    const prompts: ConnectRuntimePrompt[] = [];
    const runtimeAdapters = new RuntimeAdapterRegistry([
      {
        kind: "codex",
        modes: ["read-only"],
        start: async () => ({
          prompt: async function* (input: ConnectRuntimePrompt) {
            prompts.push(input);
            await Bun.sleep(10);
            yield {
              id: "media-received",
              position: "0",
              parentId: null,
              kind: "assistant",
              text: "media received",
              state: "complete",
              source: "live",
              data: { outputKind: "final" },
            } as const;
          },
          close: mock(async () => undefined),
        }),
      },
    ]);
    const transport = new MemoryTransport();
    const errors: string[] = [];
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      projects: new ProjectCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      writeError: (message) => errors.push(message),
    });
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "media-message",
      emitted_at: 3,
      dseq: 1,
      chat_id: "chat-media",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-media",
        message_mode: "normal",
        message: {
          body: {
            fragments: [
              { kind: "text", text: "What is in this image?" },
              {
                kind: "image",
                url: "https://media.example/photo.png?signature=opaque",
                name: "photo.png",
                mime: "image/png",
              },
            ],
          },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    for (let attempt = 0; attempt < 50 && prompts.length === 0; attempt += 1) await Bun.sleep(2);

    expect(prompts[0]).toMatchObject({
      trustedMediaOrigins: expect.arrayContaining(["https://media.clawling.chat"]),
      media: [
        {
          kind: "image",
          url: "https://media.example/photo.png?signature=opaque",
          name: "photo.png",
          mime: "image/png",
        },
      ],
    });
    expect(errors).toEqual([]);
    let reply = transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY);
    for (let attempt = 0; attempt < 50 && !reply; attempt += 1) {
      await Bun.sleep(2);
      reply = transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY);
    }
    expect(reply).toBeDefined();
    if (!reply) throw new Error("media reply was not sent");
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_ACK,
      trace_id: reply.trace_id,
      emitted_at: 4,
      chat_id: "chat-media",
      payload: { message_id: "reply-media", accepted_at: 4 },
    });
    await flush();
    await handle.close();
    await runtimeAdapters.close();
    await stateStore.close();
  });

  it("routes typed WS events and poison-frame quarantine through the production event seam", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-runtime-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: { kind: "codex", displayName: "Alice" } };
    const runtimeAdapters = new RuntimeAdapterRegistry([
      {
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      },
    ]);
    const transport = new MemoryTransport();
    const events: BindingProtocolEvent[] = [];
    const errors: string[] = [];
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      projects: new ProjectCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      protocolEventHandlers: {
        presence: (event) => {
          events.push(event);
        },
        quarantined: (event) => {
          events.push(event);
        },
      },
      writeError: (message) => errors.push(message),
    });
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    expect(connect.payload).toMatchObject({
      capabilities: {
        chat_meta_events: false,
        notify_signals: false,
        permission_events: false,
        history_sync: false,
      },
    });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    transport.receive({
      version: "2",
      event: EVENT.PRESENCE_UPDATE,
      trace_id: "presence-1",
      emitted_at: 3,
      payload: { user_id: "usr_bob", online: true },
    });
    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "poison-1",
      emitted_at: 4,
      dseq: 1,
      payload: { type: "friend.added" },
    });
    await flush();

    expect(events.map((event) => event.type)).toEqual(["presence", "quarantined"]);
    expect(errors.join("")).toContain("quarantined Protocol v2 notify.signal dseq=1");
    await handle.close();
    await runtimeAdapters.close();
    await stateStore.close();
  });
});
