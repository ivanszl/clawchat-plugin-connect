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
            yield { kind: "final", text: "media received" } as const;
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
    const reply = transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY);
    if (reply) {
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_ACK,
        trace_id: reply.trace_id,
        emitted_at: 4,
        chat_id: "chat-media",
        payload: { message_id: "reply-media", accepted_at: 4 },
      });
      await flush();
    }
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
      onProtocolEvent: (event) => {
        events.push(event);
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
        chat_meta_events: true,
        notify_signals: true,
        permission_events: true,
        history_sync: true,
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
