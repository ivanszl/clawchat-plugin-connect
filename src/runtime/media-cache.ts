import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConnectRuntimeMedia } from "./types";

export const MAX_RUNTIME_MEDIA_BYTES = 100 * 1024 * 1024;

export type RuntimeMediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CacheRuntimeMediaOptions {
  fetch?: RuntimeMediaFetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function cacheRuntimeMedia(
  media: ConnectRuntimeMedia,
  stateDbPath: string,
  options: CacheRuntimeMediaOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_RUNTIME_MEDIA_BYTES;
  if (media.size !== undefined && media.size > maxBytes) {
    throw new Error(`ClawChat media ${displayName(media)} exceeds the ${maxBytes}-byte download limit`);
  }
  const source = parseMediaUrl(media.url);
  const key = createHash("sha256").update(media.url).digest("hex");
  const directory = join(dirname(stateDbPath), "media-cache", key.slice(0, 32));
  const target = join(directory, safeMediaName(media, source));
  const existing = await stat(target).catch(() => null);
  if (existing?.isFile() && existing.size > 0 && existing.size <= maxBytes) return target;

  const response = await (options.fetch ?? globalThis.fetch)(source, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok)
    throw new Error(`ClawChat media ${displayName(media)} download failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`ClawChat media ${displayName(media)} exceeds the ${maxBytes}-byte download limit`);
  }
  if (!response.body) throw new Error(`ClawChat media ${displayName(media)} download returned an empty body`);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.download`);
  let received = 0;
  const reader = response.body.getReader();
  const output = await open(temporary, "wx", 0o600);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        throw new Error(`ClawChat media ${displayName(media)} exceeds the ${maxBytes}-byte download limit`);
      }
      await output.write(chunk.value);
    }
    if (received === 0) throw new Error(`ClawChat media ${displayName(media)} download returned an empty body`);
    await output.sync();
    await output.close();
    await rename(temporary, target);
    return target;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await output.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseMediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ClawChat media URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`ClawChat media URL protocol is unsupported: ${url.protocol}`);
  }
  return url;
}

function safeMediaName(media: ConnectRuntimeMedia, source: URL): string {
  const sourceName = decodePathName(source.pathname);
  const candidate = (media.name || sourceName || media.kind).replace(/\\/gu, "/").split("/").at(-1) || media.kind;
  const normalized = candidate
    .normalize("NFKC")
    .replace(/[\0]/gu, "_")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  return normalized.slice(0, 160) || media.kind;
}

function decodePathName(pathname: string): string {
  const encoded = pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function displayName(media: ConnectRuntimeMedia): string {
  return media.name || media.kind;
}
