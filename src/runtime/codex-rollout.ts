import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeTranscriptEntry, RuntimeTranscriptSnapshot } from "./types";

export interface BackfillCodexRolloutTranscriptOptions {
  codexHome: string;
  runtimeThreadId: string;
  appServerEntries: RuntimeTranscriptEntry[];
}

interface RolloutCall {
  callId: string;
  name: string;
  input: unknown;
  status: string;
}

type RolloutToken = { kind: "anchor"; id: string; role: string } | { kind: "call"; callId: string };

export async function backfillCodexRolloutTranscript(
  options: BackfillCodexRolloutTranscriptOptions,
): Promise<RuntimeTranscriptSnapshot> {
  const path = await findRolloutPath(options.codexHome, options.runtimeThreadId);
  if (!path) return { entries: options.appServerEntries, completeness: "partial" };
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { entries: options.appServerEntries, completeness: "partial" };
  }

  const calls = new Map<string, RolloutCall>();
  const outputs = new Map<string, unknown>();
  const tokens: RolloutToken[] = [];
  let complete = true;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      complete = false;
      continue;
    }
    if (record.type !== "response_item") continue;
    const payload = objectValue(record.payload);
    const payloadType = stringValue(payload?.type);
    if (!payload || !payloadType) continue;
    if (payloadType === "message") {
      const id = stringValue(payload.id);
      if (id)
        tokens.push({
          kind: "anchor",
          id,
          role: stringValue(payload.role),
        });
      continue;
    }
    if (isRawToolCall(payloadType)) {
      const callId = stringValue(payload.call_id);
      const name = rawToolName(payloadType, payload);
      if (!callId || !name) {
        complete = false;
        continue;
      }
      calls.set(callId, {
        callId,
        name,
        input: payload.input ?? payload.arguments ?? null,
        status: stringValue(payload.status) || "completed",
      });
      tokens.push({ kind: "call", callId });
      continue;
    }
    if (isRawToolOutput(payloadType)) {
      const callId = stringValue(payload.call_id);
      if (!callId) {
        complete = false;
        continue;
      }
      outputs.set(callId, payload.output ?? payload.tools ?? null);
    }
  }

  const representedCalls = new Set(
    options.appServerEntries.flatMap((entry) => {
      const callId = stringValue(entry.data?.nativeCallId);
      return callId ? [callId] : [];
    }),
  );
  const fallbackByCallId = new Map<string, RuntimeTranscriptEntry>();
  for (const call of calls.values()) {
    if (
      representedCalls.has(call.callId) ||
      call.name === "apply_patch" ||
      matchesAppServerCommand(call, options.appServerEntries)
    )
      continue;
    const hasOutput = outputs.has(call.callId);
    if (!hasOutput && call.status === "completed") complete = false;
    const input = visibleValue(call.input);
    const output = visibleValue(outputs.get(call.callId));
    const title = `Codex tool · ${call.name}`;
    fallbackByCallId.set(call.callId, {
      id: `rollout:${call.callId}`,
      kind: "tool",
      text: toolDetail(title, input, output),
      state: rawToolState(call.status),
      source: "fallback",
      data: {
        itemType: "rawToolCall",
        title,
        tool: call.name,
        nativeCallId: call.callId,
        status: call.status,
        input,
        output,
      },
    });
  }

  const correlation = correlateMessageAnchors(options.appServerEntries, tokens);
  return {
    entries: mergeByMessageAnchors(correlation.entries, correlation.tokens, fallbackByCallId),
    completeness: complete && correlation.complete ? "complete" : "partial",
  };
}

async function findRolloutPath(codexHome: string, runtimeThreadId: string): Promise<string | null> {
  const suffix = `-${runtimeThreadId}.jsonl`;
  for (const root of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
    const match = await findFileBySuffix(root, suffix);
    if (match) return match;
  }
  return null;
}

async function findFileBySuffix(directory: string, suffix: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) return join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = await findFileBySuffix(join(directory, entry.name), suffix);
    if (match) return match;
  }
  return null;
}

function mergeByMessageAnchors(
  appServerEntries: RuntimeTranscriptEntry[],
  tokens: RolloutToken[],
  fallbackByCallId: ReadonlyMap<string, RuntimeTranscriptEntry>,
): RuntimeTranscriptEntry[] {
  const appServerIds = new Set(appServerEntries.map((entry) => entry.id));
  const beforeAnchor = new Map<string, RuntimeTranscriptEntry[]>();
  const afterAll: RuntimeTranscriptEntry[] = [];
  const emittedCalls = new Set<string>();
  let nextAnchor: string | null = null;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token?.kind === "anchor") {
      if (appServerIds.has(token.id)) nextAnchor = token.id;
      continue;
    }
    if (token?.kind !== "call" || emittedCalls.has(token.callId)) continue;
    const entry = fallbackByCallId.get(token.callId);
    if (!entry) continue;
    emittedCalls.add(token.callId);
    if (nextAnchor) {
      const bucket = beforeAnchor.get(nextAnchor) ?? [];
      bucket.unshift(entry);
      beforeAnchor.set(nextAnchor, bucket);
    } else {
      afterAll.unshift(entry);
    }
  }
  return [...appServerEntries.flatMap((entry) => [...(beforeAnchor.get(entry.id) ?? []), entry]), ...afterAll];
}

function correlateMessageAnchors(
  entries: RuntimeTranscriptEntry[],
  tokens: RolloutToken[],
): { entries: RuntimeTranscriptEntry[]; tokens: RolloutToken[]; complete: boolean } {
  const anchors = tokens.filter((token): token is Extract<RolloutToken, { kind: "anchor" }> => token.kind === "anchor");
  const canonicalByRolloutId = new Map<string, string>();
  const aliasesByEntryId = new Map<string, string[]>();
  let complete = true;

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  for (const anchor of anchors) {
    if (entriesById.has(anchor.id)) canonicalByRolloutId.set(anchor.id, anchor.id);
  }

  const appServerTurns = appServerMessageTurns(entries);
  const rolloutTurns = rolloutMessageTurns(tokens);
  if (appServerTurns.length !== rolloutTurns.length) complete = false;
  for (let index = 0; index < Math.min(appServerTurns.length, rolloutTurns.length); index += 1) {
    const appServerTurn = appServerTurns[index];
    const rolloutTurn = rolloutTurns[index];
    if (!appServerTurn || !rolloutTurn) continue;
    if (
      appServerTurn.users.length !== (rolloutTurn.user ? 1 : 0) ||
      appServerTurn.assistants.length !== rolloutTurn.assistants.length
    ) {
      complete = false;
      continue;
    }
    if (rolloutTurn.user && appServerTurn.users[0])
      correlateNativeAnchor(rolloutTurn.user, appServerTurn.users[0], canonicalByRolloutId, aliasesByEntryId);
    for (const [assistantIndex, anchor] of rolloutTurn.assistants.entries()) {
      const entry = appServerTurn.assistants[assistantIndex];
      if (entry) correlateNativeAnchor(anchor, entry, canonicalByRolloutId, aliasesByEntryId);
    }
  }
  const messageEntries = entries.filter((entry) => entry.kind === "user" || entry.kind === "assistant");
  if (messageEntries.some((entry) => !entry.position || !hasCorrelatedId(entry, canonicalByRolloutId)))
    complete = false;
  return {
    entries: entries.map((entry) => {
      const aliases = aliasesByEntryId.get(entry.id);
      return aliases ? { ...entry, aliases: [...(entry.aliases ?? []), ...aliases] } : entry;
    }),
    tokens: tokens.map((token) => {
      if (token.kind !== "anchor") return token;
      const canonicalId = canonicalByRolloutId.get(token.id);
      return canonicalId ? { ...token, id: canonicalId } : token;
    }),
    complete,
  };
}

interface MessageTurn<T> {
  users: T[];
  assistants: T[];
}

function appServerMessageTurns(entries: RuntimeTranscriptEntry[]): Array<MessageTurn<RuntimeTranscriptEntry>> {
  const turns = new Map<number, MessageTurn<RuntimeTranscriptEntry>>();
  for (const entry of entries) {
    if (entry.kind !== "user" && entry.kind !== "assistant") continue;
    const match = /^(\d+)\./u.exec(entry.position ?? "");
    if (!match?.[1]) continue;
    const turnIndex = Number(match[1]);
    const turn = turns.get(turnIndex) ?? { users: [], assistants: [] };
    if (entry.kind === "user") turn.users.push(entry);
    else turn.assistants.push(entry);
    turns.set(turnIndex, turn);
  }
  return [...turns.entries()].sort(([left], [right]) => left - right).map(([, turn]) => turn);
}

function rolloutMessageTurns(
  tokens: RolloutToken[],
): Array<{ user: RolloutAnchor | null; assistants: RolloutAnchor[] }> {
  const turns: Array<{ user: RolloutAnchor | null; assistants: RolloutAnchor[] }> = [];
  let current: { user: RolloutAnchor | null; assistants: RolloutAnchor[]; activityStarted: boolean } | null = null;
  for (const token of tokens) {
    if (token.kind === "call") {
      if (current) current.activityStarted = true;
      continue;
    }
    if (token.role === "user") {
      if (current?.activityStarted) {
        turns.push(current);
        current = null;
      }
      current ??= { user: null, assistants: [], activityStarted: false };
      current.user = token;
      continue;
    }
    if (token.role !== "assistant") continue;
    current ??= { user: null, assistants: [], activityStarted: false };
    current.activityStarted = true;
    current.assistants.push(token);
  }
  if (current) turns.push(current);
  return turns;
}

type RolloutAnchor = Extract<RolloutToken, { kind: "anchor" }>;

function correlateNativeAnchor(
  anchor: RolloutAnchor,
  entry: RuntimeTranscriptEntry,
  canonicalByRolloutId: Map<string, string>,
  aliasesByEntryId: Map<string, string[]>,
): void {
  canonicalByRolloutId.set(anchor.id, entry.id);
  if (anchor.id !== entry.id) aliasesByEntryId.set(entry.id, [anchor.id]);
}

function hasCorrelatedId(entry: RuntimeTranscriptEntry, canonicalByRolloutId: ReadonlyMap<string, string>): boolean {
  return [...canonicalByRolloutId.values()].includes(entry.id);
}

function isRawToolCall(type: string): boolean {
  return type === "custom_tool_call" || type === "function_call" || type === "tool_search_call";
}

function isRawToolOutput(type: string): boolean {
  return type === "custom_tool_call_output" || type === "function_call_output" || type === "tool_search_output";
}

function rawToolName(type: string, payload: Record<string, unknown>): string {
  if (type === "tool_search_call") return "tool_search";
  return stringValue(payload.name);
}

function matchesAppServerCommand(call: RolloutCall, entries: RuntimeTranscriptEntry[]): boolean {
  if (call.name !== "exec_command") return false;
  const command = rawExecCommand(call.input);
  return Boolean(
    command && entries.some((entry) => entry.kind === "command" && stringValue(entry.data?.command).trim() === command),
  );
}

function rawExecCommand(input: unknown): string {
  if (typeof input !== "string") return "";
  try {
    const parsed = objectValue(JSON.parse(input));
    return stringValue(parsed?.cmd).trim();
  } catch {
    return "";
  }
}

function rawToolState(status: string): RuntimeTranscriptEntry["state"] {
  if (/fail|error/iu.test(status)) return "error";
  if (/cancel|interrupt|declin/iu.test(status)) return "cancelled";
  if (/progress|running|pending/iu.test(status)) return "streaming";
  return "complete";
}

function visibleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = objectValue(item);
        const text = stringValue(record?.text);
        return text || visibleScalar(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  return visibleScalar(value);
}

function visibleScalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolDetail(title: string, input: string, output: string): string {
  return [title, ...(input ? [`Input:\n${input}`] : []), ...(output ? [`Output:\n${output}`] : [])].join("\n\n");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
