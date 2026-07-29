import { describe, expect, test } from "bun:test";
import type { SessionCatalogView, TranscriptPageView } from "../src/client-contract";
import { ClientViewContinuity } from "../src/client-interface/client-view-continuity";

function catalog(revision: number, name: string): SessionCatalogView {
  return {
    revision,
    bindings: [
      {
        bindingId: "codex",
        displayName: "Codex",
        kind: "codex",
        status: "connected",
        entries: [
          {
            sessionRef: "NKEP79B8",
            entryKind: "session",
            bindingId: "codex",
            bindingKind: "codex",
            projectId: null,
            projectName: null,
            workspaceId: null,
            workspaceName: null,
            name,
            isArchived: false,
            status: "idle",
            updatedAt: "2026-07-29T00:00:00.000Z",
            isCurrent: true,
            isAdopted: true,
            unreadCount: 0,
            pendingInteractionCount: 0,
            allowedActions: ["open", "send"],
          },
        ],
      },
    ],
  };
}

describe("ClientViewContinuity", () => {
  test("installs a watermarked snapshot and ignores an older catalog event", async () => {
    const continuity = new ClientViewContinuity();

    await continuity.install({
      watermark: 8,
      catalog: catalog(3, "Current"),
    });
    await continuity.receive({
      type: "catalog.changed",
      cursor: 7,
      previousCursor: 6,
      revision: 2,
      catalog: catalog(2, "Old"),
    });

    expect(continuity.current()).toMatchObject({
      cursor: 8,
      status: "current",
      catalog: { revision: 3 },
    });
    expect(continuity.current().catalog?.bindings[0]?.entries[0]?.name).toBe("Current");
  });

  test("commits a continuous event only after its newer catalog view is merged", async () => {
    const continuity = new ClientViewContinuity();
    await continuity.install({ watermark: 8, catalog: catalog(3, "Before") });

    await continuity.receive({
      type: "catalog.changed",
      cursor: 11,
      previousCursor: 8,
      revision: 4,
      catalog: catalog(4, "After"),
    });

    expect(continuity.current().cursor).toBe(11);
    expect(continuity.current().catalog?.bindings[0]?.entries[0]?.name).toBe("After");
  });

  test("buffers an out-of-order event and drains it when confirmed coverage arrives", async () => {
    const continuity = new ClientViewContinuity();
    await continuity.install({ watermark: 8, catalog: catalog(3, "Initial") });

    await continuity.receive({
      type: "catalog.changed",
      cursor: 14,
      previousCursor: 11,
      revision: 5,
      catalog: catalog(5, "Latest"),
    });
    expect(continuity.current()).toMatchObject({ cursor: 8, status: "recovering" });

    await continuity.receive({
      type: "catalog.changed",
      cursor: 11,
      previousCursor: 8,
      revision: 4,
      catalog: catalog(4, "Middle"),
    });

    expect(continuity.current()).toMatchObject({ cursor: 14, status: "current" });
    expect(continuity.current().catalog?.bindings[0]?.entries[0]?.name).toBe("Latest");
  });

  test("keeps a transcript tombstone from being resurrected by an older block revision", async () => {
    const block = {
      id: "message-1",
      type: "message" as const,
      origin: "client" as const,
      state: "complete" as const,
      plainText: "hello",
      role: "user" as const,
      author: "You",
      markdown: "hello",
      revision: 1,
      sequence: 1,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    };
    const transcript: TranscriptPageView = {
      sessionRef: "NKEP79B8",
      blocks: [block],
      beforeCursor: null,
      hasOlder: false,
      completeness: "complete",
    };
    const continuity = new ClientViewContinuity();
    await continuity.install({ watermark: 8, transcripts: [transcript] });
    await continuity.receive({
      type: "transcript.block-removed",
      cursor: 9,
      previousCursor: 8,
      sessionRef: "NKEP79B8",
      revision: 2,
      blockId: block.id,
    });
    await continuity.receive({
      type: "transcript.block-upserted",
      cursor: 12,
      previousCursor: 9,
      sessionRef: "NKEP79B8",
      revision: 1,
      block,
    });

    expect(continuity.current().cursor).toBe(12);
    expect(continuity.current().transcripts.get("NKEP79B8")?.blocks).toEqual([]);
  });

  test("does not advance the committed cursor on an equal-revision protocol conflict", async () => {
    const continuity = new ClientViewContinuity();
    await continuity.install({ watermark: 8, catalog: catalog(3, "Trusted") });

    await continuity.receive({
      type: "catalog.changed",
      cursor: 9,
      previousCursor: 8,
      revision: 3,
      catalog: catalog(3, "Conflicting"),
    });

    expect(continuity.current()).toMatchObject({ cursor: 8, status: "recovering" });
    expect(continuity.current().catalog?.bindings[0]?.entries[0]?.name).toBe("Trusted");
  });

  test("a newer complete snapshot replaces blocks absent from the latest Client Transcript", async () => {
    const staleBlock = {
      id: "streaming-message",
      type: "message" as const,
      origin: "runtime" as const,
      state: "streaming" as const,
      plainText: "partial",
      role: "assistant" as const,
      author: "Agent",
      markdown: "partial",
      revision: 1,
      sequence: 1,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    };
    const continuity = new ClientViewContinuity();
    await continuity.install({
      watermark: 8,
      transcripts: [
        {
          sessionRef: "NKEP79B8",
          blocks: [staleBlock],
          beforeCursor: null,
          hasOlder: false,
          completeness: "live-only",
        },
      ],
    });

    await continuity.install({
      watermark: 12,
      transcripts: [
        {
          sessionRef: "NKEP79B8",
          blocks: [],
          beforeCursor: null,
          hasOlder: false,
          completeness: "complete",
        },
      ],
    });

    expect(continuity.current().cursor).toBe(12);
    expect(continuity.current().transcripts.get("NKEP79B8")?.blocks).toEqual([]);
  });
});
