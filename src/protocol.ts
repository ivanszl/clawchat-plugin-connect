export const EVENT = {
  CONNECT_CHALLENGE: "connect.challenge",
  CONNECT: "connect",
  HELLO_OK: "hello-ok",
  HELLO_FAIL: "hello-fail",
  MESSAGE_SEND: "message.send",
  MESSAGE_ACK: "message.ack",
  MESSAGE_ERROR: "message.error",
  MESSAGE_DELIVERED: "message.delivered",
  MESSAGE_REPLY: "message.reply",
  MESSAGE_REACTION: "message.reaction",
  MESSAGE_CREATED: "message.created",
  MESSAGE_ADD: "message.add",
  MESSAGE_DONE: "message.done",
  MESSAGE_FAILED: "message.failed",
  TYPING_UPDATE: "typing.update",
  PRESENCE_SUBSCRIBE: "presence.subscribe",
  PRESENCE_UNSUBSCRIBE: "presence.unsubscribe",
  PRESENCE_SNAPSHOT: "presence.snapshot",
  PRESENCE_UPDATE: "presence.update",
  CHAT_METADATA_INVALIDATED: "chat.metadata.invalidated",
  NOTIFY_SIGNAL: "notify.signal",
  PERMISSION_REQUEST: "permission.request",
  PERMISSION_RESOLVED: "permission.resolved",
  INTERACTION_SUBMIT: "interaction.submit",
  HISTORY_TRANSIT: "history.transit",
  DEVICE_CURSOR_RESET: "device.cursor.reset",
  REPLAY_DONE: "replay.done",
  MESSAGE_SYNC_ACK: "message.sync_ack",
  SYNC_MARK: "sync.mark",
  PING: "ping",
  PONG: "pong",
} as const;

export type KnownEventName = (typeof EVENT)[keyof typeof EVENT];
export type EventName = KnownEventName | string;
export type ChatType = "direct" | "group";
export type ConnState =
  | "idle"
  | "connecting"
  | "challenging"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "disconnected";
export type TransportState = "closed" | "connecting" | "open";

export interface TransportEvents {
  onOpen: () => void;
  onMessage: (data: string | Buffer) => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: Error) => void;
}

export interface Transport {
  readonly state: TransportState;
  connect(url: string, handlers: TransportEvents): Promise<void>;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Routing {
  id: string;
  type: string;
}
export interface Sender {
  id: string;
  type: "direct";
  nick_name: string;
}

export interface Envelope<TPayload = unknown> {
  version: "2";
  event: EventName;
  trace_id: string;
  emitted_at: number;
  chat_id?: string;
  chat_type?: ChatType;
  to?: Routing;
  sender?: Sender;
  origin_device_id?: string;
  target_device_id?: string;
  ciphertext_fragments?: unknown[];
  dseq?: number;
  payload: TPayload;
}

export interface ConnectCapabilities {
  multi_device?: boolean;
  device_replay?: boolean;
  chat_meta_events?: boolean;
  delivery_receipt?: boolean;
  notify_signals?: boolean;
  permission_events?: boolean;
  history_sync?: boolean;
  reliable_delivery_v2?: boolean;
  e2ee?: boolean;
}
export interface ChallengePayload {
  nonce: string;
}
export interface ConnectPayload {
  token: string;
  nonce: string;
  device_id?: string;
  capabilities?: ConnectCapabilities;
}
export interface HelloOkPayload {
  device_id?: string;
  delivery_mode?: string;
  ack_mode: "dseq";
  ack_epoch: string;
}
export interface HelloFailPayload {
  reason: string;
}
export interface MessageAckPayload {
  message_id: string;
  accepted_at: number;
}
export interface MessageErrorPayload {
  message_id?: string;
  code: string;
  reason?: string;
  rejected_at: number;
}
export type EmptyPayload = Record<string, never>;
export interface SyncMarkPayload {
  covers_seq: number;
}

export type Fragment =
  | { kind: "text"; text: string; delta?: string }
  | { kind: "mention"; user_id?: string; display?: string }
  | { kind: "image"; url: string; name?: string; mime?: string; size?: number; width?: number; height?: number }
  | { kind: "file"; url: string; name?: string; mime?: string; size?: number }
  | { kind: "audio"; url: string; name?: string; mime?: string; size?: number; duration?: number }
  | {
      kind: "video";
      url: string;
      name?: string;
      mime?: string;
      size?: number;
      width?: number;
      height?: number;
      duration?: number;
    }
  | { kind: string; [field: string]: unknown };

export interface MessageContext {
  mentions: unknown[];
  reply: {
    reply_to_msg_id: string;
    reply_preview: { id: string; nick_name: string; fragments: Fragment[] } | null;
  } | null;
}

export interface MessagePayload {
  message_id?: string;
  message_mode: string;
  message: {
    body: { fragments: Fragment[] };
    context: MessageContext;
    streaming?: {
      status: string;
      sequence: number;
      mutation_policy: string;
      started_at?: number | null;
      completed_at?: number | null;
    };
  };
}

export interface MessageCreatedPayload {
  message_id: string;
  message_mode?: string;
}
export interface MessageAddPayload {
  message_id: string;
  sequence: number;
  mutation: { type: "append"; target_fragment_index: number };
  fragments: Fragment[];
  streaming: {
    status: "streaming";
    sequence: number;
    mutation_policy: "append_text_only";
    started_at?: number | null;
    completed_at?: number | null;
  };
  added_at?: number;
}
export interface MessageTerminalPayload {
  message_id: string;
  fragments: Fragment[];
  streaming: {
    status: "done" | "failed";
    sequence: number;
    mutation_policy: "append_text_only";
    started_at?: number | null;
    completed_at?: number | null;
  };
  completed_at: number;
}

export interface PresencePayload {
  user_id: string;
  online: boolean;
  last_seen_at?: string;
}

export interface TypingUpdatePayload {
  is_typing: boolean;
}

export interface MessageDeliveredPayload {
  message_id: string;
  delivered_at: number;
}

export interface ChatMetadataInvalidatedPayload {
  scope?: string[];
  version?: number;
  updated_at?: number;
}

export interface NotifySignalPayload {
  type: string;
  entity_id: string;
  version: number;
  event_id: string;
  message_id: string;
}

export interface PermissionRequestPayload {
  request_id: string;
  agent_id?: string;
  operation?: string;
  target?: Record<string, unknown>;
  expires_at?: number;
}

export interface PermissionResolvedPayload {
  request_id: string;
  decision?: string;
  reason?: string;
}

export interface HistoryTransitPayload {
  kind: string;
  [field: string]: unknown;
}

export interface NormalizedInboundMessage {
  event: "message.send" | "message.reply";
  chatId: string;
  chatType: ChatType;
  messageId: string;
  traceId: string;
  sender: Sender;
  emittedAt: number;
  text: string;
  fragments: Fragment[];
  mentions: string[];
  replyToMessageId: string | null;
  raw: Envelope<MessagePayload>;
}

export class AuthError extends Error {
  override name = "AuthError";
}
export class TransportError extends Error {
  override name = "TransportError";
}
export class ProtocolError extends Error {
  override name = "ProtocolError";
}
export class StateError extends Error {
  override name = "StateError";
}
export class AckTimeoutError extends Error {
  override name = "AckTimeoutError";
}
export class MessageSendError extends Error {
  override name = "MessageSendError";
}

export function parseEnvelope(data: string | Buffer): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  } catch (error) {
    throw new ProtocolError(`invalid websocket JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new ProtocolError("websocket frame is not an object");
  const record = parsed as Record<string, unknown>;
  if (record.version !== "2") throw new ProtocolError("unsupported protocol version");
  if (typeof record.event !== "string" || !record.event) throw new ProtocolError("missing event");
  if (typeof record.trace_id !== "string" || !record.trace_id) throw new ProtocolError("missing trace_id");
  if (typeof record.emitted_at !== "number" || !Number.isFinite(record.emitted_at))
    throw new ProtocolError("missing emitted_at");
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload))
    throw new ProtocolError("missing payload");
  if (record.chat_id !== undefined && typeof record.chat_id !== "string") throw new ProtocolError("invalid chat_id");
  if (record.chat_type !== undefined && record.chat_type !== "direct" && record.chat_type !== "group")
    throw new ProtocolError("invalid chat_type");
  const to = objectRecord(record.to);
  if (record.to !== undefined && (!to || !nonEmptyString(to.id) || !nonEmptyString(to.type)))
    throw new ProtocolError("invalid to");
  const sender = objectRecord(record.sender);
  if (
    record.sender !== undefined &&
    (!sender || !nonEmptyString(sender.id) || sender.type !== "direct" || typeof sender.nick_name !== "string")
  )
    throw new ProtocolError("invalid sender");
  if (record.origin_device_id !== undefined && !nonEmptyString(record.origin_device_id))
    throw new ProtocolError("invalid origin_device_id");
  if (record.target_device_id !== undefined && !nonEmptyString(record.target_device_id))
    throw new ProtocolError("invalid target_device_id");
  if (record.ciphertext_fragments !== undefined && !Array.isArray(record.ciphertext_fragments))
    throw new ProtocolError("invalid ciphertext_fragments");
  if (record.dseq !== undefined && (!Number.isSafeInteger(record.dseq) || Number(record.dseq) <= 0))
    throw new ProtocolError("invalid dseq");
  return record as unknown as Envelope;
}

export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

export function isChallengePayload(value: unknown): value is ChallengePayload {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).nonce === "string" &&
    /^[A-Za-z0-9_-]{24}$/u.test((value as Record<string, unknown>).nonce as string)
  );
}

export function isHelloOkPayload(value: unknown): value is HelloOkPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.device_id === undefined || typeof record.device_id === "string") &&
    (record.delivery_mode === undefined || typeof record.delivery_mode === "string") &&
    record.ack_mode === "dseq" &&
    typeof record.ack_epoch === "string" &&
    Boolean(record.ack_epoch)
  );
}

export function isHelloFailPayload(value: unknown): value is HelloFailPayload {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).reason === "string"
  );
}

export function isMessageAckPayload(value: unknown): value is MessageAckPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.message_id === "string" &&
    Boolean(record.message_id) &&
    typeof record.accepted_at === "number" &&
    Number.isFinite(record.accepted_at)
  );
}

export function isMessageErrorPayload(value: unknown): value is MessageErrorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    Boolean(record.code) &&
    (record.message_id === undefined || typeof record.message_id === "string") &&
    (record.reason === undefined || typeof record.reason === "string") &&
    typeof record.rejected_at === "number" &&
    Number.isFinite(record.rejected_at)
  );
}

export function isEmptyPayload(value: unknown): value is EmptyPayload {
  const record = objectRecord(value);
  return Boolean(record && Object.keys(record).length === 0);
}

export function isSyncMarkPayload(value: unknown): value is SyncMarkPayload {
  const record = objectRecord(value);
  return Boolean(record && nonNegativeInteger(record.covers_seq));
}

export function isMessagePayload(value: unknown): value is MessagePayload {
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const message =
    record?.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? (record.message as Record<string, unknown>)
      : null;
  const body =
    message?.body && typeof message.body === "object" && !Array.isArray(message.body)
      ? (message.body as Record<string, unknown>)
      : null;
  const context =
    message?.context && typeof message.context === "object" && !Array.isArray(message.context)
      ? (message.context as Record<string, unknown>)
      : null;
  if (typeof record?.message_mode !== "string") return false;
  if (!Array.isArray(body?.fragments)) return false;
  if (!body.fragments.every(isFragment)) return false;
  if (!Array.isArray(context?.mentions)) return false;
  if (
    !context.mentions.every(
      (mention) => typeof mention === "string" || (mention && typeof mention === "object" && !Array.isArray(mention)),
    )
  )
    return false;
  const reply = context.reply;
  if (reply == null) return true;
  if (typeof reply !== "object" || Array.isArray(reply)) return false;
  const replyRecord = reply as Record<string, unknown>;
  if (typeof replyRecord.reply_to_msg_id !== "string") return false;
  const preview = replyRecord.reply_preview;
  if (preview == null) return true;
  if (typeof preview !== "object" || Array.isArray(preview)) return false;
  const previewRecord = preview as Record<string, unknown>;
  return (
    typeof previewRecord.id === "string" &&
    typeof previewRecord.nick_name === "string" &&
    Array.isArray(previewRecord.fragments) &&
    previewRecord.fragments.every(isFragment)
  );
}

export function isMaterializedMessagePayload(value: unknown): value is MessagePayload {
  if (!isMessagePayload(value)) return false;
  const message = objectRecord(value.message);
  const streaming = objectRecord(message?.streaming);
  return Boolean(
    streaming &&
      streaming.status === "static" &&
      streaming.mutation_policy === "sealed" &&
      nonNegativeInteger(streaming.sequence) &&
      optionalNullableFiniteNumber(streaming.started_at) &&
      optionalNullableFiniteNumber(streaming.completed_at) &&
      !value.message.body.fragments.some(
        (fragment) => fragment.kind === "text" && "delta" in fragment && fragment.delta !== undefined,
      ),
  );
}

export function isMessageCreatedPayload(value: unknown): value is MessageCreatedPayload {
  const record = objectRecord(value);
  return Boolean(
    record &&
      nonEmptyString(record.message_id) &&
      (record.message_mode === undefined || typeof record.message_mode === "string"),
  );
}

export function isMessageAddPayload(value: unknown): value is MessageAddPayload {
  const record = objectRecord(value);
  const mutation = objectRecord(record?.mutation);
  const streaming = objectRecord(record?.streaming);
  return Boolean(
    record &&
      nonEmptyString(record.message_id) &&
      nonNegativeInteger(record.sequence) &&
      mutation?.type === "append" &&
      nonNegativeInteger(mutation.target_fragment_index) &&
      isFragmentArray(record.fragments) &&
      streaming?.status === "streaming" &&
      streaming.mutation_policy === "append_text_only" &&
      streaming.sequence === record.sequence &&
      optionalFiniteNumber(record.added_at),
  );
}

export function isMessageTerminalPayload(value: unknown, status: "done" | "failed"): value is MessageTerminalPayload {
  const record = objectRecord(value);
  const streaming = objectRecord(record?.streaming);
  return Boolean(
    record &&
      nonEmptyString(record.message_id) &&
      isFragmentArray(record.fragments) &&
      !(record.fragments as Fragment[]).some(
        (fragment) => fragment.kind === "text" && "delta" in fragment && fragment.delta !== undefined,
      ) &&
      streaming?.status === status &&
      streaming.mutation_policy === "append_text_only" &&
      nonNegativeInteger(streaming.sequence) &&
      typeof record.completed_at === "number" &&
      Number.isFinite(record.completed_at),
  );
}

export function isPresencePayload(value: unknown): value is PresencePayload {
  const record = objectRecord(value);
  return Boolean(
    record &&
      /^(?:usr_|agt_).+/u.test(typeof record.user_id === "string" ? record.user_id : "") &&
      typeof record.online === "boolean" &&
      (record.last_seen_at === undefined || typeof record.last_seen_at === "string"),
  );
}

export function isTypingUpdatePayload(value: unknown): value is TypingUpdatePayload {
  const record = objectRecord(value);
  return Boolean(record && typeof record.is_typing === "boolean");
}

export function isMessageDeliveredPayload(value: unknown): value is MessageDeliveredPayload {
  const record = objectRecord(value);
  return Boolean(
    record &&
      nonEmptyString(record.message_id) &&
      typeof record.delivered_at === "number" &&
      Number.isFinite(record.delivered_at),
  );
}

export function isChatMetadataInvalidatedPayload(value: unknown): value is ChatMetadataInvalidatedPayload {
  const record = objectRecord(value);
  return Boolean(
    record &&
      (record.scope === undefined ||
        (Array.isArray(record.scope) && record.scope.every((scope) => typeof scope === "string"))) &&
      optionalFiniteNumber(record.version) &&
      optionalFiniteNumber(record.updated_at),
  );
}

export function isNotifySignalPayload(value: unknown): value is NotifySignalPayload {
  const record = objectRecord(value);
  return Boolean(
    record &&
      nonEmptyString(record.type) &&
      nonEmptyString(record.entity_id) &&
      nonNegativeInteger(record.version) &&
      nonEmptyString(record.event_id) &&
      nonEmptyString(record.message_id),
  );
}

export function isPermissionRequestPayload(value: unknown): value is PermissionRequestPayload {
  const record = objectRecord(value);
  return Boolean(
    record &&
      nonEmptyString(record.request_id) &&
      (record.agent_id === undefined || typeof record.agent_id === "string") &&
      (record.operation === undefined || typeof record.operation === "string") &&
      (record.target === undefined || objectRecord(record.target)) &&
      optionalFiniteNumber(record.expires_at),
  );
}

export function isPermissionResolvedPayload(value: unknown): value is PermissionResolvedPayload {
  const record = objectRecord(value);
  return Boolean(
    record &&
      nonEmptyString(record.request_id) &&
      (record.decision === undefined || typeof record.decision === "string") &&
      (record.reason === undefined || typeof record.reason === "string"),
  );
}

export function isHistoryTransitPayload(value: unknown): value is HistoryTransitPayload {
  const record = objectRecord(value);
  return Boolean(record && nonEmptyString(record.kind));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function optionalNullableFiniteNumber(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function isFragmentArray(value: unknown): value is Fragment[] {
  return Array.isArray(value) && value.every(isFragment);
}

function isFragment(value: unknown): value is Fragment {
  const record = objectRecord(value);
  if (!record || !nonEmptyString(record.kind)) return false;
  if (record.kind === "text") {
    return typeof record.text === "string" && (record.delta === undefined || typeof record.delta === "string");
  }
  if (record.kind === "mention") {
    return (
      (record.user_id === undefined || typeof record.user_id === "string") &&
      (record.display === undefined || typeof record.display === "string")
    );
  }
  if (record.kind === "image" || record.kind === "file" || record.kind === "audio" || record.kind === "video") {
    if (!nonEmptyString(record.url)) return false;
    if (record.name !== undefined && typeof record.name !== "string") return false;
    if (record.mime !== undefined && typeof record.mime !== "string") return false;
    if (!optionalNonNegativeNumber(record.size)) return false;
    if ((record.kind === "image" || record.kind === "video") && !optionalNonNegativeNumber(record.width)) return false;
    if ((record.kind === "image" || record.kind === "video") && !optionalNonNegativeNumber(record.height)) return false;
    if ((record.kind === "audio" || record.kind === "video") && !optionalNonNegativeNumber(record.duration))
      return false;
  }
  return true;
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
