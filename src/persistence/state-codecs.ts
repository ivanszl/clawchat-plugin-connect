import type { EmbeddedTranscriptBlock, TranscriptBlock } from "../client-contract";
import type { RuntimeSessionRecord, SessionIntentRecord, WorkspaceRecord } from "../types";
import type {
  GroupReplyMode,
  GroupSettingsRecord,
  SessionLifecycleAction,
  SessionLifecycleOperationRecord,
  SessionLifecycleOperationState,
  ToolRequestRecord,
  ToolRequestState,
  TranscriptBlockInput,
} from "./state-types";

export function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}
export function parseJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(stringValue(value)) as unknown;
  } catch {
    return null;
  }
}

export function toolRequestRecord(row: Record<string, unknown>): ToolRequestRecord {
  const parsedInput = parseJsonValue(row.input_json);
  return {
    requestId: stringValue(row.request_id),
    bindingId: stringValue(row.binding_id),
    toolName: stringValue(row.tool_name),
    input:
      parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)
        ? (parsedInput as Record<string, unknown>)
        : {},
    state: stringValue(row.state) as ToolRequestState,
    result: row.result_json == null ? null : parseJsonValue(row.result_json),
    error: nullableString(row.error),
    resultTruncated: numberValue(row.result_truncated) === 1,
    errorTruncated: numberValue(row.error_truncated) === 1,
    sessionRef: nullableString(row.session_ref),
    turnId: nullableString(row.turn_id),
    origin: nullableString(row.origin),
    createdAt: numberValue(row.created_at),
    claimedAt: row.claimed_at == null ? null : numberValue(row.claimed_at),
    settledAt: row.settled_at == null ? null : numberValue(row.settled_at),
    expiresAt: numberValue(row.expires_at),
    attemptCount: numberValue(row.attempt_count),
  };
}

export function boundedJson(value: unknown, maximumBytes = 64 * 1024): { value: string; truncated: boolean } {
  const serialized = toJson(value) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return { value: serialized, truncated: false };
  let lower = 0;
  let upper = serialized.length;
  let bounded = JSON.stringify({ truncated: true, preview: "" });
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = JSON.stringify({ truncated: true, preview: serialized.slice(0, middle) });
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      bounded = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return {
    value: bounded,
    truncated: true,
  };
}
export function boundedText(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return { value, truncated: false };
  return { value: truncateUtf8(value, maximumBytes), truncated: true };
}
export function truncateUtf8(value: string, maximumBytes: number): string {
  let end = Math.min(value.length, maximumBytes);
  while (Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes) end -= 1;
  return value.slice(0, end);
}
export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
export function requireStateString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
export function nullableString(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}
export function normalizeGroupSettingsRecord(row: GroupSettingsRecord): GroupSettingsRecord {
  const replyMode = row.replyMode;
  if (replyMode !== "all" && replyMode !== "mention") throw new Error("group replyMode must be all or mention");
  if (!Number.isSafeInteger(row.batchDelaySeconds) || row.batchDelaySeconds < 0) {
    throw new Error("group batchDelaySeconds must be a non-negative integer");
  }
  if (!Number.isSafeInteger(row.version) || row.version < 0) {
    throw new Error("group settings version must be a non-negative integer");
  }
  return {
    conversationId: requireStateString(row.conversationId, "group conversationId"),
    muted: row.muted,
    replyMode,
    batchDelaySeconds: row.batchDelaySeconds,
    version: row.version,
  };
}
export function groupSettingsRecordFromRow(row: Record<string, unknown>): GroupSettingsRecord {
  return {
    conversationId: stringValue(row.conversation_id),
    muted: Number(row.muted) === 1,
    replyMode: stringValue(row.reply_mode) as GroupReplyMode,
    batchDelaySeconds: numberValue(row.batch_delay_seconds),
    version: numberValue(row.version),
  };
}
export function sameTranscriptPayload(stored: TranscriptBlock, input: TranscriptBlockInput): boolean {
  const storedPayload = { ...stored } as Record<string, unknown>;
  const inputPayload = { ...input } as Record<string, unknown>;
  for (const key of ["sequence", "revision", "createdAt", "updatedAt"]) {
    delete storedPayload[key];
    delete inputPayload[key];
  }
  return JSON.stringify(storedPayload) === JSON.stringify(inputPayload);
}
export function settleTranscriptBlock(block: TranscriptBlock, state: "error" | "cancelled"): TranscriptBlockInput {
  return settleEmbeddedTranscriptBlock(block, state) as TranscriptBlockInput;
}
export function settleEmbeddedTranscriptBlock(
  block: EmbeddedTranscriptBlock,
  state: "error" | "cancelled",
): EmbeddedTranscriptBlock {
  if (block.type === "runtime-interaction") return block;
  const settledState = block.state === "pending" || block.state === "streaming" ? state : block.state;
  if (block.type === "subagent") {
    return {
      ...block,
      state: settledState,
      blocks: block.blocks.map((child) => settleEmbeddedTranscriptBlock(child, state)),
    };
  }
  if (
    settledState !== block.state &&
    (block.type === "command" || block.type === "tool-call" || block.type === "file-change")
  ) {
    return { ...block, state: settledState, status: state };
  }
  return settledState === block.state ? block : { ...block, state: settledState };
}
export function preserveConnectOwnedMessageMetadata(
  stored: TranscriptBlock | null,
  input: TranscriptBlockInput,
): TranscriptBlockInput {
  if (
    stored?.type === "message" &&
    input.type === "message" &&
    stored.role === "assistant" &&
    input.role === "assistant" &&
    stored.origin === "runtime" &&
    input.origin === "runtime" &&
    stored.media &&
    !input.media
  ) {
    return {
      ...input,
      plainText: stored.plainText,
      markdown: stored.markdown,
      media: stored.media,
    };
  }
  if (
    stored?.type !== "message" ||
    input.type !== "message" ||
    stored.role !== "user" ||
    input.role !== "user" ||
    input.origin !== "runtime" ||
    (stored.origin !== "client" && stored.origin !== "clawchat")
  ) {
    return input;
  }
  return {
    ...input,
    origin: stored.origin,
    author: stored.author,
    ...(connectPromptMatchesRuntimeHistory(stored.plainText, input.plainText)
      ? { plainText: stored.plainText, markdown: stored.markdown }
      : {}),
    ...(stored.sender ? { sender: stored.sender } : {}),
    ...(stored.conversationType ? { conversationType: stored.conversationType } : {}),
    ...(stored.media && !input.media ? { media: stored.media } : {}),
  };
}
export function connectPromptMatchesRuntimeHistory(connectPrompt: string, runtimePrompt: string): boolean {
  return (
    connectPrompt === runtimePrompt || (connectPrompt.startsWith("/") && `$${connectPrompt.slice(1)}` === runtimePrompt)
  );
}
export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0;
}
export function workspaceFromRow(row: Record<string, unknown>): WorkspaceRecord {
  return {
    bindingId: stringValue(row.binding_id),
    workspaceRef: stringValue(row.workspace_ref),
    runtimeIdentityKey: nullableString(row.runtime_identity_key),
    source: stringValue(row.source) as "default" | "runtime",
    name: stringValue(row.name),
    rootPath: stringValue(row.root_path),
    selectable: Number(row.selectable) === 1,
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}
export function stringRecordFromJson(value: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(stringValue(value)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}
export function runtimeSessionFromRow(row: Record<string, unknown>): RuntimeSessionRecord {
  return {
    chatId: stringValue(row.chat_id),
    sessionId: stringValue(row.session_id),
    sessionRef: stringValue(row.session_ref),
    agentId: stringValue(row.agent_id),
    runtimeSessionId: nullableString(row.runtime_session_id),
    workspaceRef: nullableString(row.workspace_ref),
    name: nullableString(row.name),
    mode: nullableString(row.mode),
    model: nullableString(row.model),
    reasoningEffort: nullableString(row.reasoning_effort),
    sessionOptions: stringRecordFromJson(row.session_options_json),
    hasMessages: Boolean(row.has_messages),
    isCurrent: Boolean(row.is_current),
    updatedAt: numberValue(row.updated_at),
  };
}

export function sessionLifecycleOperationFromRow(row: Record<string, unknown>): SessionLifecycleOperationRecord {
  return {
    operationId: stringValue(row.operation_id),
    sessionRef: stringValue(row.session_ref),
    action: stringValue(row.action) as SessionLifecycleAction,
    bindingId: stringValue(row.binding_id),
    runtimeThreadId: stringValue(row.runtime_thread_id),
    state: stringValue(row.state) as SessionLifecycleOperationState,
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function sessionIntentFromRow(row: Record<string, unknown>): SessionIntentRecord {
  return {
    chatId: stringValue(row.chat_id),
    agentId: stringValue(row.agent_id),
    workspaceRef: nullableString(row.workspace_ref),
    name: nullableString(row.name),
    mode: nullableString(row.mode),
    model: nullableString(row.model),
    reasoningEffort: nullableString(row.reasoning_effort),
    sessionOptions: stringRecordFromJson(row.session_options_json),
    updatedAt: numberValue(row.updated_at),
  };
}
