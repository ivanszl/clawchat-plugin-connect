import { createHash } from "node:crypto";

export function protocolDeliveryContentJson(value: unknown): string {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(parsed);
  const content = { ...(parsed as Record<string, unknown>) };
  for (const field of ["dseq", "emitted_at", "trace_id"]) delete content[field];
  return json(content);
}

export function inboundContentDigest(value: unknown): string {
  return createHash("sha256").update(protocolDeliveryContentJson(value)).digest("hex");
}

function json(value: unknown): string {
  if (value == null) return "null";
  try {
    return JSON.stringify(canonicalJsonValue(value));
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}

function canonicalJsonValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("cannot canonicalize circular JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, ancestors));
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalJsonValue(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}
