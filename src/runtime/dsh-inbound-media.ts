import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import type { ConnectRuntimeMedia } from "./types";

/** Directory inside the DSH Workspace that holds files received from ClawChat. */
export const DSH_INBOX_DIRECTORY = "clawchat-inbox";
/** Owner decision 2026-11-14: files received from ClawChat are accepted up to 100 MiB each. */
export const DSH_MAX_INBOUND_FILE_BYTES = 100 * 1024 * 1024;
export const DSH_MAX_INBOUND_TURN_BYTES = 100 * 1024 * 1024;
export const DSH_MAX_INBOUND_FILES = 10;
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

function within(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

/**
 * Copies already-downloaded media into `<workspace>/clawchat-inbox/<message-id>/<safe-name>`.
 * The Workspace must be canonical; the inbox directories must be real directories inside it.
 */
export async function stageIntoWorkspaceInbox(
  workspace: string,
  messageId: string | undefined,
  items: ReadonlyArray<{ media: ConnectRuntimeMedia; sourcePath: string }>,
): Promise<StagedInboxFile[]> {
  if (items.length === 0) return [];
  if (items.length > DSH_MAX_INBOUND_FILES) {
    throw new Error(`DeepSeek Harness accepts at most ${DSH_MAX_INBOUND_FILES} attachments per turn`);
  }
  const root = await realpath(workspace);
  const inbox = join(root, DSH_INBOX_DIRECTORY);
  const directory = join(inbox, safeSegment(messageId));
  await ensureRealDirectory(root, inbox);
  await ensureRealDirectory(root, directory);
  const real = await realpath(directory);
  if (!within(root, real)) throw new Error("DeepSeek Harness inbox escaped the Workspace");

  const staged: StagedInboxFile[] = [];
  const used = new Set<string>();
  let total = 0;
  try {
    for (const { media, sourcePath } of items) {
      const details = await stat(sourcePath);
      if (!details.isFile()) throw new Error(`ClawChat attachment ${media.name ?? media.kind} is not a regular file`);
      if (details.size > DSH_MAX_INBOUND_FILE_BYTES) {
        throw new Error(
          `ClawChat attachment ${media.name ?? media.kind} exceeds the ${DSH_MAX_INBOUND_FILE_BYTES}-byte limit`,
        );
      }
      total += details.size;
      if (total > DSH_MAX_INBOUND_TURN_BYTES) {
        throw new Error(`ClawChat attachments exceed the ${DSH_MAX_INBOUND_TURN_BYTES}-byte per-turn limit`);
      }
      const name = uniqueName(sanitizeInboxName(media.name, media.kind, media.mime), used);
      const target = join(real, name);
      // COPYFILE_EXCL fails on an existing path (including a planted symlink), so nothing is written through one.
      await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
      staged.push({
        path: target,
        name,
        mime: media.mime ?? "application/octet-stream",
        kind: media.kind,
        size: details.size,
      });
    }
  } catch (error) {
    await Promise.all(staged.map(async (file) => await rm(file.path, { force: true }).catch(() => undefined)));
    throw error;
  }
  return staged;
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
  if (!within(root, await realpath(path))) throw new Error("DeepSeek Harness inbox escaped the Workspace");
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) candidate = `${stem}-${index}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Short note appended to the model input; mirrors the Pi plugin's attachment note (src/media.ts). */
export function inboxPathNote(files: readonly StagedInboxFile[]): string {
  if (files.length === 0) return "";
  const lines = files.map(
    (file) =>
      `Attachment ${file.name}: ${file.path} (${file.mime}, ${file.size} bytes). Use an available analysis tool if supported; do not claim to have analyzed it without doing so.`,
  );
  return `\n\n<clawchat_attachments>\n${lines.join("\n")}\n</clawchat_attachments>`;
}
