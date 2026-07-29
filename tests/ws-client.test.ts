import { describe, expect, it, mock } from "bun:test";
import {
  type Envelope,
  EVENT,
  type MessageAddPayload,
  type MessageCreatedPayload,
  type MessageTerminalPayload,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/protocol";
import type { ConnectStateStore } from "../src/state";
import {
  ConnectWsClient,
  type ConnectWsClientOptions,
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
  const handledMessages = new Map<string, string>();
  const handledContent = (raw: unknown): string => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return JSON.stringify(raw);
    const content = { ...(raw as Record<string, unknown>) };
    for (const field of ["dseq", "emitted_at", "trace_id"]) delete content[field];
    return JSON.stringify(content);
  };
  return {
    getDeviceId: mock(async () => options.deviceId ?? null),
    setDeviceId: mock(async () => undefined),
    claimMessageOnce: mock(async () => options.claim ?? true),
    upsertInboundMessage: mock(async () => "inserted" as const),
    hasHandledInboundMessage: mock(
      async (agentId: string, messageId: string, raw: unknown) =>
        handledMessages.get(`${agentId}:${messageId}`) === handledContent(raw),
    ),
    markInboundMessageHandled: mock(async (agentId: string, messageId: string, raw: unknown) => {
      handledMessages.set(`${agentId}:${messageId}`, handledContent(raw));
    }),
    hasProtocolEvent: mock(async () => false),
    claimProtocolEvent: mock(async () => true),
    markMessageAcknowledged: mock(async () => true),
    markMessageFailed: mock(async () => true),
    beginProtocolDeliveryEpoch: mock(async () => undefined),
    recordProtocolDelivery: mock(async () => "inserted" as const),
    quarantineProtocolDelivery: mock(async () => undefined),
    advanceProtocolDelivery: mock(async () => undefined),
    getProtocolDeliveryState: mock(async () => ({
      ackEpoch: "01JXYZ8K3MNPQRSTVWXYZ0AB",
      lastReadDseq: 0,
      ackHighWater: 0,
    })),
  } as unknown as ConnectStateStore;
}

function createClient(options: Omit<ConnectWsClientOptions, "agentId">): ConnectWsClient {
  return new ConnectWsClient({ ...options, agentId: "test-binding" });
}

async function handshake(client: ConnectWsClient, transport: MemoryTransport, helloTrace = "trace-1"): Promise<void> {
  const ready = client.connect();
  await flush();
  transport.receive({
    version: "2",
    event: EVENT.CONNECT_CHALLENGE,
    trace_id: "challenge",
    emitted_at: 1,
    payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
  });
  transport.receive({
    version: "2",
    event: EVENT.HELLO_OK,
    trace_id: helloTrace,
    emitted_at: 2,
    payload: {
      device_id: "device-server",
      delivery_mode: "device_replay",
      ack_mode: "dseq",
      ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB",
    },
  });
  await ready;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ConnectWsClient", () => {
  it("validates sender routing while tolerating forward-compatible to.type values", () => {
    expect(
      parseEnvelope(
        JSON.stringify({
          version: "2",
          event: "future.event",
          trace_id: "future-1",
          emitted_at: 1,
          to: { id: "surface-1", type: "future-surface" },
          payload: {},
        }),
      ).to,
    ).toEqual({ id: "surface-1", type: "future-surface" });
    expect(() =>
      parseEnvelope(
        JSON.stringify({
          version: "2",
          event: EVENT.MESSAGE_SEND,
          trace_id: "bad-sender",
          emitted_at: 1,
          sender: { id: "usr_bob", type: "group", nick_name: "Bob" },
          payload: {},
        }),
      ),
    ).toThrow(/invalid sender/);
  });

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
    const client = createClient({
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
        nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk",
        device_id: "device-local",
        capabilities: {
          multi_device: true,
          device_replay: true,
          chat_meta_events: true,
          delivery_receipt: true,
          notify_signals: true,
          permission_events: true,
          history_sync: true,
          reliable_delivery_v2: true,
          e2ee: false,
        },
      },
    });
    expect(store.setDeviceId).toHaveBeenCalledWith("device-server");
    expect(store.beginProtocolDeliveryEpoch).toHaveBeenCalledWith("test-binding", "01JXYZ8K3MNPQRSTVWXYZ0AB");
    expect(client.connectionState).toBe("connected");
  });

  it("does not send business traffic before hello-ok", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-before-hello",
      ackTimeoutMs: 20,
      heartbeat: { enabled: false },
    });
    const ready = client.connect();
    await flush();

    await expect(client.sendTextMessage("chat-1", "too early")).rejects.toThrow(/before hello-ok/);
    expect(transport.sent).toEqual([]);

    client.close();
    await expect(ready).rejects.toThrow(/client closed/);
  });

  it("rejects hello-ok received before connect.challenge", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
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
      event: EVENT.HELLO_OK,
      trace_id: "trace-1",
      emitted_at: 2,
      payload: { ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });

    await expect(ready).rejects.toThrow(/unexpected hello-ok/);
    expect(client.connectionState).toBe("disconnected");
  });

  it("rejects a challenge whose trace or 18-byte base64url nonce is invalid", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      heartbeat: { enabled: false },
    });
    client.on("error", () => undefined);
    const ready = client.connect();
    await flush();

    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "not-challenge",
      emitted_at: 1,
      payload: { nonce: "short" },
    });

    await expect(ready).rejects.toThrow(/invalid connect.challenge/);
    expect(transport.sent).toEqual([]);
  });

  it("fails a connection that does not finish the handshake before the deadline", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      handshakeTimeoutMs: 10,
      heartbeat: { enabled: false },
    });
    client.on("error", () => undefined);

    await expect(client.connect()).rejects.toThrow(/handshake timed out/);
    expect(client.connectionState).toBe("disconnected");
  });

  it("fails the handshake when reliable-delivery epoch persistence fails", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    store.beginProtocolDeliveryEpoch = mock(async () => {
      throw new Error("database unavailable");
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-persist-failure",
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
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: "trace-persist-failure",
      emitted_at: 2,
      payload: { ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });

    await expect(ready).rejects.toThrow(/database unavailable/);
    expect(client.connectionState).toBe("disconnected");
  });

  it("backoff-reconnects with the same token when remote auth is temporarily unavailable", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "same-token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-transient-auth",
      heartbeat: { enabled: false },
      reconnect: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      reliability: { ackResendMs: 0 },
    });
    client.on("error", () => undefined);
    const ready = client.connect();
    await flush();
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_FAIL,
      trace_id: "trace-transient-auth",
      emitted_at: 2,
      payload: { reason: "remote auth service unavailable" },
    });
    await flush();
    transport.handlers?.onClose(1013, "remote auth service unavailable");
    await Bun.sleep(5);

    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 3,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: "trace-transient-auth",
      emitted_at: 4,
      payload: { ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AD" },
    });

    await expect(ready).resolves.toBeUndefined();
    expect(transport.sent.filter((event) => event.event === EVENT.CONNECT)).toHaveLength(2);
    expect(transport.sent.filter((event) => event.event === EVENT.CONNECT).at(-1)?.payload).toMatchObject({
      token: "same-token",
    });
    client.close();
  });

  it("reconnects when a heartbeat close never produces a transport close event", async () => {
    const transport = new MemoryTransport();
    const connect = mock(transport.connect.bind(transport));
    transport.connect = connect;
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-heartbeat",
      heartbeat: { intervalMs: 1, timeoutMs: 1, closeGraceMs: 1 },
      reconnect: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    client.on("error", () => undefined);

    await handshake(client, transport, "trace-heartbeat");
    await Bun.sleep(10);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(client.connectionState).toBe("challenging");
    client.close();
  });

  it("uploads media with the WebSocket bearer token and returns the response Fragment", async () => {
    const transport = new MemoryTransport();
    const mediaFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://media.example/media/upload");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      const form = init?.body as FormData;
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("photo.png");
      expect((file as File).type).toBe("image/png");
      expect(await (file as File).text()).toBe("image-bytes");
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            kind: "image",
            url: "https://cdn.example/opaque-image",
            name: "photo.png",
            mime: "image/png",
            size: 11,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      mediaUploadUrl: "https://media.example/media/upload",
      mediaFetch,
      heartbeat: { enabled: false },
    });

    await expect(
      client.uploadMedia(new Blob(["image-bytes"], { type: "image/png" }), { filename: "photo.png" }),
    ).resolves.toEqual({
      kind: "image",
      url: "https://cdn.example/opaque-image",
      name: "photo.png",
      mime: "image/png",
      size: 11,
    });
    expect(mediaFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a media upload business error even when HTTP succeeds", async () => {
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport: new MemoryTransport(),
      mediaUploadUrl: "https://media.example/media/upload",
      mediaFetch: async () =>
        new Response(JSON.stringify({ code: 41501, msg: "mime type not allowed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      heartbeat: { enabled: false },
    });

    await expect(client.uploadMedia(new Blob(["bad"]), { filename: "bad.exe" })).rejects.toThrow(
      /41501: mime type not allowed/u,
    );
  });

  it("uploads media before sending the returned Fragment in a materialized message", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      mediaUploadUrl: "https://media.example/media/upload",
      mediaFetch: async () =>
        new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: { kind: "file", url: "https://cdn.example/opaque-file", name: "report.pdf", size: 3 },
          }),
        ),
      traceIdFactory: () => "trace-media-send",
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace-media-send");

    const sending = client.sendMediaMessage(
      "chat-media",
      [{ file: new Blob(["pdf"], { type: "application/pdf" }), filename: "report.pdf" }],
      { text: "attached" },
    );
    await flush();
    const sent = transport.sent.find((envelope) => envelope.event === EVENT.MESSAGE_SEND);
    expect(sent?.payload).toMatchObject({
      message: {
        body: {
          fragments: [
            { kind: "text", text: "attached" },
            { kind: "file", url: "https://cdn.example/opaque-file", name: "report.pdf", size: 3 },
          ],
        },
      },
    });
    if (!sent) throw new Error("media message was not sent");
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_ACK,
      trace_id: sent.trace_id,
      emitted_at: 4,
      payload: { message_id: "media-message", accepted_at: 4 },
    });

    await expect(sending).resolves.toMatchObject({ event: EVENT.MESSAGE_ACK });
    client.close();
  });

  it("reuses persisted device id when no explicit device id is supplied", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
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
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    expect(transport.sent[0]).toMatchObject({ event: EVENT.CONNECT, payload: { device_id: "device-persisted" } });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: "trace-1",
      emitted_at: 2,
      payload: { ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    await ready;
  });

  it("responds to JSON ping with pong preserving trace and emitted_at", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace",
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace");
    transport.receive({ version: "2", event: EVENT.PING, trace_id: "ping-1", emitted_at: 10, payload: {} });
    await flush();
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.PONG, trace_id: "ping-1", emitted_at: 10, payload: {} });
  });

  it("rejects replay completion frames without the required trace id", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace",
      heartbeat: { enabled: false },
    });
    const errors = mock();
    client.on("error", errors);
    await handshake(client, transport, "trace");
    transport.receive({ version: "2", event: EVENT.REPLAY_DONE, trace_id: "", emitted_at: 11, payload: {} });
    await flush();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "missing trace_id" }));
  });

  it("resolves message ack and marks outbound as acknowledged", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const client = createClient({
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

  it("rejects server-only streaming state on materialized message uplinks", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-invalid-uplink",
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace-invalid-uplink");
    const payload = {
      message_mode: "normal",
      message: {
        body: { fragments: [{ kind: "text", text: "hello" }] },
        context: { mentions: [], reply: null },
        streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
      },
    } as never;

    await expect(client.sendMessageEnvelope(EVENT.MESSAGE_SEND, "chat-1", payload)).rejects.toThrow(
      /streaming must be omitted/,
    );
    client.close();
  });

  it("rejects nonconforming client message ids and nested timestamps on uplink", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-uplink-contract",
      ackTimeoutMs: 5,
      heartbeat: { enabled: false },
    });
    await handshake(client, transport, "trace-uplink-contract");
    const payload = {
      message_mode: "normal",
      message: {
        body: { fragments: [{ kind: "text", text: "hello" }] },
        context: { mentions: [], reply: null },
      },
    };

    await expect(
      client.sendMessageEnvelope(EVENT.MESSAGE_REPLY, "chat-1", {
        ...payload,
        message_id: "stream-custom-id",
      }),
    ).rejects.toThrow(/message_id must match/u);
    await expect(
      client.sendMessageEnvelope(EVENT.MESSAGE_SEND, "chat-1", {
        ...payload,
        message: { ...payload.message, created_at: 123 },
      } as never),
    ).rejects.toThrow(/timestamp field created_at/u);
    expect(() =>
      client.sendStreamCreated("chat-1", { message_id: "stream-custom-id", message_mode: "thinking" }),
    ).toThrow(/message_id must match/u);
    expect(transport.sent.filter((envelope) => envelope.event.startsWith("message."))).toEqual([]);
    client.close();
  });

  it("rejects a Protocol v2 message.error as the send negative ack", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-send",
      ackTimeoutMs: 20,
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
      payload: {
        code: "chat_not_found",
        reason: "chat not resolvable",
        rejected_at: 4,
      },
    });
    await expect(pending).rejects.toThrow(/chat_not_found: chat not resolvable/);
    expect(store.markMessageFailed).toHaveBeenCalledWith({
      messageId: "trace-send",
      protocolMessageId: null,
      rejectedAt: 4,
      error: "chat_not_found: chat not resolvable",
    });
  });

  it("skips duplicate inbound materialized messages", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore({ claim: false });
    stateStore.upsertInboundMessage = mock(async () => "duplicate" as const);
    stateStore.hasHandledInboundMessage = mock(async () => true);
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
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
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-1", type: "direct", nick_name: "User" },
      payload: {
        message_id: "msg-1",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "hi" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await flush();
    expect(seen).not.toHaveBeenCalled();
    expect(stateStore.upsertInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "test-binding", messageId: "msg-1" }),
    );
  });

  it("does not acknowledge a reliable message before its durable handoff accepts it", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    let handlerStarted = false;
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-handler",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
      messageHandler: async () => {
        handlerStarted = true;
        await handlerGate;
        return "accepted" as const;
      },
    });
    await handshake(client, transport, "trace-handler");
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "message-handler",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-1", type: "direct", nick_name: "User" },
      payload: {
        message_id: "msg-handler",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "hi" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await flush();

    expect(handlerStarted).toBe(true);
    expect(transport.sent.some((event) => event.event === EVENT.MESSAGE_SYNC_ACK)).toBe(false);
    releaseHandler?.();
    await Bun.sleep(5);
    expect(stateStore.markInboundMessageHandled).not.toHaveBeenCalled();
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    client.close();
  });

  it("retries an audited message whose production handler did not finish", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    stateStore.upsertInboundMessage = mock(async () => "duplicate" as const);
    stateStore.hasHandledInboundMessage = mock(async () => false);
    const messageHandler = mock(async () => "handled" as const);
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-retry",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
      messageHandler,
    });
    await handshake(client, transport, "trace-retry");
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "message-retry",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-1", type: "direct", nick_name: "User" },
      payload: {
        message_id: "msg-retry",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "retry me" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await Bun.sleep(5);

    expect(messageHandler).toHaveBeenCalledTimes(1);
    expect(stateStore.markInboundMessageHandled).toHaveBeenCalled();
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    client.close();
  });

  it("re-dispatches coalesced message updates but skips exact reliable duplicates", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    let deliveryCall = 0;
    stateStore.recordProtocolDelivery = mock(async () => {
      deliveryCall += 1;
      return deliveryCall === 1 ? "inserted" : deliveryCall === 2 ? "updated" : "duplicate";
    });
    stateStore.upsertInboundMessage = mock(async () =>
      deliveryCall === 1 ? "inserted" : deliveryCall === 2 ? "updated" : "duplicate",
    );
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-coalesce",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const texts: string[] = [];
    client.on("message", (message: { text: string }) => texts.push(message.text));
    await handshake(client, transport, "trace-coalesce");

    const receive = (dseq: number, text: string) =>
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_REPLY,
        trace_id: "same-logical-message",
        emitted_at: 5,
        dseq,
        chat_id: "chat-1",
        chat_type: "direct",
        sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
        payload: {
          message_id: "msg-coalesced",
          message_mode: "normal",
          message: {
            body: { fragments: [{ kind: "text", text }] },
            context: { mentions: [], reply: null },
            streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
          },
        },
      });
    receive(1, "draft");
    receive(2, "final");
    receive(3, "final");
    await flush();

    expect(texts).toEqual(["draft", "final"]);
    expect(stateStore.upsertInboundMessage).toHaveBeenCalledTimes(3);
    client.close();
  });

  it("disconnects without ack when materialized message persistence fails after raw inbox persistence", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    stateStore.upsertInboundMessage = mock(async () => {
      throw new Error("message projection unavailable");
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-materialize-message",
      heartbeat: { enabled: false },
      reconnect: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const errors: Error[] = [];
    client.on("error", (error: Error) => errors.push(error));
    await handshake(client, transport, "trace-materialize-message");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "message-materialize-failure",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-materialize-failure",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "hello" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await flush();
    await Bun.sleep(2);

    expect(client.connectionState).toBe("disconnected");
    expect(errors.at(-1)?.message).toContain("message projection unavailable");
    expect(transport.sent.some((event) => event.event === EVENT.MESSAGE_SYNC_ACK)).toBe(false);
  });

  it("acks a dseq only after the inbound frame is durably recorded", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-sync",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-sync");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "down-dseq-1",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-1", type: "direct", nick_name: "User" },
      payload: {
        message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "hi" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await Bun.sleep(10);

    expect(stateStore.recordProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ ackEpoch: "01JXYZ8K3MNPQRSTVWXYZ0AB", dseq: 1, eventType: EVENT.MESSAGE_SEND }),
    );
    expect(transport.sent.at(-1)).toMatchObject({
      event: EVENT.MESSAGE_SYNC_ACK,
      payload: { dseq: 1, epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    client.close();
  });

  it("quarantines and acknowledges a malformed dseq frame so replay can continue", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-quarantine",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const messages = mock();
    client.on("message", messages);
    await handshake(client, transport, "trace-quarantine");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "poison-1",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      payload: {},
    });
    await Bun.sleep(10);

    expect(stateStore.quarantineProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ dseq: 1, traceId: "poison-1", error: "invalid message.send payload" }),
    );
    expect(messages).not.toHaveBeenCalled();
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    client.close();
  });

  it("quarantines a dseq frame whose top-level routing cannot pass strict envelope parsing", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-routing-poison",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    client.on("error", () => undefined);
    await handshake(client, transport, "trace-routing-poison");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "bad-routing",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "group", nick_name: "Bob" },
      payload: {},
    } as unknown as Envelope);
    await flush();
    await Bun.sleep(2);

    expect(stateStore.quarantineProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ dseq: 1, error: "invalid sender" }),
    );
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    client.close();
  });

  it("quarantines materialized downlinks missing server-stamped chat and static streaming state", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-materialized-shape",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-materialized-shape");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "missing-static-shape",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-missing-static-shape",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "hello" }] },
          context: { mentions: [], reply: null },
        },
      },
    });
    await flush();
    await Bun.sleep(10);

    expect(stateStore.quarantineProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ dseq: 1, error: "invalid message.send payload" }),
    );
    client.close();
  });

  it("quarantines materialized media fragments that omit their URL", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-invalid-media",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-invalid-media");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "invalid-media",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-invalid-media",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "image", name: "missing-url.png" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await flush();
    await Bun.sleep(10);

    expect(stateStore.quarantineProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ dseq: 1, error: "invalid message.send payload" }),
    );
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    client.close();
  });

  it("disconnects when the per-connection dseq stream has a gap", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-gap",
      heartbeat: { enabled: false },
      reconnect: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    const errors = mock();
    client.on("error", errors);
    await handshake(client, transport, "trace-gap");

    transport.receive({
      version: "2",
      event: EVENT.SYNC_MARK,
      trace_id: "gap-2",
      emitted_at: 5,
      dseq: 2,
      payload: { covers_seq: 4 },
    });
    await flush();

    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "dseq gap: expected 1, received 2" }));
    expect(client.connectionState).toBe("disconnected");
    expect(stateStore.recordProtocolDelivery).not.toHaveBeenCalled();
  });

  it("advances and immediately acknowledges replay.done without persisting the control frame", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-replay",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 1_000, ackResendMs: 0 },
    });
    const replayDone = mock();
    client.on("replay_done", replayDone);
    await handshake(client, transport, "trace-replay");

    transport.receive({
      version: "2",
      event: EVENT.REPLAY_DONE,
      trace_id: "rd-1",
      emitted_at: 5,
      dseq: 1,
      payload: {},
    });
    await flush();

    expect(stateStore.advanceProtocolDelivery).toHaveBeenCalledWith("test-binding", "01JXYZ8K3MNPQRSTVWXYZ0AB", 1);
    expect(stateStore.recordProtocolDelivery).not.toHaveBeenCalled();
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    expect(replayDone).toHaveBeenCalledWith(expect.objectContaining({ event: EVENT.REPLAY_DONE }));
    client.close();
  });

  it("advances a valid sync.mark but quarantines malformed reliable control frames", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-controls",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-controls");

    transport.receive({
      version: "2",
      event: EVENT.SYNC_MARK,
      trace_id: "mark-1",
      emitted_at: 7,
      dseq: 1,
      payload: { covers_seq: 99 },
    });
    transport.receive({
      version: "2",
      event: EVENT.REPLAY_DONE,
      trace_id: "done-malformed",
      emitted_at: 8,
      dseq: 2,
      payload: { unexpected: true },
    });
    await flush();

    expect(stateStore.advanceProtocolDelivery).toHaveBeenCalledWith("test-binding", "01JXYZ8K3MNPQRSTVWXYZ0AB", 1);
    expect(stateStore.quarantineProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ dseq: 2, error: "invalid replay.done payload" }),
    );
    client.close();
  });

  it("disconnects without ack when reliable control persistence fails", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    stateStore.advanceProtocolDelivery = mock(async () => {
      throw new Error("cursor state unavailable");
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-control-failure",
      heartbeat: { enabled: false },
      reconnect: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const errors: Error[] = [];
    client.on("error", (error: Error) => errors.push(error));
    await handshake(client, transport, "trace-control-failure");

    transport.receive({
      version: "2",
      event: EVENT.REPLAY_DONE,
      trace_id: "replay-control-failure",
      emitted_at: 8,
      dseq: 1,
      payload: {},
    });
    await flush();

    expect(client.connectionState).toBe("disconnected");
    expect(errors.at(-1)?.message).toContain("cursor state unavailable");
    expect(transport.sent.some((event) => event.event === EVENT.MESSAGE_SYNC_ACK)).toBe(false);
  });

  it("serializes inbound frames so async persistence cannot create a false dseq gap", async () => {
    const transport = new MemoryTransport();
    const stateStore = createStore();
    let releaseFirst: (() => void) | undefined;
    const firstPersisted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    stateStore.recordProtocolDelivery = mock(async (input) => {
      if (input.dseq === 1) await firstPersisted;
      return "inserted" as const;
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore,
      transport,
      traceIdFactory: () => "trace-serial",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const errors = mock();
    client.on("error", errors);
    await handshake(client, transport, "trace-serial");
    const frame = (dseq: number): Envelope => ({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: `down-${dseq}`,
      emitted_at: dseq,
      dseq,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-1", type: "direct", nick_name: "User" },
      payload: {
        message_id: `msg-01HVB6S7K8L9M0N1P2Q3R4S5T${dseq}`,
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: String(dseq) }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });

    transport.receive(frame(1));
    transport.receive(frame(2));
    await flush();
    releaseFirst?.();
    await Bun.sleep(10);

    expect(errors).not.toHaveBeenCalled();
    expect(stateStore.recordProtocolDelivery).toHaveBeenCalledTimes(2);
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 2 } });
    client.close();
  });

  it("emits a delivery receipt after receiving another user's materialized message", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      userId: "usr-agent",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-receipt",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 1_000, ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-receipt");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "down-receipt",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-human", type: "direct", nick_name: "Human" },
      payload: {
        message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "hello" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await flush();

    expect(transport.sent).toContainEqual(
      expect.objectContaining({
        event: EVENT.MESSAGE_DELIVERED,
        chat_id: "chat-1",
        to: { id: "usr-human", type: "direct" },
        payload: { message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6", delivered_at: expect.any(Number) },
      }),
    );
    client.close();
  });

  it("filters the current device's multi-device self echo", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      userId: "usr-agent",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-self",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const messages = mock();
    client.on("message", messages);
    await handshake(client, transport, "trace-self");

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_REPLY,
      trace_id: "self-echo",
      emitted_at: 5,
      dseq: 1,
      chat_id: "chat-1",
      chat_type: "direct",
      origin_device_id: "device-server",
      sender: { id: "usr-agent", type: "direct", nick_name: "Agent" },
      payload: {
        message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "echo" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    await Bun.sleep(10);

    expect(messages).not.toHaveBeenCalled();
    expect(transport.sent).not.toContainEqual(expect.objectContaining({ event: EVENT.MESSAGE_DELIVERED }));
    expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    client.close();
  });

  it("validates and emits a complete inbound streaming lifecycle", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-stream",
      heartbeat: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    const events: Envelope[] = [];
    client.on("stream", (event: Envelope) => events.push(event));
    await handshake(client, transport, "trace-stream");

    const messageId = "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6";
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_CREATED,
      trace_id: "stream-created",
      emitted_at: 5,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-agent", type: "direct", nick_name: "Agent" },
      payload: { message_id: messageId, message_mode: "thinking" },
    });
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_ADD,
      trace_id: "stream-add-0",
      emitted_at: 6,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-agent", type: "direct", nick_name: "Agent" },
      payload: {
        message_id: messageId,
        sequence: 0,
        mutation: { type: "append", target_fragment_index: 0 },
        fragments: [{ kind: "text", text: "Hello", delta: "Hello" }],
        streaming: { status: "streaming", sequence: 0, mutation_policy: "append_text_only" },
        added_at: 6,
      },
    });
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_DONE,
      trace_id: "stream-done",
      emitted_at: 7,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr-agent", type: "direct", nick_name: "Agent" },
      payload: {
        message_id: messageId,
        fragments: [{ kind: "text", text: "Hello" }],
        streaming: { status: "done", sequence: 0, mutation_policy: "append_text_only", completed_at: 7 },
        completed_at: 7,
      },
    });
    await flush();

    expect(events.map((event) => event.event)).toEqual([EVENT.MESSAGE_CREATED, EVENT.MESSAGE_ADD, EVENT.MESSAGE_DONE]);
    client.close();
  });

  it("supports completing a stream without any message.add frames", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-empty-stream",
      heartbeat: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    const inbound: Envelope[] = [];
    client.on("stream", (event: Envelope) => inbound.push(event));
    await handshake(client, transport, "trace-empty-stream");
    const terminal = {
      message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T7",
      fragments: [],
      streaming: { status: "done" as const, sequence: 0, mutation_policy: "append_text_only" as const },
      completed_at: 10,
    };

    client.sendStreamCreated("chat-1", { message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T8" });
    client.sendStreamDone("chat-1", {
      ...terminal,
      message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T8",
    });
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_CREATED,
      trace_id: "empty-created",
      emitted_at: 9,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: { message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T7" },
    });
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_DONE,
      trace_id: "empty-done",
      emitted_at: 10,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: terminal,
    });
    await flush();

    expect(inbound.map((event) => event.event)).toEqual([EVENT.MESSAGE_CREATED, EVENT.MESSAGE_DONE]);
    expect(transport.sent.slice(-2).map((event) => event.event)).toEqual([EVENT.MESSAGE_CREATED, EVENT.MESSAGE_DONE]);
    client.close();
  });

  it("produces the Protocol v2 streaming lifecycle without waiting for message.ack", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: (() => {
        let next = 0;
        return () => `trace-stream-${next++}`;
      })(),
      heartbeat: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-stream-0");
    const messageId = "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6";

    client.sendStreamCreated("chat-1", { message_id: messageId, message_mode: "thinking" } as MessageCreatedPayload);
    client.sendStreamAdd("chat-1", {
      message_id: messageId,
      sequence: 0,
      mutation: { type: "append", target_fragment_index: 0 },
      fragments: [{ kind: "text", text: "Hello", delta: "Hello" }],
      streaming: { status: "streaming", sequence: 0, mutation_policy: "append_text_only" },
      added_at: 6,
    } as MessageAddPayload);
    client.sendStreamDone("chat-1", {
      message_id: messageId,
      fragments: [{ kind: "text", text: "Hello" }],
      streaming: { status: "done", sequence: 0, mutation_policy: "append_text_only", completed_at: 7 },
      completed_at: 7,
    } as MessageTerminalPayload);

    expect(transport.sent.slice(-3).map((event) => event.event)).toEqual([
      EVENT.MESSAGE_CREATED,
      EVENT.MESSAGE_ADD,
      EVENT.MESSAGE_DONE,
    ]);
    client.close();
  });

  it("sends typing and presence control events on the authenticated connection", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-control",
      heartbeat: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-control");

    client.sendTyping("chat-1", true, { toType: "group" });
    client.subscribePresence("usr_bob");
    client.unsubscribePresence("usr_bob");

    expect(transport.sent.slice(-3)).toEqual([
      expect.objectContaining({
        event: EVENT.TYPING_UPDATE,
        chat_id: "chat-1",
        to: { id: "chat-1", type: "group" },
        payload: { is_typing: true },
      }),
      expect.objectContaining({ event: EVENT.PRESENCE_SUBSCRIBE, payload: { user_id: "usr_bob" } }),
      expect.objectContaining({ event: EVENT.PRESENCE_UNSUBSCRIBE, payload: { user_id: "usr_bob" } }),
    ]);
    client.close();
  });

  it("validates and dispatches inbound typing updates and delivery receipts", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-ephemeral",
      heartbeat: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    const typing: Envelope[] = [];
    const delivered: Envelope[] = [];
    client.on("typing", (event: Envelope) => typing.push(event));
    client.on("delivered", (event: Envelope) => delivered.push(event));
    await handshake(client, transport, "trace-ephemeral");

    transport.receive({
      version: "2",
      event: EVENT.TYPING_UPDATE,
      trace_id: "typing-inbound",
      emitted_at: 5,
      chat_id: "chat-1",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: { is_typing: true },
    });
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_DELIVERED,
      trace_id: "delivered-inbound",
      emitted_at: 6,
      chat_id: "chat-1",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: { message_id: "msg_1", delivered_at: 6 },
    });
    await flush();

    expect(typing).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    client.close();
  });

  it("emits validated presence snapshots and live updates", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-presence",
      heartbeat: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    const presence: Envelope[] = [];
    client.on("presence", (event: Envelope) => presence.push(event));
    await handshake(client, transport, "trace-presence");

    transport.receive({
      version: "2",
      event: EVENT.PRESENCE_SNAPSHOT,
      trace_id: "presence-snapshot",
      emitted_at: 5,
      payload: { user_id: "usr_bob", online: false, last_seen_at: "2026-05-13T12:34:56Z" },
    });
    transport.receive({
      version: "2",
      event: EVENT.PRESENCE_UPDATE,
      trace_id: "presence-update",
      emitted_at: 6,
      payload: { user_id: "usr_bob", online: true, last_seen_at: "2026-05-13T12:35:00Z" },
    });
    await flush();

    expect(presence.map((event) => event.event)).toEqual([EVENT.PRESENCE_SNAPSHOT, EVENT.PRESENCE_UPDATE]);
    client.close();
  });

  it("restores presence subscriptions after reconnect", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-reconnect-presence",
      heartbeat: { enabled: false },
      reconnect: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      reliability: { ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-reconnect-presence");
    client.subscribePresence("usr_bob");

    transport.state = "closed";
    transport.handlers?.onClose(1006, "network lost");
    await Bun.sleep(5);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 7,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: "trace-reconnect-presence",
      emitted_at: 8,
      payload: {
        device_id: "device-server",
        delivery_mode: "device_replay",
        ack_mode: "dseq",
        ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AC",
      },
    });
    await flush();

    expect(transport.sent.filter((event) => event.event === EVENT.PRESENCE_SUBSCRIBE)).toHaveLength(2);
    client.close();
  });

  it("validates and dispatches metadata, notify, and permission signals", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    await handshake(client, transport, "trace");
    const metadata: Envelope[] = [];
    const notifications: Envelope[] = [];
    const permissions: Envelope[] = [];
    client.on("metadata_invalidated", (event: Envelope) => metadata.push(event));
    client.on("notify", (event: Envelope) => notifications.push(event));
    client.on("permission", (event: Envelope) => permissions.push(event));
    transport.receive({
      version: "2",
      event: EVENT.CHAT_METADATA_INVALIDATED,
      trace_id: "meta-1",
      emitted_at: 6,
      chat_id: "chat-1",
      chat_type: "group",
      payload: { scope: ["profile"], version: 2 },
    });
    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "notify-1",
      emitted_at: 7,
      dseq: 1,
      payload: {
        type: "friend.added",
        entity_id: "usr_bob",
        version: 3,
        event_id: "ntf_1",
        message_id: "notify:friend.added:usr_bob",
      },
    });
    transport.receive({
      version: "2",
      event: EVENT.PERMISSION_REQUEST,
      trace_id: "permission-1",
      emitted_at: 8,
      chat_id: "chat-1",
      payload: { request_id: "req_1", agent_id: "agt_assistant", operation: "read_emails" },
    });
    transport.receive({
      version: "2",
      event: EVENT.PERMISSION_RESOLVED,
      trace_id: "permission-2",
      emitted_at: 9,
      chat_id: "chat-1",
      payload: { request_id: "req_1", decision: "approved", reason: "User granted" },
    });
    await flush();

    expect(metadata).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(permissions.map((event) => event.event)).toEqual([EVENT.PERMISSION_REQUEST, EVENT.PERMISSION_RESOLVED]);
    expect(store.recordProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ eventKey: "message:notify:friend.added:usr_bob", dseq: 1 }),
    );
    client.close();
  });

  it("dispatches ClawChat interaction submissions to the Runtime Interaction handler", async () => {
    const transport = new MemoryTransport();
    const interactionSubmitHandler = mock(async () => true);
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-interaction",
      heartbeat: { enabled: false },
      interactionSubmitHandler,
    });
    await handshake(client, transport, "trace-interaction");

    transport.receive({
      version: "2",
      event: EVENT.INTERACTION_SUBMIT,
      trace_id: "interaction-submit",
      emitted_at: 5,
      chat_id: "owner-conversation",
      chat_type: "direct",
      sender: { id: "owner-1", type: "direct", nick_name: "Owner" },
      payload: {
        action: {
          payload: {
            type: "connect_runtime_interaction",
            interaction_id: "interaction-1",
            option_id: "approve-once",
          },
        },
      },
    });
    await flush();

    expect(interactionSubmitHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        event: EVENT.INTERACTION_SUBMIT,
        chat_id: "owner-conversation",
        sender: expect.objectContaining({ id: "owner-1" }),
      }),
    );
    client.close();
  });

  it("deduplicates notify.signal by event_id across reliable redelivery", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const claimedEvents = new Set<string>();
    store.hasProtocolEvent = mock(async (_agentId, eventId) => claimedEvents.has(eventId));
    store.claimProtocolEvent = mock(async () => {
      claimedEvents.add("ntf_same");
      return true;
    });
    const handled = mock(async (_envelope: Envelope) => undefined);
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-notify-dedup",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
      protocolEventHandler: async (type, envelope) => {
        if (type === "notify") await handled(envelope);
      },
    });
    const notifications: Envelope[] = [];
    client.on("notify", (event: Envelope) => notifications.push(event));
    await handshake(client, transport, "trace-notify-dedup");

    const receive = (dseq: number) =>
      transport.receive({
        version: "2",
        event: EVENT.NOTIFY_SIGNAL,
        trace_id: `notify-${dseq}`,
        emitted_at: 7,
        dseq,
        payload: {
          type: "friend.added",
          entity_id: "usr_bob",
          version: 3,
          event_id: "ntf_same",
          message_id: "notify:friend.added:usr_bob",
        },
      });
    receive(1);
    receive(2);
    await flush();

    expect(notifications).toHaveLength(1);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(store.claimProtocolEvent).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("disconnects without ack when notify event-id persistence fails", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    store.claimProtocolEvent = mock(async () => {
      throw new Error("event dedup unavailable");
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-notify-failure",
      heartbeat: { enabled: false },
      reconnect: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    client.on("error", () => undefined);
    await handshake(client, transport, "trace-notify-failure");

    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "notify-failure",
      emitted_at: 7,
      dseq: 1,
      payload: {
        type: "friend.added",
        entity_id: "usr_bob",
        version: 3,
        event_id: "ntf_failure",
        message_id: "notify:friend.added:usr_bob",
      },
    });
    await flush();
    await Bun.sleep(2);

    expect(client.connectionState).toBe("disconnected");
    expect(transport.sent.some((event) => event.event === EVENT.MESSAGE_SYNC_ACK)).toBe(false);
  });

  it("sends and durably dispatches opaque sibling-device history transit", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      userId: "usr_alice",
      userNickName: "Alice",
      deviceId: "device-old",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-history",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const history: Envelope[] = [];
    client.on("history_transit", (event: Envelope) => history.push(event));
    await handshake(client, transport, "trace-history");

    client.sendHistoryTransit(
      "device-new",
      { kind: "history_sync_request", cursor: 10 },
      { ciphertextFragments: [{ device_id: "device-new", ciphertext: "opaque" }] },
    );
    expect(transport.sent.at(-1)).toMatchObject({
      event: EVENT.HISTORY_TRANSIT,
      target_device_id: "device-new",
      sender: { id: "usr_alice", type: "direct", nick_name: "Alice" },
      origin_device_id: "device-server",
      payload: { kind: "history_sync_request", cursor: 10 },
      ciphertext_fragments: [{ device_id: "device-new", ciphertext: "opaque" }],
    });

    transport.receive({
      version: "2",
      event: EVENT.HISTORY_TRANSIT,
      trace_id: "history-inbound",
      emitted_at: 10,
      dseq: 1,
      target_device_id: "device-server",
      sender: { id: "usr_alice", type: "direct", nick_name: "Alice" },
      origin_device_id: "device-old",
      payload: { kind: "history_sync_message", batch: "opaque" },
    });
    await flush();

    expect(history).toHaveLength(1);
    expect(store.recordProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: EVENT.HISTORY_TRANSIT, dseq: 1 }),
    );
    client.close();
  });

  it("does not claim or acknowledge notify.signal when its production handler fails", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-1",
      reconnect: { enabled: false },
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
      protocolEventHandler: async (type) => {
        if (type === "notify") throw new Error("notify consumer failed");
      },
    });
    client.on("error", () => undefined);
    await handshake(client, transport);

    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "notify-handler-failed",
      emitted_at: 10,
      dseq: 1,
      payload: {
        type: "friend.added",
        entity_id: "usr_bob",
        version: 1,
        event_id: "event-handler-failed",
        message_id: "msg-handler-failed",
      },
    });
    await flush();

    expect(client.connectionState).toBe("disconnected");
    expect(store.claimProtocolEvent).not.toHaveBeenCalled();
    expect(transport.sent.some((event) => event.event === EVENT.MESSAGE_SYNC_ACK)).toBe(false);
    client.close();
  });

  it("requests a full device cursor reset without waiting for an ack", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-reset",
      heartbeat: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    await handshake(client, transport, "trace-reset");

    client.resetDeviceCursor();

    expect(transport.sent.at(-1)).toMatchObject({
      event: EVENT.DEVICE_CURSOR_RESET,
      trace_id: "trace-reset",
      payload: {},
    });
    client.close();
  });

  it("disconnects when a v2 ackable downlink omits dseq", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: createStore(),
      transport,
      traceIdFactory: () => "trace-missing-dseq",
      heartbeat: { enabled: false },
      reconnect: { enabled: false },
      reliability: { ackResendMs: 0 },
    });
    const errors: Error[] = [];
    client.on("error", (error: Error) => errors.push(error));
    await handshake(client, transport, "trace-missing-dseq");

    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "notify-without-dseq",
      emitted_at: 11,
      payload: {
        type: "friend.added",
        entity_id: "usr_bob",
        version: 3,
        event_id: "ntf_2",
        message_id: "notify:friend.added:usr_bob",
      },
    });
    await flush();

    expect(client.connectionState).toBe("disconnected");
    expect(errors.at(-1)?.message).toContain("missing dseq");
  });

  it("quarantines and acknowledges a valid dseq frame when business persistence fails", async () => {
    const transport = new MemoryTransport();
    const store = createStore();
    store.recordProtocolDelivery = mock(async () => {
      throw new Error("cannot materialize row");
    });
    const client = createClient({
      url: "ws://example/ws",
      token: "token",
      stateStore: store,
      transport,
      traceIdFactory: () => "trace-poison",
      heartbeat: { enabled: false },
      reliability: { ackDebounceMs: 0, ackResendMs: 0 },
    });
    const quarantined: unknown[] = [];
    client.on("quarantined", (event) => quarantined.push(event));
    await handshake(client, transport, "trace-poison");

    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "notify-poison",
      emitted_at: 12,
      dseq: 1,
      payload: {
        type: "friend.added",
        entity_id: "usr_bob",
        version: 4,
        event_id: "ntf_3",
        message_id: "notify:friend.added:usr_bob",
      },
    });
    await flush();
    await Bun.sleep(2);

    expect(store.quarantineProtocolDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ dseq: 1, error: "cannot materialize row" }),
    );
    expect(quarantined).toHaveLength(1);
    expect(transport.sent.at(-1)).toMatchObject({
      event: EVENT.MESSAGE_SYNC_ACK,
      payload: { dseq: 1, epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    client.close();
  });

  it("rejects malformed hello-ok payloads before marking connected", async () => {
    const transport = new MemoryTransport();
    const client = createClient({
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
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
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
