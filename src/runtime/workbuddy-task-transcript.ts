import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkBuddyTaskTranscriptIdentity {
  transcriptIdentityMatches: boolean;
  replayFingerprint: string;
}

export interface WorkBuddyTaskTranscriptInspection {
  recordCount: number;
  latestCompletedAssistantModel: string | null;
  hasCompletedAssistantMarker: boolean;
}

export async function inspectInstalledWorkBuddyTaskTranscript(
  taskId: string,
  assistantMarker: string,
): Promise<WorkBuddyTaskTranscriptInspection> {
  return await inspectWorkBuddyTaskTranscript(join(homedir(), ".workbuddy-ai"), taskId, assistantMarker);
}

export async function inspectWorkBuddyTaskTranscript(
  configDirectory: string,
  taskId: string,
  assistantMarker: string,
): Promise<WorkBuddyTaskTranscriptInspection> {
  const transcript = await findTaskTranscript(configDirectory, taskId);
  if (!transcript) throw new Error(`Expected one native WorkBuddy transcript for Task ${taskId}`);
  const records = (await readFile(transcript, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((record) => parseRecord(record))
    .filter((record): record is Record<string, unknown> => record !== null);
  const completedAssistants = records.filter((record) => record.role === "assistant" && record.status === "completed");
  const latest = completedAssistants.at(-1);
  const providerData = latest?.providerData as Record<string, unknown> | undefined;
  return {
    recordCount: records.length,
    latestCompletedAssistantModel: typeof providerData?.model === "string" ? providerData.model : null,
    hasCompletedAssistantMarker: completedAssistants.some((record) =>
      JSON.stringify(record.content).includes(assistantMarker),
    ),
  };
}

export async function readWorkBuddyTaskTranscriptIdentity(
  configDirectory: string,
  taskId: string,
  workspace: string,
): Promise<WorkBuddyTaskTranscriptIdentity> {
  const transcript = await findTaskTranscript(configDirectory, taskId);
  if (!transcript) return mismatch();

  const canonicalWorkspace = await canonicalPathOrSelf(workspace);
  const messageIds: string[] = [];
  let observedTaskId = false;
  let observedWorkspace = false;
  try {
    const records = (await readFile(transcript, "utf8")).split("\n").filter(Boolean);
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

async function findTaskTranscript(configDirectory: string, taskId: string): Promise<string | null> {
  const projectsDirectory = join(configDirectory, "projects");
  const entries = await readdir(projectsDirectory, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDirectory, entry.name, `${taskId}.jsonl`);
    if (await exists(candidate)) candidates.push(candidate);
  }
  return candidates.length === 1 ? (candidates[0] as string) : null;
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
