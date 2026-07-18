import { EventEmitter } from "node:events";
import { buildTextMessagePayload, normalizeInboundMessage } from "./message-mapper";
import {
  AckTimeoutError,
  AuthError,
  type ChallengePayload,
  type ChatType,
  type ConnectPayload,
  type ConnState,
  type EmptyPayload,
  type Envelope,
  EVENT,
  type HelloFailPayload,
  type HelloOkPayload,
  isChallengePayload,
  isHelloFailPayload,
  isHelloOkPayload,
  isMessageAckPayload,
  isMessageErrorPayload,
  type MessageAckPayload,
  type MessageErrorPayload,
  type MessagePayload,
  MessageSendError,
  ProtocolError,
  parseEnvelope,
  StateError,
  serializeEnvelope,
  type Transport,
  TransportError,
  type TransportEvents,
  type TransportState,
} from "./protocol";
import type { ConnectStateStore } from "./state";

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: { error?: unknown; message?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export function createWebSocketTransport(
  WebSocketCtor: WebSocketConstructor = globalThis.WebSocket as unknown as WebSocketConstructor,
): Transport {
  let state: TransportState = "closed";
  let socket: WebSocketLike | null = null;
  return {
    get state() {
      return state;
    },
    async connect(url, handlers) {
      state = "connecting";
      const activeSocket = new WebSocketCtor(url);
      socket = activeSocket;
      const isCurrent = () => socket === activeSocket;
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        let settled = false;
        const rejectBeforeOpen = (error: Error) => {
          if (opened || settled) return;
          settled = true;
          reject(error);
        };
        activeSocket.onopen = () => {
          if (!isCurrent()) return;
          opened = true;
          settled = true;
          state = "open";
          handlers.onOpen();
          resolve();
        };
        activeSocket.onmessage = (event) => {
          if (!isCurrent()) return;
          void normalizeWebSocketData(event.data).then(handlers.onMessage).catch(handlers.onError);
        };
        activeSocket.onclose = (event) => {
          if (!isCurrent()) return;
          state = "closed";
          socket = null;
          const reason = event.reason || "closed";
          handlers.onClose(event.code, reason);
          rejectBeforeOpen(new TransportError(reason));
        };
        activeSocket.onerror = (event) => {
          if (!isCurrent()) return;
          const error =
            event.error instanceof Error
              ? event.error
              : new TransportError(event.message || "websocket transport error");
          handlers.onError(error);
          rejectBeforeOpen(error);
        };
      });
    },
    send(data) {
      if (state !== "open" || !socket) throw new StateError(`cannot send while transport=${state}`);
      socket.send(data);
    },
    close(code = 1000, reason = "client close") {
      if (state === "closed") return;
      socket?.close(code, reason);
    },
  };
}

async function normalizeWebSocketData(data: unknown): Promise<string | Buffer> {
  if (typeof data === "string" || Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  throw new TransportError(`unsupported websocket message type: ${typeof data}`);
}

export interface ConnectWsClientOptions {
  url: string;
  token: string;
  stateStore: ConnectStateStore;
  deviceId?: string;
  transport?: Transport;
  traceIdFactory?: () => string;
  ackTimeoutMs?: number;
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
    maxRetries?: number;
    jitterRatio?: number;
  };
  heartbeat?: { enabled?: boolean; intervalMs?: number; timeoutMs?: number };
}

type PendingAck = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (envelope: Envelope<MessageAckPayload>) => void;
  reject: (error: Error) => void;
};

export class ConnectWsClient extends EventEmitter {
  private state: ConnState = "idle";
  private closing = false;
  private authFailed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingTraceId: string | null = null;
  private resolvedDeviceId: string | null = null;
  private connectResolve?: () => void;
  private connectReject?: (error: Error) => void;
  private expectedConnectTraceId: string | null = null;
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly transport: Transport;
  private readonly traceIdFactory: () => string;
  private readonly ackTimeoutMs: number;

  constructor(private readonly options: ConnectWsClientOptions) {
    super();
    this.transport = options.transport ?? createWebSocketTransport();
    this.traceIdFactory =
      options.traceIdFactory ?? (() => `trace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000;
  }

  get connectionState(): ConnState {
    return this.state;
  }

  async connect(): Promise<void> {
    if (this.state !== "idle" && this.state !== "disconnected")
      throw new StateError(`cannot connect from ${this.state}`);
    this.closing = false;
    this.authFailed = false;
    this.reconnectAttempts = 0;
    this.resolvedDeviceId = this.options.deviceId ?? (await this.options.stateStore.getDeviceId().catch(() => null));
    this.transition("connecting");
    const ready = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    void this.openTransport();
    return await ready;
  }

  close(): void {
    this.closing = true;
    this.clearTimers();
    this.rejectPending(new StateError("client closed"));
    this.transport.close(1000, "client close");
    this.transition("disconnected");
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    options: { toType?: ChatType } = {},
  ): Promise<Envelope<MessageAckPayload>> {
    return await this.sendMessageEnvelope(EVENT.MESSAGE_SEND, chatId, buildTextMessagePayload(text), options);
  }

  async sendMessageEnvelope(
    event: "message.send" | "message.reply",
    chatId: string,
    payload: MessagePayload,
    options: { toType?: ChatType } = {},
  ): Promise<Envelope<MessageAckPayload>> {
    if (!chatId.trim()) throw new StateError("chatId is required");
    const traceId = this.traceIdFactory();
    const envelope: Envelope<MessagePayload> = {
      version: "2",
      event,
      trace_id: traceId,
      emitted_at: Date.now(),
      chat_id: chatId,
      to: { id: chatId, type: options.toType ?? "direct" },
      payload,
    };
    await this.options.stateStore.claimMessageOnce({
      direction: "outbound",
      kind: "message",
      eventType: event,
      traceId,
      chatId,
      messageId: traceId,
      text: JSON.stringify(payload.message.body.fragments),
      raw: envelope,
    });
    return await new Promise<Envelope<MessageAckPayload>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(traceId);
        reject(new AckTimeoutError(`ack timed out for trace ${traceId}`));
      }, this.ackTimeoutMs);
      this.pendingAcks.set(traceId, { timer, resolve, reject });
      try {
        this.sendEnvelope(envelope);
      } catch (error) {
        clearTimeout(timer);
        this.pendingAcks.delete(traceId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async openTransport(): Promise<void> {
    try {
      await this.transport.connect(this.options.url, this.transportEvents());
    } catch (error) {
      this.failConnect(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private transportEvents(): TransportEvents {
    return {
      onOpen: () => undefined,
      onMessage: (data) => this.handleRawFrame(data),
      onClose: (code, reason) => {
        this.clearHeartbeat();
        this.rejectPending(new TransportError(`closed ${code}: ${reason}`));
        this.transition("disconnected");
        this.emit("close", { code, reason });
        if (!this.closing && !this.authFailed) this.scheduleReconnect();
      },
      onError: (error) => this.emit("error", error),
    };
  }

  private async handleRawFrame(data: string | Buffer): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(data);
    } catch (error) {
      this.emit("error", error);
      return;
    }
    if (envelope.event === EVENT.MESSAGE_SEND || envelope.event === EVENT.MESSAGE_REPLY) {
      const claimed = await this.options.stateStore.claimMessageOnce({
        direction: "inbound",
        kind: "message",
        eventType: envelope.event,
        traceId: envelope.trace_id,
        chatId: envelope.chat_id ?? null,
        messageId: messageIdForAudit(envelope),
        raw: envelope,
      });
      if (!claimed) return;
    } else {
      void this.options.stateStore
        .claimMessageOnce({
          direction: "inbound",
          kind: "message",
          eventType: envelope.event,
          traceId: envelope.trace_id,
          chatId: envelope.chat_id ?? null,
          messageId: messageIdForAudit(envelope),
          raw: envelope,
        })
        .catch(() => undefined);
    }
    if (envelope.event === EVENT.CONNECT_CHALLENGE) {
      if (!isChallengePayload(envelope.payload))
        return this.failConnect(new ProtocolError("invalid connect.challenge payload"));
      return this.handleChallenge(envelope as Envelope<ChallengePayload>);
    }
    if (envelope.event === EVENT.HELLO_OK) {
      if (!isHelloOkPayload(envelope.payload)) return this.failConnect(new ProtocolError("invalid hello-ok payload"));
      return this.handleHelloOk(envelope as Envelope<HelloOkPayload>);
    }
    if (envelope.event === EVENT.HELLO_FAIL) {
      if (!isHelloFailPayload(envelope.payload))
        return this.failConnect(new ProtocolError("invalid hello-fail payload"));
      return this.handleHelloFail(envelope as Envelope<HelloFailPayload>);
    }
    if (envelope.event === EVENT.PING)
      return this.sendEnvelope({
        version: "2",
        event: EVENT.PONG,
        trace_id: envelope.trace_id,
        emitted_at: envelope.emitted_at,
        payload: {} as EmptyPayload,
      });
    if (envelope.event === EVENT.PONG) return this.handlePong(envelope);
    if (envelope.event === EVENT.MESSAGE_ACK) {
      if (!isMessageAckPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid message.ack payload"));
        return;
      }
      return this.handleAck(envelope as Envelope<MessageAckPayload>);
    }
    if (envelope.event === EVENT.MESSAGE_ERROR) {
      if (!isMessageErrorPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid message.error payload"));
        return;
      }
      return this.handleMessageError(envelope as Envelope<MessageErrorPayload>);
    }
    if (envelope.event === EVENT.CHAT_METADATA_INVALIDATED) {
      this.emit("metadata_invalidated", envelope);
      return;
    }
    const inbound = normalizeInboundMessage(envelope);
    if (inbound) this.emit("message", inbound);
    else this.emit("event", envelope);
  }

  private handleChallenge(envelope: Envelope<ChallengePayload>): void {
    this.transition("authenticating");
    const traceId = this.traceIdFactory();
    this.expectedConnectTraceId = traceId;
    const payload: ConnectPayload = {
      token: this.options.token,
      nonce: envelope.payload.nonce,
      ...(this.resolvedDeviceId ? { device_id: this.resolvedDeviceId } : {}),
      capabilities: { multi_device: true, device_replay: true, chat_meta_events: true },
    };
    this.sendEnvelope({ version: "2", event: EVENT.CONNECT, trace_id: traceId, emitted_at: Date.now(), payload });
  }

  private async handleHelloOk(envelope: Envelope<HelloOkPayload>): Promise<void> {
    if (this.expectedConnectTraceId && envelope.trace_id !== this.expectedConnectTraceId)
      return this.failConnect(new ProtocolError("hello-ok trace mismatch"));
    this.reconnectAttempts = 0;
    if (envelope.payload.device_id) {
      this.resolvedDeviceId = envelope.payload.device_id;
      await this.options.stateStore.setDeviceId(envelope.payload.device_id);
    }
    this.transition("connected");
    this.startHeartbeat();
    this.connectResolve?.();
    this.clearConnectCallbacks();
    this.emit("connected", envelope.payload);
  }

  private handleHelloFail(envelope: Envelope<HelloFailPayload>): void {
    this.authFailed = true;
    this.failConnect(new AuthError(envelope.payload.reason || "authentication failed"));
    this.transport.close(1008, "authentication failed");
  }

  private async handleAck(envelope: Envelope<MessageAckPayload>): Promise<void> {
    const pending = this.pendingAcks.get(envelope.trace_id);
    if (!pending) {
      this.emit("event", envelope);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingAcks.delete(envelope.trace_id);
    await this.options.stateStore.markMessageAcknowledged({
      messageId: envelope.trace_id,
      protocolMessageId: envelope.payload.message_id,
      ackedAt: envelope.payload.accepted_at,
    });
    pending.resolve(envelope);
  }

  private handleMessageError(envelope: Envelope<MessageErrorPayload>): void {
    const pending = this.pendingAcks.get(envelope.trace_id);
    if (!pending) {
      this.emit("message_error", envelope);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingAcks.delete(envelope.trace_id);
    pending.reject(new MessageSendError(`${envelope.payload.code}: ${envelope.payload.message}`));
  }

  private startHeartbeat(): void {
    const cfg = { enabled: true, intervalMs: 30_000, timeoutMs: 10_000, ...this.options.heartbeat };
    if (!cfg.enabled) return;
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.transport.state !== "open") return;
      const traceId = this.traceIdFactory();
      this.lastPingTraceId = traceId;
      this.sendEnvelope({
        version: "2",
        event: EVENT.PING,
        trace_id: traceId,
        emitted_at: Date.now(),
        payload: {} as EmptyPayload,
      });
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.emit("error", new TransportError(`pong timed out for trace ${traceId}`));
        this.transport.close(4000, "pong timeout");
      }, cfg.timeoutMs);
    }, cfg.intervalMs);
  }

  private handlePong(envelope: Envelope): void {
    if (this.lastPingTraceId && envelope.trace_id === this.lastPingTraceId && this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.lastPingTraceId = null;
    }
    this.emit("event", envelope);
  }

  private scheduleReconnect(): void {
    const cfg = {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxRetries: Infinity,
      jitterRatio: 0.2,
      ...this.options.reconnect,
    };
    if (!cfg.enabled || this.reconnectAttempts >= cfg.maxRetries) return;
    const base = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * 2 ** this.reconnectAttempts);
    const jitter = base * cfg.jitterRatio * Math.random();
    this.reconnectAttempts += 1;
    this.transition("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      void this.openTransport();
    }, base + jitter);
  }

  private sendEnvelope(envelope: Envelope): void {
    if (this.transport.state !== "open") throw new StateError(`cannot send while transport=${this.transport.state}`);
    this.transport.send(serializeEnvelope(envelope));
  }

  private failConnect(error: Error): void {
    this.transition("disconnected");
    this.connectReject?.(error);
    this.clearConnectCallbacks();
    this.emit("error", error);
  }

  private rejectPending(error: Error): void {
    for (const [traceId, pending] of this.pendingAcks.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingAcks.delete(traceId);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.lastPingTraceId = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
  }

  private transition(next: ConnState): void {
    this.state = next;
    this.emit("state", next);
  }

  private clearConnectCallbacks(): void {
    this.connectResolve = undefined;
    this.connectReject = undefined;
    this.expectedConnectTraceId = null;
  }
}

function messageIdForAudit(envelope: Envelope): string | null {
  if (envelope.event === EVENT.MESSAGE_ACK)
    return isMessageAckPayload(envelope.payload) ? envelope.payload.message_id : envelope.trace_id;
  if (envelope.event === EVENT.MESSAGE_ERROR) return envelope.trace_id;
  const payload = envelope.payload as { message_id?: unknown };
  return typeof payload.message_id === "string" ? payload.message_id : null;
}
