import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { buildTextMessagePayload } from "../message-mapper.js";
import { EVENT, type ChatType } from "../protocol.js";
import type { ConnectStateStore } from "../state.js";
import type { ConnectConfig } from "../types.js";
import { ConnectWsClient } from "../ws-client.js";
import type { MemoryPort, MentionMessagePort } from "./registry.js";

interface MentionInput { chatId: string; chatType?: ChatType; text: string; mentions: Array<{ userId: string; display?: string }>; replyToMessageId?: string | null }

export function createMentionMessagePort(wsClient: ConnectWsClient): MentionMessagePort {
  return { async sendMentionMessage(input) { return await sendMention(wsClient, input); } };
}

export function createStandaloneMentionMessagePort(params: { config: ConnectConfig; stateStore: ConnectStateStore; agentId: string }): MentionMessagePort {
  let clientPromise: Promise<ConnectWsClient> | null = null;
  async function client(): Promise<ConnectWsClient> {
    clientPromise ??= (async () => {
      const activation = await params.stateStore.getActivation(params.agentId);
      if (!activation) throw new Error(`agent ${params.agentId} is not activated`);
      const wsClient = new ConnectWsClient({ url: params.config.websocketUrl, token: activation.accessToken, stateStore: params.stateStore });
      await wsClient.connect();
      return wsClient;
    })();
    return await clientPromise;
  }
  return { async sendMentionMessage(input) { return await sendMention(await client(), input); } };
}

export function createFileBackedMemoryPort(config: ConnectConfig): MemoryPort {
  const root = join(dirname(config.stateDbPath), "memory");
  const metadataRoot = join(root, ".metadata");
  const memoryFileFor = (targetType: string, targetId: string) => join(root, sanitize(targetType), `${sanitize(targetId)}.md`);
  const metadataFileFor = (targetType: string, targetId: string) => join(metadataRoot, sanitize(targetType), `${sanitize(targetId)}.json`);
  return {
    async search(input) {
      const query = String((input as any).query ?? "").toLowerCase();
      const targetTypes = Array.isArray((input as any).targetTypes) ? (input as any).targetTypes.map(String) : ["owner", "user", "group"];
      const maxResults = typeof (input as any).maxResults === "number" ? Math.max(1, Math.min(50, Math.trunc((input as any).maxResults))) : 10;
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
        results.push({ targetType, targetId, path: file, score: query ? countOccurrences(lower, query) : 1, preview: snippet(content, index) });
      }
      results.sort((a, b) => b.score - a.score || a.targetType.localeCompare(b.targetType) || a.targetId.localeCompare(b.targetId));
      return { query, results: results.slice(0, maxResults) };
    },
    async read(input) {
      const path = memoryFileFor(String((input as any).targetType), String((input as any).targetId));
      const content = await readFile(path, "utf8").catch(() => "");
      const offset = typeof (input as any).offset === "number" ? Math.max(0, Math.trunc((input as any).offset)) : 0;
      const limit = typeof (input as any).limit === "number" ? Math.max(1, Math.trunc((input as any).limit)) : undefined;
      return { targetType: (input as any).targetType, targetId: (input as any).targetId, content: limit ? content.slice(offset, offset + limit) : content.slice(offset), totalBytes: Buffer.byteLength(content) };
    },
    async write(input) {
      const path = memoryFileFor(String((input as any).targetType), String((input as any).targetId));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const existing = await readFile(path, "utf8").catch(() => "");
      const next = (input as any).mode === "replace" ? String((input as any).content ?? "") : `${existing}${existing ? "\n" : ""}${String((input as any).content ?? "")}`;
      await writeFile(path, next, { mode: 0o600 });
      return { ok: true, targetType: (input as any).targetType, targetId: (input as any).targetId, bytes: Buffer.byteLength(next) };
    },
    async edit(input) {
      const path = memoryFileFor(String((input as any).targetType), String((input as any).targetId));
      const existing = await readFile(path, "utf8");
      const oldText = String((input as any).oldText);
      const matches = existing.split(oldText).length - 1;
      if (matches !== 1) throw new Error("oldText must match exactly once");
      const next = existing.replace(oldText, String((input as any).newText ?? ""));
      await writeFile(path, next, { mode: 0o600 });
      return { ok: true, targetType: (input as any).targetType, targetId: (input as any).targetId, bytes: Buffer.byteLength(next) };
    },
    async metadataSync(input) {
      const metadata = await readMetadata(metadataFileFor(String((input as any).targetType), String((input as any).targetId)));
      const fields = Array.isArray((input as any).fields) ? (input as any).fields.map(String) : null;
      const selected = fields ? Object.fromEntries(Object.entries(metadata).filter(([key]) => fields.includes(key))) : metadata;
      return { ok: true, direction: (input as any).direction, targetType: (input as any).targetType, targetId: (input as any).targetId, metadata: selected };
    },
    async metadataUpdate(input) {
      const path = metadataFileFor(String((input as any).targetType), String((input as any).targetId));
      const current = await readMetadata(path);
      const next = { ...current, ...((input as any).patch ?? {}), updated_at: new Date().toISOString() };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      return { ok: true, targetType: (input as any).targetType, targetId: (input as any).targetId, metadata: next };
    },
  };
}

async function sendMention(wsClient: ConnectWsClient, input: MentionInput): Promise<unknown> {
  return await wsClient.sendMessageEnvelope(EVENT.MESSAGE_SEND, input.chatId, buildTextMessagePayload(input.text, { mentions: input.mentions, replyToMessageId: input.replyToMessageId ?? null }), { toType: input.chatType ?? "group" });
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
function countOccurrences(text: string, query: string): number { if (!query) return 1; return text.split(query).length - 1; }
function snippet(content: string, index: number): string { const start = Math.max(0, index - 80); const end = Math.min(content.length, index + 180); return content.slice(start, end); }
async function readMetadata(path: string): Promise<Record<string, unknown>> { try { const parsed = JSON.parse(await readFile(path, "utf8")) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function sanitize(value: string): string { if (!/^[A-Za-z0-9._:-]+$/u.test(value)) throw new Error("unsafe memory target id"); return value; }
