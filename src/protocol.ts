export const EVENT = {
  CONNECT_CHALLENGE: "connect.challenge",
  CONNECT: "connect",
  HELLO_OK: "hello-ok",
  HELLO_FAIL: "hello-fail",
  MESSAGE_SEND: "message.send",
  MESSAGE_ACK: "message.ack",
  MESSAGE_ERROR: "message.error",
  MESSAGE_REPLY: "message.reply",
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
  OFFLINE_BATCH: "offline.batch",
  OFFLINE_ACK: "offline.ack",
  OFFLINE_DONE: "offline.done",
  PING: "ping",
  PONG: "pong",
} as const;

export type KnownEventName = typeof EVENT[keyof typeof EVENT];
export type EventName = KnownEventName | string;
export type ChatType = "direct" | "group";
export type ConnState = "idle" | "connecting" | "challenging" | "authenticating" | "connected" | "reconnecting" | "disconnected";
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

export interface Routing { id: string; type: ChatType; }
export interface Sender { id: string; type: "direct"; nick_name: string; }

export interface Envelope<TPayload = unknown> {
  version: "2";
  event: EventName;
  trace_id: string;
  emitted_at: number;
  chat_id?: string;
  chat_type?: ChatType;
  to?: Routing;
  sender?: Sender;
  payload: TPayload;
}

export interface ConnectCapabilities { multi_device?: boolean; device_replay?: boolean; chat_meta_events?: boolean; }
export interface ChallengePayload { nonce: string; }
export interface ConnectPayload { token: string; nonce: string; device_id?: string; capabilities?: ConnectCapabilities; }
export interface HelloOkPayload { device_id?: string; delivery_mode?: string; }
export interface HelloFailPayload { reason: string; }
export interface MessageAckPayload { message_id: string; accepted_at: number; }
export interface MessageErrorPayload { code: string; message: string; }
export type EmptyPayload = Record<string, never>;

export type Fragment =
  | { kind: "text"; text: string; delta?: string }
  | { kind: "mention"; user_id?: string; display?: string }
  | { kind: "image"; url: string; name?: string; mime?: string; size?: number; width?: number; height?: number }
  | { kind: "file"; url: string; name?: string; mime?: string; size?: number }
  | { kind: "audio"; url: string; name?: string; mime?: string; size?: number; duration?: number }
  | { kind: "video"; url: string; name?: string; mime?: string; size?: number; width?: number; height?: number; duration?: number }
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
    streaming?: { status: string; sequence: number; mutation_policy: string; started_at?: number | null; completed_at?: number | null };
  };
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

export class AuthError extends Error { override name = "AuthError"; }
export class TransportError extends Error { override name = "TransportError"; }
export class ProtocolError extends Error { override name = "ProtocolError"; }
export class StateError extends Error { override name = "StateError"; }
export class AckTimeoutError extends Error { override name = "AckTimeoutError"; }
export class MessageSendError extends Error { override name = "MessageSendError"; }

export function parseEnvelope(data: string | Buffer): Envelope {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : data); }
  catch (error) { throw new ProtocolError(`invalid websocket JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== "object") throw new ProtocolError("websocket frame is not an object");
  const record = parsed as Record<string, unknown>;
  if (record.version !== "2") throw new ProtocolError("unsupported protocol version");
  if (typeof record.event !== "string" || !record.event) throw new ProtocolError("missing event");
  if (typeof record.trace_id !== "string" || !record.trace_id) throw new ProtocolError("missing trace_id");
  if (typeof record.emitted_at !== "number" || !Number.isFinite(record.emitted_at)) throw new ProtocolError("missing emitted_at");
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new ProtocolError("missing payload");
  if (record.chat_id !== undefined && typeof record.chat_id !== "string") throw new ProtocolError("invalid chat_id");
  if (record.chat_type !== undefined && record.chat_type !== "direct" && record.chat_type !== "group") throw new ProtocolError("invalid chat_type");
  return record as unknown as Envelope;
}

export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

export function isChallengePayload(value: unknown): value is ChallengePayload {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).nonce === "string"
    && Boolean((value as Record<string, unknown>).nonce);
}

export function isHelloOkPayload(value: unknown): value is HelloOkPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.device_id === undefined || typeof record.device_id === "string")
    && (record.delivery_mode === undefined || typeof record.delivery_mode === "string");
}

export function isHelloFailPayload(value: unknown): value is HelloFailPayload {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).reason === "string";
}

export function isMessageAckPayload(value: unknown): value is MessageAckPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.message_id === "string"
    && Boolean(record.message_id)
    && typeof record.accepted_at === "number"
    && Number.isFinite(record.accepted_at);
}

export function isMessageErrorPayload(value: unknown): value is MessageErrorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && Boolean(record.code) && typeof record.message === "string";
}

export function isMessagePayload(value: unknown): value is MessagePayload {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const message = record?.message && typeof record.message === "object" && !Array.isArray(record.message) ? record.message as Record<string, unknown> : null;
  const body = message?.body && typeof message.body === "object" && !Array.isArray(message.body) ? message.body as Record<string, unknown> : null;
  const context = message?.context && typeof message.context === "object" && !Array.isArray(message.context) ? message.context as Record<string, unknown> : null;
  if (typeof record?.message_mode !== "string") return false;
  if (!Array.isArray(body?.fragments)) return false;
  if (!body.fragments.every((fragment) => fragment && typeof fragment === "object" && typeof (fragment as Record<string, unknown>).kind === "string")) return false;
  if (!Array.isArray(context?.mentions)) return false;
  if (!context.mentions.every((mention) => typeof mention === "string" || (mention && typeof mention === "object" && !Array.isArray(mention)))) return false;
  const reply = context.reply;
  if (reply == null) return true;
  if (typeof reply !== "object" || Array.isArray(reply)) return false;
  const replyRecord = reply as Record<string, unknown>;
  if (typeof replyRecord.reply_to_msg_id !== "string") return false;
  const preview = replyRecord.reply_preview;
  if (preview == null) return true;
  if (typeof preview !== "object" || Array.isArray(preview)) return false;
  const previewRecord = preview as Record<string, unknown>;
  return typeof previewRecord.id === "string"
    && typeof previewRecord.nick_name === "string"
    && Array.isArray(previewRecord.fragments)
    && previewRecord.fragments.every((fragment) => fragment && typeof fragment === "object" && typeof (fragment as Record<string, unknown>).kind === "string");
}
