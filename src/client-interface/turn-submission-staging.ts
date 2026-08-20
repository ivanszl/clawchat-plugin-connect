import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConnectRuntimeMedia } from "../runtime/types";
import {
  attachmentKind,
  type StagedTurnSubmission,
  type TurnSubmissionDraft,
  TurnSubmissionError,
  type TurnSubmissionStaging,
} from "./turn-submission";

const STAGING_TTL_MS = 24 * 60 * 60 * 1_000;

interface StagedAttachmentManifest {
  submissionId: string | null;
  sessionRef: string | null;
  attachments: Array<{ file: string; name: string; mime: string; size: number }>;
}

export interface StagedTurnSubmissionAttachment {
  sessionRef: string | null;
  path: string;
  name: string;
  mime: string;
  size: number;
}

export class FileTurnSubmissionStaging implements TurnSubmissionStaging {
  readonly root: string;
  private readonly stagedMedia = new WeakMap<StagedTurnSubmission, ConnectRuntimeMedia[]>();

  constructor(stateDbPath: string) {
    this.root = join(dirname(stateDbPath), "turn-submissions");
  }

  async stage(draft: TurnSubmissionDraft, signal?: AbortSignal): Promise<StagedTurnSubmission> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const reference = `${safeIdentity(draft.submissionId)}-${randomUUID()}`;
    const directory = join(this.root, reference);
    await mkdir(directory, { mode: 0o700 });
    let transferred = false;
    const digest = createHash("sha256");
    digest.update(draft.sessionRef);
    digest.update("\0");
    digest.update(draft.prompt);
    if (draft.selection) {
      digest.update(`\0${draft.selection.kind}\0`);
      digest.update(draft.selection.id);
      digest.update("\0");
      digest.update(draft.selection.name);
    }
    try {
      const media: ConnectRuntimeMedia[] = [];
      const manifest: StagedAttachmentManifest = {
        submissionId: draft.submissionId,
        sessionRef: draft.sessionRef,
        attachments: [],
      };
      for (const [index, attachment] of draft.attachments.entries()) {
        signal?.throwIfAborted();
        const kind = attachmentKind(attachment.mime);
        if (!kind) throw new TurnSubmissionError("attachment-unsupported", `${attachment.name} has no media type`);
        const path = join(directory, `${index}-${randomUUID()}`);
        const bytes = await attachment.readBytes();
        digest.update("\0");
        digest.update(attachment.name);
        digest.update("\0");
        digest.update(attachment.mime);
        digest.update("\0");
        digest.update(String(attachment.size));
        digest.update(bytes);
        await Bun.write(path, bytes);
        const actual = (await stat(path)).size;
        if (actual !== attachment.size) {
          throw new TurnSubmissionError(
            "attachment-size-mismatch",
            `${attachment.name} size did not match the staged bytes`,
          );
        }
        manifest.attachments.push({
          file: path.split("/").at(-1) ?? "",
          name: attachment.name,
          mime: attachment.mime,
          size: actual,
        });
        media.push({
          kind,
          url: `/client/v1/turn-submissions/${encodeURIComponent(draft.submissionId)}/attachments/${index}`,
          stagedPath: path,
          name: attachment.name,
          mime: attachment.mime,
          size: actual,
        });
      }
      await Bun.write(join(directory, "manifest.json"), JSON.stringify(manifest));
      const staged: StagedTurnSubmission = {
        reference,
        digest: digest.digest("hex"),
        transfer() {
          transferred = true;
        },
        async rollback() {
          if (!transferred) await rm(directory, { recursive: true, force: true });
        },
      };
      this.stagedMedia.set(staged, media);
      return staged;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  mediaFor(staged: StagedTurnSubmission): ConnectRuntimeMedia[] {
    const media = this.stagedMedia.get(staged);
    if (!media) throw new Error("Turn Submission staging handle is invalid");
    return media;
  }
  async mediaForReference(reference: string): Promise<ConnectRuntimeMedia[]> {
    const directory = this.directory(reference);
    const manifest = await readManifest(join(directory, "manifest.json"));
    if (!manifest?.submissionId) throw new Error("Turn Submission staging manifest is invalid");
    const media: ConnectRuntimeMedia[] = [];
    for (const [index, attachment] of manifest.attachments.entries()) {
      const kind = attachmentKind(attachment.mime);
      if (!kind || !attachment.file || attachment.file.includes("/") || attachment.file.includes("\\")) {
        throw new Error("Turn Submission staged attachment is invalid");
      }
      const path = join(directory, attachment.file);
      const details = await stat(path);
      if (!details.isFile() || details.size !== attachment.size) {
        throw new Error("Turn Submission staged attachment size changed");
      }
      media.push({
        kind,
        url: `/client/v1/turn-submissions/${encodeURIComponent(manifest.submissionId)}/attachments/${index}`,
        stagedPath: path,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
      });
    }
    return media;
  }

  async remove(reference: string): Promise<void> {
    await rm(this.directory(reference), { recursive: true, force: true });
  }

  async attachment(submissionId: string, index: number): Promise<StagedTurnSubmissionAttachment | null> {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const prefix = `${safeIdentity(submissionId)}-`;
    const directories = (await readdir(this.root, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name);
    for (const entry of directories) {
      const directory = join(this.root, entry);
      const manifest = await readManifest(join(directory, "manifest.json"));
      const attachment = manifest?.attachments[index];
      if (attachment?.file && !attachment.file.includes("/") && !attachment.file.includes("\\")) {
        const path = join(directory, attachment.file);
        const details = await stat(path).catch(() => null);
        if (details?.isFile() && details.size === attachment.size) {
          return {
            sessionRef: manifest?.sessionRef ?? null,
            path,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
          };
        }
      }
      const legacyFile = (await readdir(directory, { withFileTypes: true }).catch(() => [])).find(
        (candidate) => candidate.isFile() && candidate.name.startsWith(`${index}-`),
      );
      if (!legacyFile) continue;
      const path = join(directory, legacyFile.name);
      const details = await stat(path);
      return {
        sessionRef: manifest?.sessionRef ?? null,
        path,
        name: `attachment-${index}`,
        mime: await detectMediaType(path),
        size: details.size,
      };
    }
    return null;
  }

  async cleanupExpired(now = Date.now(), preserved: ReadonlySet<string> = new Set()): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || preserved.has(entry.name)) return;
        const path = join(this.root, entry.name);
        const details = await stat(path).catch(() => null);
        if (details && now - details.mtimeMs >= STAGING_TTL_MS) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
        }
      }),
    );
  }

  async purgeSessions(sessionRefs: Iterable<string>): Promise<void> {
    const owned = new Set(sessionRefs);
    if (owned.size === 0) return;
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const directory = join(this.root, entry.name);
        const manifest = await readManifest(join(directory, "manifest.json"));
        if (manifest?.sessionRef && owned.has(manifest.sessionRef)) {
          await rm(directory, { recursive: true, force: true });
        }
      }),
    );
  }

  private directory(reference: string): string {
    if (!reference || reference.includes("/") || reference.includes("\\") || reference === "." || reference === "..") {
      throw new Error("Turn Submission staging reference is invalid");
    }
    return join(this.root, reference);
  }
}

async function readManifest(path: string): Promise<StagedAttachmentManifest | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<StagedAttachmentManifest>;
    return Array.isArray(value.attachments)
      ? {
          submissionId: typeof value.submissionId === "string" ? value.submissionId : null,
          sessionRef: typeof value.sessionRef === "string" ? value.sessionRef : null,
          attachments: value.attachments,
        }
      : null;
  } catch {
    return null;
  }
}

async function detectMediaType(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).slice(0, 16).arrayBuffer());
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")) return "image/gif";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return "application/octet-stream";
}

function safeIdentity(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "submission";
}
