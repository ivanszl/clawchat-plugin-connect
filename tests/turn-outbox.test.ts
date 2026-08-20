import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSubmissionCapability } from "../src/client-contract";
import { ClientRequestError } from "../src/client-interface/client-http";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { TurnOutbox, type TurnOutboxStaging } from "../src/client-interface/turn-outbox";
import { defaultConfig } from "../src/config";
import { type ConnectStateStore, createStateStore } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";

const capability: TurnSubmissionCapability = {
  prompt: { allowed: true, required: false, maxCharacters: 64_000 },
  attachments: {
    allowedKinds: ["image", "file", "audio", "video"],
    allowedMediaTypes: ["*/*"],
    maxCount: 10,
    maxBytesEach: 100 * 1024 * 1024,
    maxBytesTotal: 100 * 1024 * 1024,
  },
};

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("Turn Outbox", () => {
  test("projects a failed optimistic message and retries the same durable submission", async () => {
    const fixture = await createFixture();
    let attempts = 0;
    const outbox = new TurnOutbox({
      stateStore: fixture.store,
      staging: fixture.staging,
      transcriptProjection: fixture.projection,
      capabilityFor: async () => capability,
      deliver: async (record) => {
        attempts += 1;
        if (attempts === 1) throw new ClientRequestError(503, "runtime-offline", "Runtime is unavailable", true);
        return { turnId: record.submissionId, sessionRef: record.sessionRef };
      },
    });

    const submitted = await outbox.submit({
      submissionId: "submission_retry",
      sessionRef: fixture.sessionRef,
      prompt: "send this once",
      selection: null,
      attachments: [],
    });
    expect(submitted).toMatchObject({ state: "pending", turnId: null });

    await waitFor(async () => (await fixture.store.getTurnOutbox("submission_retry"))?.state === "failed");
    const failed = await fixture.store.getTranscriptBlock(fixture.sessionRef, submitted.messageId);
    expect(failed).toMatchObject({
      type: "message",
      state: "error",
      delivery: {
        submissionId: "submission_retry",
        state: "failed",
        error: { code: "runtime-offline", retryable: true },
        allowedActions: ["retry", "discard"],
      },
    });

    await expect(outbox.retry(fixture.sessionRef, "submission_retry")).resolves.toMatchObject({ state: "pending" });
    await waitFor(async () => (await fixture.store.getTurnOutbox("submission_retry"))?.state === "accepted");
    expect(attempts).toBe(2);
    const acceptedMessage = await fixture.store.getTranscriptBlock(fixture.sessionRef, submitted.messageId);
    expect(acceptedMessage).toMatchObject({ state: "complete" });
    expect(acceptedMessage && "delivery" in acceptedMessage).toBe(false);

    await fixture.store.close();
  });

  test("turns an interrupted delivery into a retryable message after restart", async () => {
    const fixture = await createFixture();
    const staged = await fixture.staging.stage({
      submissionId: "submission_restart",
      sessionRef: fixture.sessionRef,
      prompt: "survive restart",
      selection: null,
      attachments: [],
    });
    staged.transfer();
    await fixture.store.createTurnOutbox({
      submissionId: "submission_restart",
      sessionRef: fixture.sessionRef,
      messageId: "turn_submission_restart_user",
      digest: staged.digest,
      prompt: "survive restart",
      selection: null,
      stagingRef: staged.reference,
    });
    await expect(fixture.store.claimNextTurnOutbox()).resolves.toMatchObject({ state: "delivering" });
    await fixture.store.close();

    const restartedStore = createStateStore({ dbPath: fixture.dbPath });
    const restartedProjection = projection(restartedStore);
    const restarted = new TurnOutbox({
      stateStore: restartedStore,
      staging: fixture.staging,
      transcriptProjection: restartedProjection,
      capabilityFor: async () => capability,
      deliver: async () => {
        throw new Error("interrupted work must not be dispatched automatically");
      },
    });
    await restarted.start();

    await expect(restartedStore.getTurnOutbox("submission_restart")).resolves.toMatchObject({
      state: "failed",
      error: { code: "submission-outcome-unknown", retryable: true },
    });
    await expect(
      restartedStore.getTranscriptBlock(fixture.sessionRef, "turn_submission_restart_user"),
    ).resolves.toMatchObject({
      type: "message",
      state: "error",
      delivery: {
        state: "failed",
        allowedActions: ["retry", "discard"],
      },
    });

    await restartedStore.close();
  });
});

async function createFixture(): Promise<{
  dbPath: string;
  sessionRef: string;
  store: ConnectStateStore;
  projection: TranscriptProjection;
  staging: MemoryTurnOutboxStaging;
}> {
  const directory = await mkdtemp(join(tmpdir(), "connect-turn-outbox-"));
  cleanup.push(directory);
  const dbPath = join(directory, "state.sqlite");
  const store = createStateStore({ dbPath });
  await store.upsertRuntimeSession({
    chatId: "outbox-chat",
    sessionId: "outbox-session",
    agentId: "codex",
    runtimeSessionId: null,
    name: "Outbox Session",
    hasMessages: true,
    isCurrent: true,
  });
  const session = await store.getCurrentRuntimeSession("outbox-chat", "codex");
  if (!session) throw new Error("Outbox test Session was not created");
  return {
    dbPath,
    sessionRef: session.sessionRef,
    store,
    projection: projection(store),
    staging: new MemoryTurnOutboxStaging(),
  };
}

function projection(store: ConnectStateStore): TranscriptProjection {
  return new TranscriptProjection({
    stateStore: store,
    config: defaultConfig(),
    runtimeAdapters: new RuntimeAdapterRegistry([]),
  });
}

class MemoryTurnOutboxStaging implements TurnOutboxStaging {
  private readonly references = new Set<string>();

  async stage(draft: Parameters<TurnOutboxStaging["stage"]>[0]) {
    const reference = `staged_${draft.submissionId}`;
    this.references.add(reference);
    return {
      reference,
      digest: `digest_${draft.sessionRef}_${draft.prompt}`,
      rollback: async () => {
        this.references.delete(reference);
      },
      transfer: () => undefined,
    };
  }

  async mediaForReference(reference: string) {
    if (!this.references.has(reference)) throw new Error(`Missing staged reference ${reference}`);
    return [];
  }

  async remove(reference: string): Promise<void> {
    this.references.delete(reference);
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for Turn Outbox state");
}
