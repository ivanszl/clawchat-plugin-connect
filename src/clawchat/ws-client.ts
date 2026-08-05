import { EventEmitter } from "node:events";
import type { ConnectStateStore } from "../persistence/state";
import { type MediaUploadFetch, type MediaUploadInput, uploadClawChatMedia } from "./media-api-client";
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
  type Fragment,
  type HelloFailPayload,
  type HelloOkPayload,
  type HistoryTransitPayload,
  isChallengePayload,
  isChatMetadataInvalidatedPayload,
  isHelloFailPayload,
  isHelloOkPayload,
  isHistoryTransitPayload,
  isMessageAckPayload,
  isMessageAddPayload,
  isMessageCreatedPayload,
  isMessageDeliveredPayload,
  isMessageErrorPayload,
  isMessagePayload,
  isMessageTerminalPayload,
  isNotifySignalPayload,
  isPermissionRequestPayload,
  isPermissionResolvedPayload,
  isPresencePayload,
  isTypingUpdatePayload,
  type MessageAckPayload,
  type MessageAddPayload,
  type MessageCreatedPayload,
  type MessageErrorPayload,
  type MessagePayload,
  MessageSendError,
  type MessageTerminalPayload,
  type NormalizedInboundMessage,
  ProtocolError,
  parseEnvelope,
  StateError,
  serializeEnvelope,
  type Transport,
  TransportError,
  type TransportEvents,
} from "./protocol";
import { createWebSocketTransport } from "./websocket-transport";
import {
  assertClientMessageId,
  assertPresenceUserId,
  dseqPayloadError,
  findForbiddenUplinkMessageField,
  isV2AckableDownlink,
  messageIdForAudit,
  recoverDseqPoisonEnvelope,
  streamDeltaError,
  terminalSequence,
} from "./ws-protocol-validation";

export { createWebSocketTransport, type WebSocketConstructor, type WebSocketLike } from "./websocket-transport";

export type ConnectProtocolEventType =
  | "stream"
  | "typing"
  | "presence"
  | "delivered"
  | "metadata_invalidated"
  | "notify"
  | "permission"
  | "history_transit"
  | "replay_done"
  | "message_error"
  | "unknown";

/**
 * `handled` lets the WebSocket layer persist completion before acknowledging.
 * `accepted` transfers completion ownership to a durable downstream processor,
 * allowing the reliable-delivery ACK to advance without waiting for a long turn.
 */
export type MessageHandlingResult = "accepted" | "handled";

export type { MediaUploadFetch, MediaUploadInput } from "./media-api-client";

export interface ConnectWsClientOptions {
  agentId: string;
  url: string;
  token: string;
  mediaUploadUrl?: string;
  mediaFetch?: MediaUploadFetch;
  userId?: string;
  userNickName?: string;
  stateStore: ConnectStateStore;
  deviceId?: string;
  transport?: Transport;
  traceIdFactory?: () => string;
  ackTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
    maxRetries?: number;
    jitterRatio?: number;
  };
  heartbeat?: { enabled?: boolean; intervalMs?: number; timeoutMs?: number; closeGraceMs?: number };
  reliability?: { ackDebounceMs?: number; ackResendMs?: number };
  protocolEventHandler?: (type: ConnectProtocolEventType, envelope: Envelope) => void | Promise<void>;
  messageHandler?: (message: NormalizedInboundMessage) => MessageHandlingResult | Promise<MessageHandlingResult>;
  interactionSubmitHandler?: (envelope: Envelope) => boolean | Promise<boolean>;
  capabilities?: {
    chatMetadataEvents?: boolean;
    notifySignals?: boolean;
    permissionEvents?: boolean;
    historySync?: boolean;
  };
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
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private syncAckTimer: ReturnType<typeof setTimeout> | null = null;
  private syncAckResendTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingTraceId: string | null = null;
  private resolvedDeviceId: string | null = null;
  private connectResolve?: () => void;
  private connectReject?: (error: Error) => void;
  private expectedConnectTraceId: string | null = null;
  private ackEpoch: string | null = null;
  private lastReadDseq = 0;
  private ackHighWater = 0;
  private frameQueue: Promise<void> = Promise.resolve();
  private readonly inboundStreams = new Map<string, { sequence: number; fragments: Fragment[] }>();
  private readonly outboundStreams = new Map<string, { sequence: number; fragments: Fragment[] }>();
  private readonly presenceSubscriptions = new Set<string>();
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
    this.flushSyncAck();
    this.clearTimers();
    this.rejectPending(new StateError("client closed"));
    this.connectReject?.(new StateError("client closed"));
    this.clearConnectCallbacks();
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

  async uploadMedia(file: Blob, options: { filename?: string } = {}): Promise<Fragment> {
    return await uploadClawChatMedia(
      {
        uploadUrl: this.options.mediaUploadUrl,
        token: this.options.token,
        fetch: this.options.mediaFetch,
      },
      file,
      options,
    );
  }

  async sendMediaMessage(
    chatId: string,
    uploads: readonly MediaUploadInput[],
    options: {
      text?: string;
      event?: "message.send" | "message.reply";
      toType?: ChatType;
    } = {},
  ): Promise<Envelope<MessageAckPayload>> {
    this.assertBusinessSendAllowed(chatId);
    if (uploads.length === 0) throw new ProtocolError("sendMediaMessage requires at least one media upload");
    const mediaFragments = await Promise.all(
      uploads.map(async (upload) => await this.uploadMedia(upload.file, { filename: upload.filename })),
    );
    const payload = buildTextMessagePayload(options.text ?? "");
    payload.message.body.fragments.push(...mediaFragments);
    return await this.sendMessageEnvelope(options.event ?? EVENT.MESSAGE_SEND, chatId, payload, {
      toType: options.toType,
    });
  }

  async sendMessageEnvelope(
    event: "message.send" | "message.reply",
    chatId: string,
    payload: MessagePayload,
    options: { toType?: ChatType } = {},
  ): Promise<Envelope<MessageAckPayload>> {
    if (!chatId.trim()) throw new StateError("chatId is required");
    if (this.state !== "connected") throw new StateError("cannot send business traffic before hello-ok");
    if (!isMessagePayload(payload)) throw new ProtocolError(`invalid ${event} payload`);
    if (payload.message_id !== undefined) assertClientMessageId(payload.message_id);
    if (payload.message.streaming !== undefined)
      throw new ProtocolError(`${event} payload.message.streaming must be omitted on uplink`);
    const messageRecord = payload.message as unknown as Record<string, unknown>;
    const forbiddenField = findForbiddenUplinkMessageField(messageRecord);
    if (forbiddenField) {
      throw new ProtocolError(
        forbiddenField.kind === "timestamp"
          ? `${event} payload.message contains timestamp field ${forbiddenField.field}`
          : `${event} payload.message contains server routing field ${forbiddenField.field}`,
      );
    }
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
      agentId: this.options.agentId,
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

  sendReaction(
    chatId: string,
    targetMessageId: string,
    emoji: string,
    removed = false,
    options: { toType?: ChatType } = {},
  ): void {
    if (!chatId.trim()) throw new StateError("chatId is required");
    if (!targetMessageId.trim()) throw new StateError("targetMessageId is required");
    if (!emoji.trim()) throw new StateError("emoji is required");
    if (this.state !== "connected") throw new StateError("cannot send business traffic before hello-ok");
    this.sendEnvelope({
      version: "2",
      event: EVENT.MESSAGE_REACTION,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      chat_id: chatId,
      to: { id: chatId, type: options.toType ?? "direct" },
      payload: { target_message_id: targetMessageId, emoji, removed },
    });
  }

  sendStreamCreated(chatId: string, payload: MessageCreatedPayload, options: { toType?: ChatType } = {}): void {
    this.assertBusinessSendAllowed(chatId);
    if (!isMessageCreatedPayload(payload)) throw new ProtocolError("invalid message.created payload");
    assertClientMessageId(payload.message_id);
    this.outboundStreams.set(payload.message_id, { sequence: -1, fragments: [] });
    this.sendBusinessEvent(EVENT.MESSAGE_CREATED, chatId, payload, options);
  }

  sendStreamAdd(chatId: string, payload: MessageAddPayload, options: { toType?: ChatType } = {}): void {
    this.assertBusinessSendAllowed(chatId);
    if (!isMessageAddPayload(payload)) throw new ProtocolError("invalid message.add payload");
    assertClientMessageId(payload.message_id);
    const stream = this.outboundStreams.get(payload.message_id);
    if (!stream || payload.sequence !== stream.sequence + 1)
      throw new ProtocolError("message.add sequence is not contiguous");
    const deltaError = streamDeltaError(stream.fragments, payload.fragments);
    if (deltaError) throw new ProtocolError(deltaError);
    stream.sequence = payload.sequence;
    stream.fragments = payload.fragments;
    this.sendBusinessEvent(EVENT.MESSAGE_ADD, chatId, payload, options);
  }

  sendStreamDone(chatId: string, payload: MessageTerminalPayload, options: { toType?: ChatType } = {}): void {
    this.sendStreamTerminal(EVENT.MESSAGE_DONE, chatId, payload, options);
  }

  sendStreamFailed(chatId: string, payload: MessageTerminalPayload, options: { toType?: ChatType } = {}): void {
    this.sendStreamTerminal(EVENT.MESSAGE_FAILED, chatId, payload, options);
  }

  sendTyping(chatId: string, isTyping: boolean, options: { toType?: ChatType } = {}): void {
    this.assertBusinessSendAllowed(chatId);
    this.sendEnvelope({
      version: "2",
      event: EVENT.TYPING_UPDATE,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      chat_id: chatId,
      to: { id: chatId, type: options.toType ?? "direct" },
      payload: { is_typing: isTyping },
    });
  }

  subscribePresence(userId: string): void {
    const normalized = assertPresenceUserId(userId);
    if (!this.presenceSubscriptions.has(normalized) && this.presenceSubscriptions.size >= 16)
      throw new StateError("presence subscription limit is 16");
    this.presenceSubscriptions.add(normalized);
    if (this.state === "connected") this.sendPresenceEvent(EVENT.PRESENCE_SUBSCRIBE, normalized);
  }

  unsubscribePresence(userId: string): void {
    const normalized = assertPresenceUserId(userId);
    this.presenceSubscriptions.delete(normalized);
    if (this.state === "connected") this.sendPresenceEvent(EVENT.PRESENCE_UNSUBSCRIBE, normalized);
  }

  sendHistoryTransit(
    targetDeviceId: string,
    payload: HistoryTransitPayload,
    options: { ciphertextFragments?: unknown[] } = {},
  ): void {
    if (this.state !== "connected") throw new StateError("cannot send business traffic before hello-ok");
    if (!targetDeviceId.trim()) throw new StateError("targetDeviceId is required");
    if (!this.options.userId) throw new StateError("userId is required to send history.transit");
    if (!this.resolvedDeviceId) throw new StateError("deviceId is required to send history.transit");
    if (!isHistoryTransitPayload(payload)) throw new ProtocolError("invalid history.transit payload");
    if (options.ciphertextFragments !== undefined && !Array.isArray(options.ciphertextFragments))
      throw new ProtocolError("ciphertextFragments must be an array");
    this.sendEnvelope({
      version: "2",
      event: EVENT.HISTORY_TRANSIT,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      target_device_id: targetDeviceId,
      sender: {
        id: this.options.userId,
        type: "direct",
        nick_name: this.options.userNickName ?? this.options.userId,
      },
      origin_device_id: this.resolvedDeviceId,
      ...(options.ciphertextFragments ? { ciphertext_fragments: options.ciphertextFragments } : {}),
      payload,
    });
  }

  resetDeviceCursor(): void {
    if (this.state !== "connected") throw new StateError("cannot reset device cursor before hello-ok");
    this.sendEnvelope({
      version: "2",
      event: EVENT.DEVICE_CURSOR_RESET,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      payload: {} as EmptyPayload,
    });
  }

  private async openTransport(): Promise<void> {
    const reconnecting = this.reconnectAttempts > 0;
    this.startHandshakeTimeout();
    try {
      await this.transport.connect(this.options.url, this.transportEvents());
    } catch (error) {
      this.clearHandshakeTimeout();
      this.failConnect(error instanceof Error ? error : new Error(String(error)));
      if (reconnecting && !this.reconnectTimer && !this.closing && !this.authFailed) this.scheduleReconnect();
    }
  }

  private sendStreamTerminal(
    event: "message.done" | "message.failed",
    chatId: string,
    payload: MessageTerminalPayload,
    options: { toType?: ChatType },
  ): void {
    this.assertBusinessSendAllowed(chatId);
    const status = event === EVENT.MESSAGE_DONE ? "done" : "failed";
    if (!isMessageTerminalPayload(payload, status)) throw new ProtocolError(`invalid ${event} payload`);
    assertClientMessageId(payload.message_id);
    const stream = this.outboundStreams.get(payload.message_id);
    if (!stream || payload.streaming.sequence !== terminalSequence(stream.sequence))
      throw new ProtocolError(`${event} sequence does not match the stream`);
    this.outboundStreams.delete(payload.message_id);
    this.sendBusinessEvent(event, chatId, payload, options);
  }

  private sendPresenceEvent(event: "presence.subscribe" | "presence.unsubscribe", userId: string): void {
    this.sendEnvelope({
      version: "2",
      event,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      payload: { user_id: userId },
    });
  }

  private sendBusinessEvent(
    event: "message.created" | "message.add" | "message.done" | "message.failed",
    chatId: string,
    payload: MessageCreatedPayload | MessageAddPayload | MessageTerminalPayload,
    options: { toType?: ChatType },
  ): void {
    this.sendEnvelope({
      version: "2",
      event,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      chat_id: chatId,
      to: { id: chatId, type: options.toType ?? "direct" },
      payload,
    });
  }

  private assertBusinessSendAllowed(chatId: string): void {
    if (!chatId.trim()) throw new StateError("chatId is required");
    if (this.state !== "connected") throw new StateError("cannot send business traffic before hello-ok");
  }

  private transportEvents(): TransportEvents {
    return {
      onOpen: () => {
        this.resetReliableConnection();
        this.transition("challenging");
        this.startHandshakeTimeout();
      },
      onMessage: (data) => this.enqueueRawFrame(data),
      onClose: (code, reason) => {
        this.clearHeartbeatCloseTimer();
        this.clearHandshakeTimeout();
        this.resetReliableConnection();
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
      const protocolError = error instanceof ProtocolError ? error : new ProtocolError(String(error));
      const poison = recoverDseqPoisonEnvelope(data);
      if (this.state === "connected" && this.ackEpoch) {
        if (poison?.dseq !== undefined) {
          if (poison.dseq !== this.lastReadDseq + 1) {
            this.disconnectForProtocolError(
              new ProtocolError(`dseq gap: expected ${this.lastReadDseq + 1}, received ${poison.dseq}`),
              "dseq gap",
            );
            return;
          }
          await this.quarantineDseqEnvelope(poison, poison.dseq, protocolError.message);
          return;
        }
        this.disconnectForProtocolError(protocolError, "invalid reliable frame");
        return;
      }
      this.emit("error", protocolError);
      return;
    }
    if (
      this.state === "connected" &&
      this.ackEpoch &&
      isV2AckableDownlink(envelope.event) &&
      envelope.dseq === undefined
    ) {
      this.disconnectForProtocolError(
        new ProtocolError(`${envelope.event} is missing dseq on a v2 reliable connection`),
        "missing dseq",
      );
      return;
    }
    const materializedDseq = envelope.dseq;
    if (materializedDseq !== undefined) {
      try {
        if (!(await this.recordDseqEnvelope(envelope))) return;
      } catch (error) {
        this.disconnectForProtocolError(
          new ProtocolError(
            `failed to persist dseq ${materializedDseq}: ${error instanceof Error ? error.message : String(error)}`,
          ),
          "dseq persistence failed",
        );
        return;
      }
    }
    try {
      await this.dispatchEnvelope(envelope);
    } catch (error) {
      if (materializedDseq !== undefined) {
        this.disconnectForProtocolError(
          new ProtocolError(
            `failed to materialize dseq ${materializedDseq}: ${error instanceof Error ? error.message : String(error)}`,
          ),
          "dseq materialization failed",
        );
        return;
      }
      throw error;
    }
    if (materializedDseq !== undefined) {
      this.ackHighWater = materializedDseq;
      if (envelope.event === EVENT.REPLAY_DONE) this.flushSyncAck();
      else this.scheduleSyncAck();
    }
  }

  private async dispatchEnvelope(envelope: Envelope): Promise<void> {
    if (envelope.event === EVENT.MESSAGE_SEND || envelope.event === EVENT.MESSAGE_REPLY) {
      const materialized = normalizeInboundMessage(envelope);
      const upserted = await this.options.stateStore.upsertInboundMessage({
        agentId: this.options.agentId,
        direction: "inbound",
        kind: "message",
        eventType: envelope.event,
        traceId: envelope.trace_id,
        chatId: envelope.chat_id ?? null,
        messageId: messageIdForAudit(envelope),
        text: materialized?.text ?? null,
        raw: envelope,
      });
      if (
        upserted === "duplicate" &&
        materialized &&
        (await this.options.stateStore.hasHandledInboundMessage(this.options.agentId, materialized.messageId, envelope))
      ) {
        if (materialized && this.options.userId && materialized.sender.id !== this.options.userId)
          this.sendDeliveryReceipt(materialized);
        return;
      }
    } else {
      void this.options.stateStore
        .claimMessageOnce({
          agentId: this.options.agentId,
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
      if (envelope.trace_id !== "challenge" || !isChallengePayload(envelope.payload))
        return this.failHandshake(new ProtocolError("invalid connect.challenge payload"));
      return this.handleChallenge(envelope as Envelope<ChallengePayload>);
    }
    if (envelope.event === EVENT.HELLO_OK) {
      if (!isHelloOkPayload(envelope.payload)) return this.failHandshake(new ProtocolError("invalid hello-ok payload"));
      return this.handleHelloOk(envelope as Envelope<HelloOkPayload>);
    }
    if (envelope.event === EVENT.HELLO_FAIL) {
      if (!isHelloFailPayload(envelope.payload))
        return this.failHandshake(new ProtocolError("invalid hello-fail payload"));
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
    if (envelope.event === EVENT.PONG) return await this.handlePong(envelope);
    if (envelope.event === EVENT.REPLAY_DONE) {
      await this.publishProtocolEvent("replay_done", "replay_done", envelope);
      return;
    }
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
    if (
      envelope.event === EVENT.MESSAGE_CREATED ||
      envelope.event === EVENT.MESSAGE_ADD ||
      envelope.event === EVENT.MESSAGE_DONE ||
      envelope.event === EVENT.MESSAGE_FAILED
    ) {
      await this.handleInboundStream(envelope);
      return;
    }
    if (envelope.event === EVENT.PRESENCE_SNAPSHOT || envelope.event === EVENT.PRESENCE_UPDATE) {
      if (!isPresencePayload(envelope.payload)) {
        this.emit("error", new ProtocolError(`invalid ${envelope.event} payload`));
        return;
      }
      await this.publishProtocolEvent("presence", "presence", envelope);
      return;
    }
    if (envelope.event === EVENT.TYPING_UPDATE) {
      if (!envelope.chat_id || !envelope.chat_type || !envelope.sender || !isTypingUpdatePayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid typing.update frame"));
        return;
      }
      await this.publishProtocolEvent("typing", "typing", envelope);
      return;
    }
    if (envelope.event === EVENT.MESSAGE_DELIVERED) {
      if (!envelope.chat_id || !envelope.sender || !isMessageDeliveredPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid message.delivered frame"));
        return;
      }
      await this.publishProtocolEvent("delivered", "delivered", envelope);
      return;
    }
    if (envelope.event === EVENT.CHAT_METADATA_INVALIDATED) {
      if (!envelope.chat_id || !envelope.chat_type || !isChatMetadataInvalidatedPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid chat.metadata.invalidated frame"));
        return;
      }
      await this.publishProtocolEvent("metadata_invalidated", "metadata_invalidated", envelope);
      return;
    }
    if (envelope.event === EVENT.NOTIFY_SIGNAL) {
      if (!isNotifySignalPayload(envelope.payload)) return;
      if (await this.options.stateStore.hasProtocolEvent(this.options.agentId, envelope.payload.event_id)) return;
      await this.options.protocolEventHandler?.("notify", envelope);
      if (!(await this.options.stateStore.claimProtocolEvent(this.options.agentId, envelope.payload.event_id))) return;
      this.emit("notify", envelope);
      return;
    }
    if (envelope.event === EVENT.PERMISSION_REQUEST) {
      if (!envelope.chat_id || !isPermissionRequestPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid permission.request frame"));
        return;
      }
      await this.publishProtocolEvent("permission", "permission", envelope);
      return;
    }
    if (envelope.event === EVENT.PERMISSION_RESOLVED) {
      if (!envelope.chat_id || !isPermissionResolvedPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid permission.resolved frame"));
        return;
      }
      await this.publishProtocolEvent("permission", "permission", envelope);
      return;
    }
    if (envelope.event === EVENT.INTERACTION_SUBMIT) {
      if (!envelope.chat_id || !envelope.sender) {
        this.emit("error", new ProtocolError("invalid interaction.submit frame"));
        return;
      }
      if (await this.options.interactionSubmitHandler?.(envelope)) return;
      await this.publishProtocolEvent("unknown", "event", envelope);
      return;
    }
    if (envelope.event === EVENT.HISTORY_TRANSIT) {
      await this.publishProtocolEvent("history_transit", "history_transit", envelope);
      return;
    }
    const inbound = normalizeInboundMessage(envelope);
    if (inbound) {
      if (
        this.options.userId &&
        inbound.sender.id === this.options.userId &&
        envelope.origin_device_id === this.resolvedDeviceId
      ) {
        await this.options.stateStore.markInboundMessageHandled(this.options.agentId, inbound.messageId, envelope);
        return;
      }
      const handlingResult = (await this.options.messageHandler?.(inbound)) ?? "handled";
      this.emit("message", inbound);
      if (handlingResult === "handled") {
        await this.options.stateStore.markInboundMessageHandled(this.options.agentId, inbound.messageId, envelope);
      }
      if (this.options.userId && inbound.sender.id !== this.options.userId) this.sendDeliveryReceipt(inbound);
    } else await this.publishProtocolEvent("unknown", "event", envelope);
  }

  private enqueueRawFrame(data: string | Buffer): void {
    this.frameQueue = this.frameQueue
      .then(async () => await this.handleRawFrame(data))
      .catch((error) => {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      });
  }

  private handleChallenge(envelope: Envelope<ChallengePayload>): void {
    if (this.state !== "challenging") {
      this.failHandshake(new ProtocolError(`unexpected connect.challenge while ${this.state}`));
      return;
    }
    this.transition("authenticating");
    const traceId = this.traceIdFactory();
    this.expectedConnectTraceId = traceId;
    const payload: ConnectPayload = {
      token: this.options.token,
      nonce: envelope.payload.nonce,
      ...(this.resolvedDeviceId ? { device_id: this.resolvedDeviceId } : {}),
      capabilities: {
        multi_device: true,
        device_replay: true,
        chat_meta_events: this.options.capabilities?.chatMetadataEvents ?? true,
        delivery_receipt: true,
        notify_signals: this.options.capabilities?.notifySignals ?? true,
        permission_events: this.options.capabilities?.permissionEvents ?? true,
        history_sync: this.options.capabilities?.historySync ?? true,
        reliable_delivery_v2: true,
        e2ee: false,
      },
    };
    this.sendEnvelope({ version: "2", event: EVENT.CONNECT, trace_id: traceId, emitted_at: Date.now(), payload });
  }

  private async handleHelloOk(envelope: Envelope<HelloOkPayload>): Promise<void> {
    if (this.state !== "authenticating")
      return this.failHandshake(new ProtocolError(`unexpected hello-ok while ${this.state}`));
    if (!this.expectedConnectTraceId || envelope.trace_id !== this.expectedConnectTraceId)
      return this.failHandshake(new ProtocolError("hello-ok trace mismatch"));
    try {
      await this.options.stateStore.beginProtocolDeliveryEpoch(this.options.agentId, envelope.payload.ack_epoch);
      if (envelope.payload.device_id) await this.options.stateStore.setDeviceId(envelope.payload.device_id);
    } catch (error) {
      this.failHandshake(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.clearHandshakeTimeout();
    this.ackEpoch = envelope.payload.ack_epoch;
    this.startSyncAckResend();
    this.reconnectAttempts = 0;
    if (envelope.payload.device_id) this.resolvedDeviceId = envelope.payload.device_id;
    this.transition("connected");
    for (const userId of this.presenceSubscriptions) this.sendPresenceEvent(EVENT.PRESENCE_SUBSCRIBE, userId);
    this.startHeartbeat();
    this.connectResolve?.();
    this.clearConnectCallbacks();
    this.emit("connected", envelope.payload);
  }

  private handleHelloFail(envelope: Envelope<HelloFailPayload>): void {
    if (this.state !== "authenticating") {
      this.failHandshake(new ProtocolError(`unexpected hello-fail while ${this.state}`));
      return;
    }
    if (!this.expectedConnectTraceId || envelope.trace_id !== this.expectedConnectTraceId) {
      this.failHandshake(new ProtocolError("hello-fail trace mismatch"));
      return;
    }
    this.clearHandshakeTimeout();
    if (envelope.payload.reason === "remote auth service unavailable") {
      this.emit("error", new AuthError(envelope.payload.reason));
      this.transport.close(1013, envelope.payload.reason);
      return;
    }
    this.authFailed = true;
    this.failConnect(new AuthError(envelope.payload.reason || "authentication failed"));
    this.transport.close(1008, "authentication failed");
  }

  private async handleAck(envelope: Envelope<MessageAckPayload>): Promise<void> {
    const pending = this.pendingAcks.get(envelope.trace_id);
    if (!pending) {
      await this.publishProtocolEvent("unknown", "event", envelope);
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

  private async handleMessageError(envelope: Envelope<MessageErrorPayload>): Promise<void> {
    const detail = envelope.payload.reason
      ? `${envelope.payload.code}: ${envelope.payload.reason}`
      : envelope.payload.code;
    try {
      await this.options.stateStore.markMessageFailed({
        messageId: envelope.trace_id,
        protocolMessageId: envelope.payload.message_id || null,
        rejectedAt: envelope.payload.rejected_at,
        error: detail,
      });
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
    const pending = this.pendingAcks.get(envelope.trace_id);
    if (!pending) {
      await this.publishProtocolEvent("message_error", "message_error", envelope);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingAcks.delete(envelope.trace_id);
    pending.reject(new MessageSendError(detail));
  }

  private startHeartbeat(): void {
    const cfg = {
      enabled: true,
      intervalMs: 30_000,
      timeoutMs: 10_000,
      closeGraceMs: 1_000,
      ...this.options.heartbeat,
    };
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
        this.clearHeartbeatCloseTimer();
        this.heartbeatCloseTimer = setTimeout(() => {
          this.heartbeatCloseTimer = null;
          if (this.closing || this.state !== "connected") return;
          this.resetReliableConnection();
          this.clearHeartbeat();
          this.rejectPending(new TransportError("closed 4000: pong timeout"));
          this.transition("disconnected");
          this.emit("close", { code: 4000, reason: "pong timeout" });
          this.scheduleReconnect();
        }, cfg.closeGraceMs);
      }, cfg.timeoutMs);
    }, cfg.intervalMs);
  }

  private async handlePong(envelope: Envelope): Promise<void> {
    if (this.lastPingTraceId && envelope.trace_id === this.lastPingTraceId && this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.lastPingTraceId = null;
    }
    await this.publishProtocolEvent("unknown", "event", envelope);
  }

  private sendDeliveryReceipt(message: NormalizedInboundMessage): void {
    this.sendEnvelope({
      version: "2",
      event: EVENT.MESSAGE_DELIVERED,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      chat_id: message.chatId,
      to: { id: message.sender.id, type: "direct" },
      payload: { message_id: message.messageId, delivered_at: Date.now() },
    });
  }

  private async handleInboundStream(envelope: Envelope): Promise<void> {
    if (!envelope.chat_id || !envelope.chat_type || !envelope.sender) {
      this.emit("error", new ProtocolError(`invalid ${envelope.event} routing`));
      return;
    }
    if (
      this.options.userId &&
      envelope.sender.id === this.options.userId &&
      envelope.origin_device_id === this.resolvedDeviceId
    )
      return;
    if (envelope.event === EVENT.MESSAGE_CREATED) {
      if (!isMessageCreatedPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid message.created payload"));
        return;
      }
      this.inboundStreams.set(envelope.payload.message_id, { sequence: -1, fragments: [] });
      await this.publishProtocolEvent("stream", "stream", envelope);
      return;
    }
    if (envelope.event === EVENT.MESSAGE_ADD) {
      if (!isMessageAddPayload(envelope.payload)) {
        this.emit("error", new ProtocolError("invalid message.add payload"));
        return;
      }
      const stream = this.inboundStreams.get(envelope.payload.message_id);
      if (!stream || envelope.payload.sequence !== stream.sequence + 1) {
        this.emit("error", new ProtocolError("message.add sequence is not contiguous"));
        return;
      }
      const deltaError = streamDeltaError(stream.fragments, envelope.payload.fragments);
      if (deltaError) {
        this.emit("error", new ProtocolError(deltaError));
        return;
      }
      stream.sequence = envelope.payload.sequence;
      stream.fragments = envelope.payload.fragments;
      await this.publishProtocolEvent("stream", "stream", envelope);
      return;
    }
    const status = envelope.event === EVENT.MESSAGE_DONE ? "done" : "failed";
    if (!isMessageTerminalPayload(envelope.payload, status)) {
      this.emit("error", new ProtocolError(`invalid ${envelope.event} payload`));
      return;
    }
    const stream = this.inboundStreams.get(envelope.payload.message_id);
    if (!stream || envelope.payload.streaming.sequence !== terminalSequence(stream.sequence)) {
      this.emit("error", new ProtocolError(`${envelope.event} sequence does not match the stream`));
      return;
    }
    this.inboundStreams.delete(envelope.payload.message_id);
    await this.publishProtocolEvent("stream", "stream", envelope);
  }

  private async recordDseqEnvelope(envelope: Envelope): Promise<boolean> {
    if (!this.ackEpoch) {
      this.disconnectForProtocolError(
        new ProtocolError("received dseq before reliable-delivery negotiation"),
        "unexpected dseq",
      );
      return false;
    }
    const dseq = envelope.dseq;
    if (dseq !== this.lastReadDseq + 1) {
      this.disconnectForProtocolError(
        new ProtocolError(`dseq gap: expected ${this.lastReadDseq + 1}, received ${dseq}`),
        "dseq gap",
      );
      return false;
    }
    const validationError = dseqPayloadError(envelope);
    if (validationError) return await this.quarantineDseqEnvelope(envelope, dseq, validationError);
    if (envelope.event === EVENT.SYNC_MARK || envelope.event === EVENT.REPLAY_DONE) {
      await this.options.stateStore.advanceProtocolDelivery(this.options.agentId, this.ackEpoch, dseq);
      this.lastReadDseq = dseq;
      if (envelope.event === EVENT.SYNC_MARK) {
        this.ackHighWater = dseq;
        this.scheduleSyncAck();
        return false;
      }
      return true;
    }
    const messageId = messageIdForAudit(envelope);
    try {
      const result = await this.options.stateStore.recordProtocolDelivery({
        agentId: this.options.agentId,
        ackEpoch: this.ackEpoch,
        dseq,
        eventKey: messageId ? `message:${messageId}` : `${envelope.event}:${envelope.trace_id}`,
        eventType: envelope.event,
        traceId: envelope.trace_id,
        chatId: envelope.chat_id ?? null,
        messageId,
        raw: envelope,
      });
      this.lastReadDseq = dseq;
      this.emit("delivery_persisted", { envelope, result });
      return true;
    } catch (error) {
      return await this.quarantineDseqEnvelope(envelope, dseq, error instanceof Error ? error.message : String(error));
    }
  }

  private async publishProtocolEvent(
    type: ConnectProtocolEventType,
    eventName: string,
    envelope: Envelope,
  ): Promise<void> {
    await this.options.protocolEventHandler?.(type, envelope);
    this.emit(eventName, envelope);
  }

  private async quarantineDseqEnvelope(envelope: Envelope, dseq: number, error: string): Promise<false> {
    if (!this.ackEpoch) return false;
    try {
      await this.options.stateStore.quarantineProtocolDelivery({
        agentId: this.options.agentId,
        ackEpoch: this.ackEpoch,
        dseq,
        eventType: envelope.event,
        traceId: envelope.trace_id,
        raw: envelope,
        error,
      });
    } catch (quarantineError) {
      this.disconnectForProtocolError(
        new ProtocolError(
          `failed to quarantine dseq ${dseq}: ${
            quarantineError instanceof Error ? quarantineError.message : String(quarantineError)
          }`,
        ),
        "quarantine persistence failed",
      );
      return false;
    }
    this.lastReadDseq = dseq;
    this.ackHighWater = dseq;
    this.scheduleSyncAck();
    this.emit("quarantined", { envelope, error });
    return false;
  }

  private scheduleSyncAck(): void {
    if (this.syncAckTimer) clearTimeout(this.syncAckTimer);
    const delay = this.options.reliability?.ackDebounceMs ?? 200;
    this.syncAckTimer = setTimeout(() => this.flushSyncAck(), Math.max(0, delay));
  }

  private flushSyncAck(): void {
    if (!this.ackEpoch || this.ackHighWater <= 0 || this.transport.state !== "open") return;
    if (this.syncAckTimer) clearTimeout(this.syncAckTimer);
    this.syncAckTimer = null;
    this.sendEnvelope({
      version: "2",
      event: EVENT.MESSAGE_SYNC_ACK,
      trace_id: this.traceIdFactory(),
      emitted_at: Date.now(),
      payload: { dseq: this.ackHighWater, epoch: this.ackEpoch },
    });
  }

  private startSyncAckResend(): void {
    this.clearReliabilityTimers();
    const interval = this.options.reliability?.ackResendMs ?? 30_000;
    if (interval <= 0) return;
    this.syncAckResendTimer = setInterval(() => this.flushSyncAck(), interval);
    this.syncAckResendTimer.unref?.();
  }

  private clearReliabilityTimers(): void {
    if (this.syncAckTimer) clearTimeout(this.syncAckTimer);
    if (this.syncAckResendTimer) clearInterval(this.syncAckResendTimer);
    this.syncAckTimer = null;
    this.syncAckResendTimer = null;
  }

  private resetReliableConnection(): void {
    this.clearReliabilityTimers();
    this.ackEpoch = null;
    this.lastReadDseq = 0;
    this.ackHighWater = 0;
  }

  private disconnectForProtocolError(error: ProtocolError, reason: string): void {
    this.clearTimers();
    this.resetReliableConnection();
    this.rejectPending(error);
    this.transition("disconnected");
    this.emit("error", error);
    this.transport.close(1002, reason);
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
      this.reconnectTimer = null;
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

  private failHandshake(error: Error): void {
    this.clearHandshakeTimeout();
    this.failConnect(error);
    this.transport.close(1002, "protocol handshake error");
  }

  private startHandshakeTimeout(): void {
    this.clearHandshakeTimeout();
    this.handshakeTimer = setTimeout(
      () => this.failHandshake(new TransportError("websocket handshake timed out")),
      this.options.handshakeTimeoutMs ?? 10_000,
    );
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
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

  private clearHeartbeatCloseTimer(): void {
    if (this.heartbeatCloseTimer) clearTimeout(this.heartbeatCloseTimer);
    this.heartbeatCloseTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHandshakeTimeout();
    this.clearReliabilityTimers();
    this.clearHeartbeat();
    this.clearHeartbeatCloseTimer();
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
