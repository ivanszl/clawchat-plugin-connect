import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type { ConnectRuntimeMedia } from "./types";

export const MAX_RUNTIME_MEDIA_BYTES = 100 * 1024 * 1024;
export const MAX_RUNTIME_MEDIA_CACHE_BYTES = 512 * 1024 * 1024;
export const RUNTIME_MEDIA_CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1_000;

export type RuntimeMediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RuntimeMediaHostResolver = (hostname: string) => Promise<string[]>;

export interface CacheRuntimeMediaOptions {
  fetch?: RuntimeMediaFetch;
  maxBytes?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  trustedOrigins?: readonly string[];
  resolveHostname?: RuntimeMediaHostResolver;
  maxRedirects?: number;
}

interface RuntimeMediaRequestPolicy {
  trustedOrigins: ReadonlySet<string>;
  resolveHostname: RuntimeMediaHostResolver;
  maxRedirects: number;
}

export async function cacheRuntimeMedia(
  media: ConnectRuntimeMedia,
  stateDbPath: string,
  options: CacheRuntimeMediaOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_RUNTIME_MEDIA_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_RUNTIME_MEDIA_CACHE_BYTES;
  const ttlMs = options.ttlMs ?? RUNTIME_MEDIA_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  requirePositiveLimit(maxBytes, "maxBytes");
  requirePositiveLimit(maxTotalBytes, "maxTotalBytes");
  requirePositiveLimit(ttlMs, "ttlMs");
  if (media.size !== undefined && media.size > maxBytes) {
    throw new Error(`ClawChat media ${displayName(media)} exceeds the ${maxBytes}-byte download limit`);
  }
  if (media.size !== undefined && media.size > maxTotalBytes) {
    throw new Error(`ClawChat media ${displayName(media)} exceeds the ${maxTotalBytes}-byte total cache limit`);
  }
  const source = parseMediaUrl(media.url);
  const requestPolicy = createRequestPolicy(options);
  await assertSafeMediaUrl(source, requestPolicy.trustedOrigins, requestPolicy.resolveHostname);
  const key = createHash("sha256").update(media.url).digest("hex");
  const cacheRoot = join(dirname(stateDbPath), "media-cache");
  const directory = join(cacheRoot, key.slice(0, 32));
  const target = join(directory, safeMediaName(media, source));
  await pruneRuntimeMediaCache(cacheRoot, { maxTotalBytes, ttlMs, now: now(), requiredBytes: 0 });
  const existing = await stat(target).catch(() => null);
  if (existing?.isFile() && existing.size > 0 && existing.size <= maxBytes) {
    const accessedAt = new Date(now());
    await utimes(target, accessedAt, accessedAt);
    return target;
  }
  if (existing) await rm(target, { force: true });

  const response = await fetchRuntimeMedia(source, options, requestPolicy);
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
    await pruneRuntimeMediaCache(cacheRoot, {
      maxTotalBytes,
      ttlMs,
      now: now(),
      requiredBytes: received,
    });
    await rename(temporary, target);
    const cachedAt = new Date(now());
    await utimes(target, cachedAt, cachedAt);
    return target;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await output.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function createRequestPolicy(options: CacheRuntimeMediaOptions): RuntimeMediaRequestPolicy {
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("maxRedirects must be a non-negative integer");
  }
  return {
    trustedOrigins: normalizeTrustedOrigins(options.trustedOrigins ?? []),
    resolveHostname: options.resolveHostname ?? resolveHostAddresses,
    maxRedirects,
  };
}

async function fetchRuntimeMedia(
  source: URL,
  options: CacheRuntimeMediaOptions,
  policy: RuntimeMediaRequestPolicy,
): Promise<Response> {
  const fetchMedia = options.fetch ?? globalThis.fetch;
  let current = source;
  for (let redirectCount = 0; ; redirectCount += 1) {
    if (redirectCount > 0) {
      await assertSafeMediaUrl(current, policy.trustedOrigins, policy.resolveHostname);
    }
    const response = await fetchMedia(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectCount >= policy.maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`ClawChat media redirect limit exceeded (${policy.maxRedirects})`);
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error("ClawChat media redirect is missing a Location header");
    current = new URL(location, current);
  }
}

function normalizeTrustedOrigins(values: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`trusted media origin is invalid: ${value}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`trusted media origin protocol is unsupported: ${url.protocol}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

async function assertSafeMediaUrl(
  url: URL,
  trustedOrigins: ReadonlySet<string>,
  resolveHostname: RuntimeMediaHostResolver,
): Promise<void> {
  if (url.username || url.password) throw new Error("ClawChat media URL must not contain credentials");
  if (trustedOrigins.has(url.origin)) return;
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`ClawChat media URL resolves to a private or local address: ${hostname || "(missing)"}`);
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
  if (addresses.length === 0) throw new Error(`ClawChat media host did not resolve: ${hostname}`);
  if (addresses.some(isPrivateOrLocalAddress)) {
    throw new Error(`ClawChat media URL resolves to a private or local address: ${hostname}`);
  }
  if (url.protocol !== "https:") throw new Error("untrusted ClawChat media URLs must use HTTPS");
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPrivateOrLocalAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first = 0, second = 0] = address.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const mappedV4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mappedV4) return isPrivateOrLocalAddress(mappedV4);
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  return true;
}

interface CachedMediaFile {
  path: string;
  directory: string;
  size: number;
  mtimeMs: number;
}

async function pruneRuntimeMediaCache(
  cacheRoot: string,
  options: { maxTotalBytes: number; ttlMs: number; now: number; requiredBytes: number },
): Promise<void> {
  if (options.requiredBytes > options.maxTotalBytes) {
    throw new Error(`ClawChat media exceeds the ${options.maxTotalBytes}-byte total cache limit`);
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const files = await listCachedMediaFiles(cacheRoot);
  const retained: CachedMediaFile[] = [];
  for (const file of files) {
    if (options.now - file.mtimeMs >= options.ttlMs) {
      await removeCachedMediaFile(file);
    } else {
      retained.push(file);
    }
  }
  retained.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  let totalBytes = retained.reduce((total, file) => total + file.size, 0);
  for (const file of retained) {
    if (totalBytes + options.requiredBytes <= options.maxTotalBytes) break;
    await removeCachedMediaFile(file);
    totalBytes -= file.size;
  }
}

async function listCachedMediaFiles(cacheRoot: string): Promise<CachedMediaFile[]> {
  const files: CachedMediaFile[] = [];
  const directories = await readdir(cacheRoot, { withFileTypes: true });
  for (const directoryEntry of directories) {
    if (!directoryEntry.isDirectory()) continue;
    const directory = join(cacheRoot, directoryEntry.name);
    for (const fileEntry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!fileEntry.isFile() || fileEntry.name.startsWith(".")) continue;
      const path = join(directory, fileEntry.name);
      const metadata = await stat(path).catch(() => null);
      if (metadata?.isFile()) {
        files.push({ path, directory, size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
    }
  }
  return files;
}

async function removeCachedMediaFile(file: CachedMediaFile): Promise<void> {
  await rm(file.path, { force: true });
  await rm(file.directory).catch(() => undefined);
}

function requirePositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
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
