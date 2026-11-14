import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isPathWithin } from "../path-containment";
import { MAX_RUNTIME_MEDIA_BYTES } from "./media-cache";
import type { ConnectRuntimeMedia } from "./types";

/** Directory inside the DSH Workspace that holds files received from ClawChat. */
export const DSH_INBOX_DIRECTORY = "clawchat-inbox";
/** Owner decision 2026-11-14: files received from ClawChat are accepted up to 100 MiB each. */
export const DSH_MAX_INBOUND_FILE_BYTES = MAX_RUNTIME_MEDIA_BYTES;
export const DSH_MAX_INBOUND_FILES = 10;
/** Owner decision 2026-11-14: inbox turn directories are kept 30 days after their newest file. */
export const DSH_INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Most turn directories examined and removed per staging call. */
export const DSH_INBOX_PRUNE_BATCH = 50;
const MAX_NAME_BYTES = 120;

export interface StagedInboxFile {
  path: string;
  name: string;
  mime: string;
  kind: ConnectRuntimeMedia["kind"];
  size: number;
}

/** Reduces an untrusted attachment name to a single safe path segment. */
export function sanitizeInboxName(rawName: string | undefined, kind: string, mime: string | undefined): string {
  const lastSegment = (rawName ?? "").split(/[\\/]/u).pop() ?? "";
  let name = lastSegment
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being removed.
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .trim()
    .replace(/^\.+/u, "");
  if (name === "" || name === "_") name = "";
  if (name === "") name = `${kind}${mime ? extensionForMime(mime) : ""}`;
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const budget = MAX_NAME_BYTES - Buffer.byteLength(extension);
  let trimmed = stem;
  while (Buffer.byteLength(trimmed) > budget) trimmed = trimmed.slice(0, -1);
  return `${trimmed || kind}${extension}`;
}

function extensionForMime(mime: string): string {
  const table: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return table[mime.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "";
}

function safeSegment(value: string | undefined): string {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "");
  return cleaned.slice(0, 80) || `turn-${randomUUID()}`;
}

export interface DroppedInboxFile {
  name: string;
  reason: string;
}

export interface InboxStagingResult {
  staged: StagedInboxFile[];
  dropped: DroppedInboxFile[];
}

/**
 * Copies already-downloaded media into `<workspace>/clawchat-inbox/<message-id>/<safe-name>`.
 * One bad attachment is dropped with a reason and never fails the rest. The Workspace must be canonical; the
 * inbox directories must be real directories inside it.
 */
export async function stageIntoWorkspaceInbox(
  workspace: string,
  messageId: string | undefined,
  items: ReadonlyArray<{ media: ConnectRuntimeMedia; sourcePath: string }>,
): Promise<InboxStagingResult> {
  const result: InboxStagingResult = { staged: [], dropped: [] };
  if (items.length === 0) return result;
  const root = await realpath(workspace);
  const inbox = join(root, DSH_INBOX_DIRECTORY);
  const directory = join(inbox, safeSegment(messageId));
  await ensureRealDirectory(root, inbox);
  await ensureRealDirectory(root, directory);
  const real = await realpath(directory);
  if (!isPathWithin(root, real, { allowEqual: false })) throw new Error("DeepSeek Harness inbox escaped the Workspace");

  await pruneExpiredInbox(real, inbox);

  const used = new Set<string>();
  for (const [index, { media, sourcePath }] of items.entries()) {
    const label = sanitizeInboxName(media.name, media.kind, media.mime);
    if (index >= DSH_MAX_INBOUND_FILES) {
      result.dropped.push({ name: label, reason: `more than ${DSH_MAX_INBOUND_FILES} attachments in one turn` });
      continue;
    }
    try {
      const details = await stat(sourcePath);
      if (!details.isFile()) throw new DropError("not a regular file");
      if (details.size > DSH_MAX_INBOUND_FILE_BYTES) throw new DropError("larger than 100 MiB");
      const path = await copyIntoInbox(real, sourcePath, label, details.size, used);
      result.staged.push({
        path,
        name: basename(path),
        mime: media.mime ?? "application/octet-stream",
        kind: media.kind,
        size: details.size,
      });
    } catch (error) {
      result.dropped.push({ name: label, reason: error instanceof DropError ? error.message : "could not be saved" });
    }
  }
  return result;
}

/**
 * Best-effort retention: removes real turn directories directly under the real inbox whose newest entry is older
 * than the retention period. Symlinks are never followed or removed, the current turn is skipped, the work per
 * call is capped, and failures only produce a short warning.
 */
async function pruneExpiredInbox(currentDirectory: string, inbox: string, now = Date.now()): Promise<void> {
  try {
    const realInbox = await realpath(inbox);
    const entries = (await readdir(realInbox))
      .filter((name) => join(realInbox, name) !== currentDirectory)
      .slice(0, DSH_INBOX_PRUNE_BATCH);
    for (const name of entries) {
      const directory = join(realInbox, name);
      try {
        const details = await lstat(directory);
        if (details.isSymbolicLink() || !details.isDirectory()) continue;
        let newest = details.mtimeMs;
        for (const child of await readdir(directory)) {
          newest = Math.max(newest, (await lstat(join(directory, child))).mtimeMs);
        }
        if (now - newest > DSH_INBOX_RETENTION_MS) await rm(directory, { recursive: true, force: true });
      } catch {
        console.warn("DeepSeek Harness inbox cleanup skipped an entry");
      }
    }
  } catch {
    console.warn("DeepSeek Harness inbox cleanup failed");
  }
}

class DropError extends Error {}

/** Copies without overwriting, reusing an identical earlier copy (redelivery) or picking a unique suffix. */
async function copyIntoInbox(
  directory: string,
  sourcePath: string,
  name: string,
  size: number,
  used: Set<string>,
): Promise<string> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let sourceDigest: string | undefined;
  for (let attempt = 1; attempt <= 1_000; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem}-${attempt}${extension}`;
    if (used.has(candidate.toLowerCase())) continue;
    const target = join(directory, candidate);
    try {
      // COPYFILE_EXCL fails on any existing path, including a planted symlink, so nothing is written through one.
      await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await lstat(target).catch(() => null);
      if (existing?.isFile() && existing.size === size) {
        sourceDigest ??= await sha256(sourcePath);
        if ((await sha256(target)) === sourceDigest) {
          used.add(candidate.toLowerCase());
          return target;
        }
      }
      continue;
    }
    // Re-resolve after the copy: a concurrent swap of the path must not leave a file outside the inbox.
    const final = await realpath(target).catch(() => null);
    if (!final || !isPathWithin(directory, final, { allowEqual: false })) {
      await rm(target, { force: true }).catch(() => undefined);
      throw new DropError("could not be saved safely");
    }
    used.add(candidate.toLowerCase());
    return final;
  }
  throw new DropError("could not be saved");
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function ensureRealDirectory(root: string, path: string): Promise<void> {
  const existing = await lstat(path).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("DeepSeek Harness inbox path is not a plain directory inside the Workspace");
    }
  } else {
    await mkdir(path, { mode: 0o700 });
  }
  if (!isPathWithin(root, await realpath(path), { allowEqual: false }))
    throw new Error("DeepSeek Harness inbox escaped the Workspace");
}

/** Short note appended to the model input; mirrors the Pi plugin's attachment note (src/media.ts). */
export function inboxPathNote(files: readonly StagedInboxFile[], dropped: readonly DroppedInboxFile[] = []): string {
  if (files.length === 0 && dropped.length === 0) return "";
  const lines = [
    ...files.map(
      (file) =>
        `Attachment ${file.name}: ${file.path} (${file.mime}, ${file.size} bytes). Use an available analysis tool if supported; do not claim to have analyzed it without doing so.`,
    ),
    ...dropped.map((file) => `Attachment ${file.name} was not received: ${file.reason}.`),
  ];
  return `\n\n<clawchat_attachments>\n${lines.join("\n")}\n</clawchat_attachments>`;
}
