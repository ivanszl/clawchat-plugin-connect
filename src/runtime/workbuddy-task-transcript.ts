import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface WorkBuddyTaskTranscriptIdentity {
  transcriptIdentityMatches: boolean;
  replayFingerprint: string;
}

export async function readWorkBuddyTaskTranscriptIdentity(
  configDirectory: string,
  taskId: string,
  workspace: string,
): Promise<WorkBuddyTaskTranscriptIdentity> {
  const projectsDirectory = join(configDirectory, "projects");
  const entries = await readdir(projectsDirectory, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDirectory, entry.name, `${taskId}.jsonl`);
    if (await exists(candidate)) candidates.push(candidate);
  }
  if (candidates.length !== 1) return mismatch();

  const canonicalWorkspace = await canonicalPathOrSelf(workspace);
  const messageIds: string[] = [];
  let observedTaskId = false;
  let observedWorkspace = false;
  try {
    const records = (await readFile(candidates[0] as string, "utf8")).split("\n").filter(Boolean);
    for (const record of records) {
      const parsed = parseRecord(record);
      if (!parsed) return mismatch();
      if (parsed.sessionId !== undefined) {
        if (parsed.sessionId !== taskId) return mismatch();
        observedTaskId = true;
      }
      if (parsed.cwd !== undefined) {
        if (typeof parsed.cwd !== "string" || (await canonicalPathOrSelf(parsed.cwd)) !== canonicalWorkspace) {
          return mismatch();
        }
        observedWorkspace = true;
      }
      if (parsed.type === "message") {
        if (typeof parsed.id !== "string" || parsed.sessionId !== taskId || typeof parsed.cwd !== "string") {
          return mismatch();
        }
        if (!messageIds.includes(parsed.id)) messageIds.push(parsed.id);
      }
    }
  } catch {
    return mismatch();
  }
  return {
    transcriptIdentityMatches: observedTaskId && observedWorkspace,
    replayFingerprint: replayFingerprint(messageIds),
  };
}

function parseRecord(record: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(record);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

async function canonicalPathOrSelf(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

function replayFingerprint(messageIds: string[]): string {
  return createHash("sha256").update(JSON.stringify(messageIds)).digest("hex");
}

function mismatch(): WorkBuddyTaskTranscriptIdentity {
  return { transcriptIdentityMatches: false, replayFingerprint: replayFingerprint([]) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
