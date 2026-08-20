import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectWorkBuddyTaskTranscript,
  readWorkBuddyTaskTranscriptIdentity,
} from "../src/runtime/workbuddy-task-transcript";

const taskId = "00000000-0000-4000-8000-000000000001";
const workspace = "/private/tmp/workbuddy-transcript-workspace";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("WorkBuddy native Task transcript identity", () => {
  it("accepts identity-only records for an empty Task without reading message content", async () => {
    const configDirectory = await fixture([{ type: "ai-title", sessionId: taskId, cwd: workspace }]);
    await expect(readWorkBuddyTaskTranscriptIdentity(configDirectory, taskId, workspace)).resolves.toEqual({
      transcriptIdentityMatches: true,
      replayFingerprint: fingerprint([]),
    });
  });

  it("fingerprints ordered, deduplicated user and assistant identities only", async () => {
    const configDirectory = await fixture([
      { type: "message", id: "message-1", role: "user", sessionId: taskId, cwd: workspace, content: "same" },
      { type: "message", id: "tool-only", role: "tool", sessionId: taskId, cwd: workspace, content: "same" },
      { type: "message", id: "message-1", role: "user", sessionId: taskId, cwd: workspace, content: "same" },
      {
        type: "message",
        id: "message-2",
        role: "assistant",
        sessionId: taskId,
        cwd: workspace,
        content: "same",
      },
      {
        type: "message",
        id: "message-2",
        role: "assistant",
        sessionId: taskId,
        cwd: workspace,
        content: "same",
      },
    ]);
    await expect(readWorkBuddyTaskTranscriptIdentity(configDirectory, taskId, workspace)).resolves.toEqual({
      transcriptIdentityMatches: true,
      replayFingerprint: fingerprint(["message-1", "message-2"]),
    });
  });

  it("uses mainland provider message identity for assistant replay parity", async () => {
    const configDirectory = await fixture([
      { type: "message", id: "user-record", role: "user", sessionId: taskId, cwd: workspace },
      { type: "message", id: "tool-record", role: "tool", sessionId: taskId, cwd: workspace },
      {
        type: "message",
        id: "gen-record",
        role: "assistant",
        sessionId: taskId,
        cwd: workspace,
        providerData: { messageId: "provider-message" },
      },
      {
        type: "message",
        id: "duplicate-gen-record",
        role: "assistant",
        sessionId: taskId,
        cwd: workspace,
        providerData: { messageId: "provider-message" },
      },
    ]);
    await expect(
      readWorkBuddyTaskTranscriptIdentity(configDirectory, taskId, workspace, "workbuddy-cn"),
    ).resolves.toEqual({
      transcriptIdentityMatches: true,
      replayFingerprint: fingerprint(["user-record", "provider-message"]),
    });
  });

  it.each([
    { name: "a missing transcript", records: null },
    { name: "an empty transcript", records: [] },
    { name: "identity-free records", records: [{}] },
    { name: "a mismatched Task", records: [{ sessionId: "another-task", cwd: workspace }] },
    { name: "a mismatched workspace", records: [{ sessionId: taskId, cwd: "/private/tmp/another-workspace" }] },
    {
      name: "a user message missing its identity",
      records: [
        { type: "ai-title", sessionId: taskId, cwd: workspace },
        { type: "message", role: "user", sessionId: taskId, cwd: workspace },
      ],
    },
    {
      name: "a mainland assistant missing its provider identity",
      profile: "workbuddy-cn" as const,
      records: [{ type: "message", id: "assistant-record", role: "assistant", sessionId: taskId, cwd: workspace }],
    },
  ])("fails closed for $name", async ({ records, profile }) => {
    const configDirectory = await fixture(records);
    await expect(
      readWorkBuddyTaskTranscriptIdentity(configDirectory, taskId, workspace, profile),
    ).resolves.toMatchObject({
      transcriptIdentityMatches: false,
    });
  });
});

describe("WorkBuddy native Task transcript inspection", () => {
  it("summarizes native persistence without exposing record layout to callers", async () => {
    const configDirectory = await fixture([
      { role: "assistant", status: "completed", content: "prior answer", providerData: { model: "fast-model" } },
      { role: "user", status: "completed", content: "turn-marker" },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text: "turn-marker answer" }],
        providerData: { model: "fast-model" },
      },
    ]);

    await expect(inspectWorkBuddyTaskTranscript(configDirectory, taskId, "turn-marker")).resolves.toEqual({
      recordCount: 3,
      latestCompletedAssistantModel: "fast-model",
      hasCompletedAssistantMarker: true,
    });
  });
});

async function fixture(records: ReadonlyArray<Record<string, unknown>> | null): Promise<string> {
  const configDirectory = await mkdtemp(join(tmpdir(), "workbuddy-transcript-test-"));
  temporaryDirectories.push(configDirectory);
  if (records === null) return configDirectory;
  const projectDirectory = join(configDirectory, "projects", "fixture-workspace");
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    join(projectDirectory, `${taskId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  return configDirectory;
}

function fingerprint(messageIds: string[]): string {
  return createHash("sha256").update(JSON.stringify(messageIds)).digest("hex");
}
