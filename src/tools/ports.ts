import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { buildTextMessagePayload } from "../message-mapper";
import { type ChatType, EVENT } from "../protocol";
import type { ConnectStateStore } from "../state";
import type { ConnectConfig } from "../types";
import { ConnectWsClient } from "../ws-client";
import type { MemoryPort, MentionMessagePort } from "./registry";

interface MentionInput {
  chatId: string;
  chatType?: ChatType;
  text: string;
  mentions: Array<{ userId: string; display?: string }>;
  replyToMessageId?: string | null;
}

export function createMentionMessagePort(wsClient: ConnectWsClient): MentionMessagePort {
  return {
    async sendMentionMessage(input) {
      return await sendMention(wsClient, input);
    },
  };
}

export function createStandaloneMentionMessagePort(params: {
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  agentId: string;
}): MentionMessagePort {
  let clientPromise: Promise<ConnectWsClient> | null = null;
  async function client(): Promise<ConnectWsClient> {
    clientPromise ??= (async () => {
      const activation = await params.stateStore.getActivation(params.agentId);
      if (!activation) throw new Error(`agent ${params.agentId} is not activated`);
      const wsClient = new ConnectWsClient({
        url: params.config.websocketUrl,
        token: activation.accessToken,
        stateStore: params.stateStore,
      });
      await wsClient.connect();
      return wsClient;
    })();
    return await clientPromise;
  }
  return {
    async sendMentionMessage(input) {
      return await sendMention(await client(), input);
    },
  };
}

export function createFileBackedMemoryPort(config: ConnectConfig): MemoryPort {
  const root = join(dirname(config.stateDbPath), "memory");
  const metadataRoot = join(root, ".metadata");
  const memoryFileFor = (targetType: string, targetId: string) =>
    join(root, sanitize(targetType), `${sanitize(targetId)}.md`);
  const metadataFileFor = (targetType: string, targetId: string) =>
    join(metadataRoot, sanitize(targetType), `${sanitize(targetId)}.json`);
  return {
    async search(input) {
      const record = inputRecord(input);
      const query = String(record.query ?? "").toLowerCase();
      const targetTypes = Array.isArray(record.targetTypes)
        ? record.targetTypes.map(String)
        : ["owner", "user", "group"];
      const maxResults =
        typeof record.maxResults === "number" ? Math.max(1, Math.min(50, Math.trunc(record.maxResults))) : 10;
      const files = await listMemoryFiles(root, targetTypes);
      const results: Array<{ targetType: string; targetId: string; path: string; score: number; preview: string }> = [];
      for (const file of files) {
        const content = await readFile(file, "utf8").catch(() => "");
        const lower = content.toLowerCase();
        const index = query ? lower.indexOf(query) : 0;
        if (index < 0) continue;
        const rel = relative(root, file);
        const [targetType = "", name = ""] = rel.split(/[\\/]/u);
        const targetId = name.replace(/\.md$/u, "");
        results.push({
          targetType,
          targetId,
          path: file,
          score: query ? countOccurrences(lower, query) : 1,
          preview: snippet(content, index),
        });
      }
      results.sort(
        (a, b) => b.score - a.score || a.targetType.localeCompare(b.targetType) || a.targetId.localeCompare(b.targetId),
      );
      return { query, results: results.slice(0, maxResults) };
    },
    async read(input) {
      const record = inputRecord(input);
      const path = memoryFileFor(String(record.targetType), String(record.targetId));
      const content = await readFile(path, "utf8").catch(() => "");
      const offset = typeof record.offset === "number" ? Math.max(0, Math.trunc(record.offset)) : 0;
      const limit = typeof record.limit === "number" ? Math.max(1, Math.trunc(record.limit)) : undefined;
      return {
        targetType: record.targetType,
        targetId: record.targetId,
        content: limit ? content.slice(offset, offset + limit) : content.slice(offset),
        totalBytes: Buffer.byteLength(content),
      };
    },
    async write(input) {
      const record = inputRecord(input);
      const path = memoryFileFor(String(record.targetType), String(record.targetId));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const existing = await readFile(path, "utf8").catch(() => "");
      const next =
        record.mode === "replace"
          ? String(record.content ?? "")
          : `${existing}${existing ? "\n" : ""}${String(record.content ?? "")}`;
      await writeFile(path, next, { mode: 0o600 });
      return {
        ok: true,
        targetType: record.targetType,
        targetId: record.targetId,
        bytes: Buffer.byteLength(next),
      };
    },
    async edit(input) {
      const record = inputRecord(input);
      const path = memoryFileFor(String(record.targetType), String(record.targetId));
      const existing = await readFile(path, "utf8");
      const oldText = String(record.oldText);
      const matches = existing.split(oldText).length - 1;
      if (matches !== 1) throw new Error("oldText must match exactly once");
      const next = existing.replace(oldText, String(record.newText ?? ""));
      await writeFile(path, next, { mode: 0o600 });
      return {
        ok: true,
        targetType: record.targetType,
        targetId: record.targetId,
        bytes: Buffer.byteLength(next),
      };
    },
    async metadataSync(input) {
      const record = inputRecord(input);
      const metadata = await readMetadata(metadataFileFor(String(record.targetType), String(record.targetId)));
      const fields = Array.isArray(record.fields) ? record.fields.map(String) : null;
      const selected = fields
        ? Object.fromEntries(Object.entries(metadata).filter(([key]) => fields.includes(key)))
        : metadata;
      return {
        ok: true,
        direction: record.direction,
        targetType: record.targetType,
        targetId: record.targetId,
        metadata: selected,
      };
    },
    async metadataUpdate(input) {
      const record = inputRecord(input);
      const path = metadataFileFor(String(record.targetType), String(record.targetId));
      const current = await readMetadata(path);
      const next = { ...current, ...inputRecord(record.patch), updated_at: new Date().toISOString() };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      return { ok: true, targetType: record.targetType, targetId: record.targetId, metadata: next };
    },
  };
}

async function sendMention(wsClient: ConnectWsClient, input: MentionInput): Promise<unknown> {
  return await wsClient.sendMessageEnvelope(
    EVENT.MESSAGE_SEND,
    input.chatId,
    buildTextMessagePayload(input.text, { mentions: input.mentions, replyToMessageId: input.replyToMessageId ?? null }),
    { toType: input.chatType ?? "group" },
  );
}

async function listMemoryFiles(root: string, targetTypes: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const targetType of targetTypes) {
    const dir = join(root, sanitize(targetType));
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".md")) files.push(join(dir, entry.name));
  }
  return files;
}
function countOccurrences(text: string, query: string): number {
  if (!query) return 1;
  return text.split(query).length - 1;
}
function snippet(content: string, index: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + 180);
  return content.slice(start, end);
}
function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

async function readMetadata(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function sanitize(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/u.test(value)) throw new Error("unsafe memory target id");
  return value;
}
