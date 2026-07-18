import { describe, expect, it, mock } from "bun:test";
import {
  type Envelope,
  EVENT,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/protocol";
import type { ConnectStateStore } from "../src/state";
import {
  ConnectWsClient,
  createWebSocketTransport,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../src/ws-client";

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

class BunWebSocketFake implements WebSocketLike {
  static last: BunWebSocketFake | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: { error?: unknown; message?: string }) => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];

  constructor(readonly url: string) {
    BunWebSocketFake.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
  }
}

function createStore(options: { deviceId?: string; claim?: boolean } = {}): ConnectStateStore {
  return {
    getDeviceId: mock(async () => options.deviceId ?? null),
    setDeviceId: mock(async () => undefined),
    claimMessageOnce: mock(async () => options.claim ?? true),
    markMessageAcknowledged: mock(async () => true),
  } as unknown as ConnectStateStore;
}

async function handshake(client: ConnectWsClient, transport: MemoryTransport, helloTrace = "trace-1"): Promise<void> {
  const ready = client.connect();
  await flush();
  transport.receive({
    version: "2",
    event: EVENT.CONNECT_CHALLENGE,
    trace_id: "challenge",
    emitted_at: 1,
    payload: { nonce: "nonce-1" },
  });
  transport.receive({
    version: "2",
    event: EVENT.HELLO_OK,
    trace_id: helloTrace,
    emitted_at: 2,
    payload: { device_id: "device-server", delivery_mode: "device_replay" },
  });
  await ready;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ConnectWsClient", () => {
  it("uses Bun's browser-style WebSocket client", async () => {
    const transport = createWebSocketTransport(BunWebSocketFake as WebSocketConstructor);
    const onOpen = mock();
    const onMessage = mock();
    const onClose = mock();
    const onError = mock();
    const connecting = transport.connect("ws://example/ws", { onOpen, onMessage, onClose, onError });
    const socket = BunWebSocketFake.last;
    if (!socket) throw new Error("WebSocket constructor was not called");

    socket.onopen?.();
    await connecting;
    socket.onmessage?.({ data: new TextEncoder().encode("hello").buffer });
    await Bun.sleep(0);
    transport.send("outbound");
    transport.close();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(Buffer.from("hello"));
    expect(onError).not.toHaveBeenCalled();
    expect(socket.sent).toEqual(["outbound"]);
    expect(socket.closeCalls).toEqual([[1000, "client close"]]);
  });

  it("performs Protocol v2 challenge handshake and stores device id", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token-1",
      deviceId: "device-local",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-1",
      heartbeat: { enabled: false },
    });
    await handshake(client, transport);
    expect(transport.sent[0]).toMatchObject({
      event: EVENT.CONNECT,
      payload: {
        token: "token-1",
        nonce: "nonce-1",
        device_id: "device-local",
        capabilities: { chat_meta_events: true },
      },
    });
    expect(store.setDeviceId).toHaveBeenCalledWith("device-server");
    expect(client.connectionState).toBe("connected");
  });

  it("reuses persisted device id when no explicit device id is supplied", async () => {
    const transport = new MemoryTransport();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore({ deviceId: "device-persisted" }),
      transport,
      traceIdFactory: () => "trace-1",
      heartbeat: { enabled: false },
    });
    const ready = client.connect();
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "nonce" },
    });
    expect(transport.sent[0]).toMatchObject({ event: EVENT.CONNECT, payload: { device_id: "device-persisted" } });
    transport.receive({ version: "2", event: EVENT.HELLO_OK, trace_id: "trace-1", emitted_at: 2, payload: {} });
    await ready;
  });

  it("responds to JSON ping with pong preserving trace and emitted_at", async () => {
    const transport = new MemoryTransport();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace",
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace");
    transport.receive({ version: "2", event: EVENT.PING, trace_id: "ping-1", emitted_at: 10, payload: {} });
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.PONG, trace_id: "ping-1", emitted_at: 10, payload: {} });
  });

  it("resolves message ack and marks outbound as acknowledged", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-send",
      ackTimeoutMs: 1000,
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace-send");
    const ackPromise = client.sendTextMessage("chat-1", "hello");
    await flush();
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SEND, chat_id: "chat-1" });
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_ACK,
      trace_id: "trace-send",
      emitted_at: 3,
      chat_id: "chat-1",
      payload: { message_id: "msg-1", accepted_at: 3 },
    });
    await expect(ackPromise).resolves.toMatchObject({ payload: { message_id: "msg-1" } });
    expect(store.markMessageAcknowledged).toHaveBeenCalledWith({
      messageId: "trace-send",
      protocolMessageId: "msg-1",
      ackedAt: 3,
    });
  });

  it("rejects message.error as negative ack", async () => {
    const transport = new MemoryTransport();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-send",
      ackTimeoutMs: 1000,
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace-send");
    const pending = client.sendTextMessage("missing-chat", "hello");
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_ERROR,
      trace_id: "trace-send",
      emitted_at: 4,
      chat_id: "missing-chat",
      payload: { code: "chat_not_found", message: "chat not resolvable" },
    });
    await expect(pending).rejects.toThrow(/chat_not_found/);
  });

  it("skips duplicate inbound materialized messages", async () => {
    const transport = new MemoryTransport();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore({ claim: false }),
      transport,
      traceIdFactory: () => "trace",
      heartbeat: { enabled: false },
    });
    const seen = mock();
    client.on("message", seen);
    await handshake(client, transport, "trace");
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "down-1",
      emitted_at: 5,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-1", type: "direct", nick_name: "User" },
      payload: {
        message_id: "msg-1",
        message_mode: "normal",
        message: { body: { fragments: [{ kind: "text", text: "hi" }] }, context: { mentions: [], reply: null } },
      },
    });
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });

  it("emits metadata invalidation events when capability is advertised", async () => {
    const transport = new MemoryTransport();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace",
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace");
    const seen = new Promise((resolve) => client.once("metadata_invalidated", resolve));
    transport.receive({
      version: "2",
      event: EVENT.CHAT_METADATA_INVALIDATED,
      trace_id: "meta-1",
      emitted_at: 6,
      payload: { scope: ["profile"], version: 2 },
    });
    await expect(seen).resolves.toMatchObject({ event: EVENT.CHAT_METADATA_INVALIDATED });
  });

  it("rejects malformed hello-ok payloads before marking connected", async () => {
    const transport = new MemoryTransport();
    const client = new ConnectWsClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-1",
      heartbeat: { enabled: false },
    });
    client.on("error", () => undefined);
    const ready = client.connect();
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "nonce" },
    });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: "trace-1",
      emitted_at: 2,
      payload: { device_id: 123 } as never,
    });
    await expect(ready).rejects.toThrow(/invalid hello-ok payload/);
    expect(client.connectionState).toBe("disconnected");
  });
});
