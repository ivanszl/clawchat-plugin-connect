import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
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

export class FileTurnSubmissionStaging implements TurnSubmissionStaging {
  readonly root: string;

  constructor(stateDbPath: string) {
    this.root = join(dirname(stateDbPath), "turn-submissions");
  }

  async stage(draft: TurnSubmissionDraft, signal?: AbortSignal): Promise<StagedTurnSubmission> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = join(this.root, `${safeIdentity(draft.submissionId)}-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    let transferred = false;
    try {
      const media: ConnectRuntimeMedia[] = [];
      for (const [index, attachment] of draft.attachments.entries()) {
        signal?.throwIfAborted();
        const kind = attachmentKind(attachment.mime);
        if (!kind) throw new TurnSubmissionError("attachment-unsupported", `${attachment.name} has no media type`);
        const path = join(directory, `${index}-${randomUUID()}`);
        await Bun.write(path, attachment.bytes);
        const actual = (await stat(path)).size;
        if (actual !== attachment.size) {
          throw new TurnSubmissionError(
            "attachment-size-mismatch",
            `${attachment.name} size did not match the staged bytes`,
          );
        }
        media.push({
          kind,
          url: `/client/v1/turn-submissions/${encodeURIComponent(draft.submissionId)}/attachments/${index}`,
          stagedPath: path,
          name: attachment.name,
          mime: attachment.mime,
          size: actual,
        });
      }
      return {
        media,
        transfer() {
          transferred = true;
        },
        async rollback() {
          if (!transferred) await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const path = join(this.root, entry.name);
        const details = await stat(path).catch(() => null);
        if (details && now - details.mtimeMs >= STAGING_TTL_MS) {
          await rm(path, { recursive: true, force: true });
        }
      }),
    );
  }
}

function safeIdentity(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "submission";
}
