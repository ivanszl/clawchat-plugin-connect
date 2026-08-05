import {
  type Envelope,
  EVENT,
  type Fragment,
  isEmptyPayload,
  isHistoryTransitPayload,
  isMaterializedMessagePayload,
  isMessageAckPayload,
  isNotifySignalPayload,
  isSyncMarkPayload,
  isSystemPermissionResultEnvelope,
  ProtocolError,
  StateError,
} from "./protocol";

export function messageIdForAudit(envelope: Envelope): string | null {
  if (envelope.event === EVENT.MESSAGE_ACK)
    return isMessageAckPayload(envelope.payload) ? envelope.payload.message_id : envelope.trace_id;
  if (envelope.event === EVENT.MESSAGE_ERROR) return envelope.trace_id;
  const payload = envelope.payload as { message_id?: unknown };
  return typeof payload.message_id === "string" ? payload.message_id : null;
}

const CLIENT_MESSAGE_ID_PATTERN = /^msg-[0-9A-HJ-NP-Z]{26}$/u;

export function assertClientMessageId(messageId: string): void {
  if (!CLIENT_MESSAGE_ID_PATTERN.test(messageId)) {
    throw new ProtocolError("client message_id must match ^msg-[0-9A-HJ-NP-Z]{26}$");
  }
}

export function findForbiddenUplinkMessageField(
  value: unknown,
  seen = new WeakSet<object>(),
): { kind: "routing" | "timestamp"; field: string } | null {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findForbiddenUplinkMessageField(item, seen);
      if (nested) return nested;
    }
    return null;
  }
  for (const [field, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (field === "chat" || field === "sender" || field === "to") return { kind: "routing", field };
    if (field === "timestamp" || field.endsWith("_at") || field.endsWith("At")) {
      return { kind: "timestamp", field };
    }
    const nested = findForbiddenUplinkMessageField(nestedValue, seen);
    if (nested) return nested;
  }
  return null;
}

export function dseqPayloadError(envelope: Envelope): string | null {
  if (envelope.event === EVENT.MESSAGE_SEND || envelope.event === EVENT.MESSAGE_REPLY) {
    const payload = envelope.payload as { message_id?: unknown };
    if (
      !envelope.chat_id ||
      !envelope.chat_type ||
      !envelope.sender ||
      (!isMaterializedMessagePayload(envelope.payload) && !isSystemPermissionResultEnvelope(envelope)) ||
      typeof payload.message_id !== "string" ||
      !payload.message_id
    )
      return `invalid ${envelope.event} payload`;
  }
  if (envelope.event === EVENT.NOTIFY_SIGNAL && !isNotifySignalPayload(envelope.payload))
    return "invalid notify.signal payload";
  if (
    envelope.event === EVENT.HISTORY_TRANSIT &&
    (!envelope.target_device_id ||
      !envelope.sender ||
      !envelope.origin_device_id ||
      !isHistoryTransitPayload(envelope.payload))
  )
    return "invalid history.transit frame";
  if (envelope.event === EVENT.SYNC_MARK && !isSyncMarkPayload(envelope.payload)) return "invalid sync.mark payload";
  if (envelope.event === EVENT.REPLAY_DONE && !isEmptyPayload(envelope.payload)) return "invalid replay.done payload";
  return null;
}

export function isV2AckableDownlink(event: string): boolean {
  return (
    event === EVENT.MESSAGE_SEND ||
    event === EVENT.MESSAGE_REPLY ||
    event === EVENT.HISTORY_TRANSIT ||
    event === EVENT.NOTIFY_SIGNAL ||
    event === EVENT.SYNC_MARK ||
    event === EVENT.REPLAY_DONE
  );
}

export function streamDeltaError(previousFragments: Fragment[], nextFragments: Fragment[]): string | null {
  for (const [index, fragment] of nextFragments.entries()) {
    if (fragment.kind !== "text") continue;
    const previous = previousFragments[index];
    const previousText = previous?.kind === "text" ? previous.text : "";
    if (typeof fragment.delta !== "string" || previousText + fragment.delta !== fragment.text)
      return "message.add text delta invariant failed";
  }
  return null;
}

export function recoverDseqPoisonEnvelope(data: string | Buffer): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(record.dseq) || Number(record.dseq) <= 0) return null;
  const dseq = Number(record.dseq);
  return {
    ...record,
    version: "2",
    event: typeof record.event === "string" && record.event ? record.event : "invalid",
    trace_id: typeof record.trace_id === "string" && record.trace_id ? record.trace_id : `invalid-dseq-${dseq}`,
    emitted_at:
      typeof record.emitted_at === "number" && Number.isFinite(record.emitted_at) ? record.emitted_at : Date.now(),
    dseq,
    payload:
      record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) ? record.payload : {},
  } as Envelope;
}

export function terminalSequence(lastAddSequence: number): number {
  return lastAddSequence < 0 ? 0 : lastAddSequence;
}

export function assertPresenceUserId(userId: string): string {
  const normalized = userId.trim();
  if (!/^(?:usr_|agt_).+/u.test(normalized)) throw new StateError("presence userId must start with usr_ or agt_");
  return normalized;
}
