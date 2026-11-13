// Frame sizing shared by the DSH Bridge (runs inside DSH) and the Connect Adapter.
// This file must stay dependency-free: it is shipped as a sibling Plugin asset of the Bridge.

export const DSH_BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

const PREVIEW_CAPS = [1_048_576, 262_144, 65_536, 16_384, 4_096, 1_024, 0];
const UNTOUCHED_STRING_BYTES = 512;
const BINARY_MIN_BYTES = 8_192;
const BINARY_PATTERN = /^[A-Za-z0-9+/=_-]+$/u;
// A long run of base64 alphabet characters is only treated as binary under a key that names binary content,
// so a legitimate long single-token text output is still previewed instead of dropped.
const BINARY_KEYS = new Set(["data", "base64", "b64", "bytes", "blob", "image", "imageData", "source"]);
const MAX_REPORTED_FIELDS = 32;
const ENVELOPE_KEYS = new Set(["type", "id", "sessionId", "ok"]);
const TRUNCATION_NOTE =
  "The Bridge truncated this content to fit the frame limit. The full content remains in the DSH Session log; the Bridge protocol has no paged fetch.";

function frameTooLarge(message) {
  return Object.assign(new Error(message), { code: "frame-too-large" });
}

function byteLength(value) {
  return Buffer.byteLength(value);
}

/**
 * Encode one newline-terminated JSON frame within `limit` bytes.
 *
 * Oversized events, ok-responses and interaction frames are degraded: large strings are replaced by a bounded
 * preview plus an inline "[output truncated: N bytes]" marker, inline binary (base64) is omitted, and a structured
 * `truncated` marker is added (`event.truncated` for events, `frame.truncated` otherwise). A frame that cannot be
 * degraded far enough throws `frame-too-large`, except events, which fall back to a minimal placeholder.
 *
 * @returns {{ encoded: string, degraded: null | { originalBytes: number, bytes: number, fields: number, placeholder: boolean } }}
 */
export function encodeBridgeFrame(frame, limit = DSH_BRIDGE_MAX_FRAME_BYTES) {
  let raw;
  try {
    raw = JSON.stringify(frame);
  } catch (error) {
    if (frame?.type === "event") return placeholder(frame, 0, limit);
    throw Object.assign(new Error(`Bridge frame cannot be encoded: ${error?.message ?? error}`), {
      code: "frame-encode-failed",
    });
  }
  const encoded = `${raw}\n`;
  const originalBytes = byteLength(encoded);
  if (originalBytes <= limit) return { encoded, degraded: null };
  const degradable = frame?.type === "event" || frame?.type === "interaction" || (frame?.type === "response" && frame.ok);
  if (!degradable) throw frameTooLarge(`Bridge frame exceeds ${limit} bytes (${originalBytes})`);

  for (const cap of PREVIEW_CAPS) {
    const plain = JSON.parse(raw);
    const fields = [];
    for (const key of Object.keys(plain)) {
      if (!ENVELOPE_KEYS.has(key)) plain[key] = bound(plain[key], cap, key, fields);
    }
    if (fields.length === 0) continue;
    const marker = {
      truncated: true,
      originalBytes,
      fields: fields.slice(0, MAX_REPORTED_FIELDS),
      ...(fields.length > MAX_REPORTED_FIELDS ? { omittedFields: fields.length - MAX_REPORTED_FIELDS } : {}),
      note: TRUNCATION_NOTE,
    };
    if (plain.type === "event" && plain.event && typeof plain.event === "object") plain.event.truncated = marker;
    else plain.truncated = marker;
    const candidate = `${JSON.stringify(plain)}\n`;
    const bytes = byteLength(candidate);
    if (bytes <= limit) {
      return { encoded: candidate, degraded: { originalBytes, bytes, fields: fields.length, placeholder: false } };
    }
  }
  if (frame.type === "event") return placeholder(frame, originalBytes, limit);
  throw frameTooLarge(`Bridge frame exceeds ${limit} bytes (${originalBytes}) even after truncation`);
}

function bound(value, cap, path, fields) {
  if (typeof value === "string") {
    const bytes = byteLength(value);
    if (bytes <= Math.max(cap, UNTOUCHED_STRING_BYTES)) return value;
    if (isBinary(value, bytes, path)) {
      const text = `[binary omitted: ${bytes} bytes]`;
      fields.push({ path, originalBytes: bytes, previewBytes: 0, kind: "binary" });
      return text;
    }
    const preview = preview8(value, cap);
    fields.push({ path, originalBytes: bytes, previewBytes: byteLength(preview), kind: "text" });
    return `${preview}\n[output truncated: ${bytes} bytes]`;
  }
  if (Array.isArray(value)) return value.map((item, index) => bound(item, cap, `${path}.${index}`, fields));
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = bound(item, cap, `${path}.${key}`, fields);
    return result;
  }
  return value;
}

function isBinary(value, bytes, path) {
  if (bytes < BINARY_MIN_BYTES) return false;
  if (value.startsWith("data:")) return true;
  const key = path.slice(path.lastIndexOf(".") + 1);
  return BINARY_KEYS.has(key) && BINARY_PATTERN.test(value);
}

function preview8(value, cap) {
  if (cap <= 0) return "";
  const text = Buffer.from(value, "utf8").subarray(0, cap).toString("utf8");
  return text.endsWith("�") ? text.slice(0, -1) : text;
}

function smallScalar(value) {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && byteLength(value) <= 256)
  );
}

function placeholder(frame, originalBytes, limit) {
  const event = frame?.event && typeof frame.event === "object" ? frame.event : {};
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {};
  const kept = {};
  for (const [key, value] of Object.entries(data)) {
    if (smallScalar(value)) kept[key] = value;
    else if (key === "reason" && value && typeof value === "object") {
      try {
        const text = JSON.stringify(value);
        if (byteLength(text) <= 1_024) kept.reason = value;
      } catch {}
    }
  }
  if (event.type === "tool/result") {
    const message = data.message && typeof data.message === "object" ? data.message : {};
    const first = Array.isArray(message.content) && message.content[0] ? message.content[0] : {};
    const callId = typeof message.source?.callId === "string" ? message.source.callId : undefined;
    kept.message = {
      ...(callId ? { source: { callId } } : {}),
      content: [
        {
          type: "tool-result",
          ...(typeof first.toolCallId === "string" ? { toolCallId: first.toolCallId } : {}),
          ...(first.isError === true ? { isError: true } : {}),
          content: [{ type: "text", text: `[output truncated: ${originalBytes} bytes]` }],
        },
      ],
    };
  }
  const result = {
    type: "event",
    sessionId: typeof frame?.sessionId === "string" ? frame.sessionId : "",
    event: {
      seq: Number.isSafeInteger(event.seq) ? event.seq : 0,
      time: Number.isFinite(event.time) ? event.time : 0,
      type: typeof event.type === "string" ? event.type : "unknown",
      data: kept,
      truncated: { truncated: true, placeholder: true, originalBytes, fields: [], note: TRUNCATION_NOTE },
    },
  };
  const encoded = `${JSON.stringify(result)}\n`;
  if (byteLength(encoded) > limit) throw frameTooLarge(`Bridge frame exceeds ${limit} bytes`);
  return {
    encoded,
    degraded: { originalBytes, bytes: byteLength(encoded), fields: 0, placeholder: true },
  };
}

export const DSH_BRIDGE_HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
const HISTORY_PAGE_BYTES_CEILING = 8 * 1024 * 1024;

const turnOf = (event) => (Number.isSafeInteger(event?.data?.turn) ? event.data.turn : undefined);

/**
 * Select one bounded window of Session events for the Bridge `history` method. The window is always the newest
 * matching events, so no caller can ask the Bridge for a whole Session in one frame.
 *
 * Params (all optional): `headerOnly` (no events), `lastTurns` (scope: the N latest Turns plus Turn-less command
 * events, which share one position counter in the Activity Projector), `types` (event type allow-list),
 * `beforeSeq` (exclusive cursor: continue to older events), `limit` (max events) and `maxBytes` (encoded budget,
 * default 4 MiB, capped at 8 MiB). A window holds at least one event so a single oversized event still makes
 * progress (it is degraded when the response is encoded). Events come back in ascending order.
 *
 * `complete` is true only when no matching Session event was left out (by the budget or by the `lastTurns`
 * scope). `nextBeforeSeq` is non-null only when the budget cut the window: it is the cursor for the next older
 * window inside the same scope.
 */
export function pageHistoryEvents(events, params = {}) {
  if (params.headerOnly === true) return { events: [], complete: events.length === 0, nextBeforeSeq: null };
  const types = Array.isArray(params.types) ? new Set(params.types.filter((type) => typeof type === "string")) : null;
  const matches = (event) => !types || types.has(event.type);
  const beforeSeq = Number.isSafeInteger(params.beforeSeq) ? params.beforeSeq : Number.POSITIVE_INFINITY;
  let scopeStart = 0;
  if (Number.isSafeInteger(params.lastTurns) && params.lastTurns > 0) {
    const turns = [...new Set(events.map(turnOf).filter((turn) => turn !== undefined))].sort((a, b) => a - b);
    if (turns.length > 0) {
      const threshold = turns[Math.max(0, turns.length - params.lastTurns)];
      const first = events.findIndex((event) => (turnOf(event) ?? Number.NEGATIVE_INFINITY) >= threshold);
      scopeStart = first < 0 ? 0 : first;
    }
  }
  const inScope = (event, index) =>
    index >= scopeStart || (params.lastTurns > 0 && (event.type === "command/run" || event.type === "command/done"));
  const budget = Math.min(
    Number.isSafeInteger(params.maxBytes) && params.maxBytes > 0 ? params.maxBytes : DSH_BRIDGE_HISTORY_PAGE_BYTES,
    HISTORY_PAGE_BYTES_CEILING,
  );
  const limit = Number.isSafeInteger(params.limit) && params.limit > 0 ? params.limit : Number.POSITIVE_INFINITY;
  const window = [];
  let used = 0;
  let leftOut = false;
  let budgetCut = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!(event.seq < beforeSeq) || !matches(event)) continue;
    if (!inScope(event, index)) {
      leftOut = true;
      continue;
    }
    const size = byteLength(JSON.stringify(event)) + 1;
    if (window.length > 0 && (used + size > budget || window.length >= limit)) {
      leftOut = true;
      budgetCut = true;
      break;
    }
    window.push(event);
    used += size;
  }
  window.reverse();
  return { events: window, complete: !leftOut, nextBeforeSeq: budgetCut ? window[0].seq : null };
}
