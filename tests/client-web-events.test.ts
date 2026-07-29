import { describe, expect, it, mock } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ClientViewEvent, TranscriptPageView } from "../src/client-contract";
import { applyClientEvent, pollClientEventBatch, recoverClientViews } from "../web/src/client-interface/client-events";
import {
  catalogQueryOptions,
  clientKeys,
  sessionQueryOptions,
  transcriptQueryOptions,
} from "../web/src/client-interface/query-options";

describe("Connect Client event fallback", () => {
  it("polls persisted Client events without a parallel active-Session polling writer", async () => {
    expect(catalogQueryOptions.refetchInterval).toBeUndefined();
    expect(sessionQueryOptions("NKEP79B8").refetchInterval).toBeUndefined();
    expect(transcriptQueryOptions("NKEP79B8").refetchInterval).toBeUndefined();

    const queryClient = new QueryClient();
    queryClient.setQueryData(clientKeys.catalog, {
      revision: 1,
      bindings: [
        {
          bindingId: "codex",
          displayName: "codex",
          kind: "codex",
          status: "connected",
          entries: [{ sessionRef: "NKEP79B8" }],
        },
      ],
    });
    queryClient.setQueryData(clientKeys.session("NKEP79B8"), { sessionRef: "NKEP79B8" });
    queryClient.setQueryData(clientKeys.transcript("NKEP79B8"), {
      pageParams: [null],
      pages: [
        {
          sessionRef: "NKEP79B8",
          blocks: [],
          beforeCursor: null,
          hasOlder: false,
          completeness: "complete",
        } satisfies TranscriptPageView,
      ],
    });
    const event = {
      type: "transcript.block-upserted",
      cursor: 6,
      previousCursor: 5,
      sessionRef: "NKEP79B8",
      revision: 1,
      block: {
        id: "message-1",
        type: "message",
        origin: "clawchat",
        state: "complete",
        plainText: "hello",
        role: "user",
        author: "You",
        markdown: "hello",
        revision: 1,
        sequence: 1,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    } satisfies ClientViewEvent;
    const fetchBatch = mock(async () => ({ cursor: 6, events: [event] }));

    await expect(pollClientEventBatch(queryClient, 5, fetchBatch)).resolves.toBe(6);
    expect(fetchBatch).toHaveBeenCalledWith(5);
    expect(queryClient.getQueryState(clientKeys.session("NKEP79B8"))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(clientKeys.catalog)?.isInvalidated).toBe(false);
    expect(
      queryClient.getQueryData<{ pages: TranscriptPageView[] }>(clientKeys.transcript("NKEP79B8"))?.pages[0]?.blocks,
    ).toContainEqual(event.block);
  });

  it("merges a newer block revision into its loaded older Transcript page", async () => {
    const queryClient = new QueryClient();
    const olderBlock = {
      id: "message-old",
      type: "message" as const,
      origin: "runtime" as const,
      state: "streaming" as const,
      plainText: "partial",
      role: "assistant" as const,
      author: "Agent",
      markdown: "partial",
      revision: 1,
      sequence: 2,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    queryClient.setQueryData(clientKeys.transcript("NKEP79B8"), {
      pageParams: [null, "s:3"],
      pages: [
        {
          sessionRef: "NKEP79B8",
          blocks: [],
          beforeCursor: "s:3",
          hasOlder: true,
          completeness: "complete",
        },
        {
          sessionRef: "NKEP79B8",
          blocks: [olderBlock],
          beforeCursor: null,
          hasOlder: false,
          completeness: "complete",
        },
      ] satisfies TranscriptPageView[],
    });
    const completed = {
      ...olderBlock,
      state: "complete" as const,
      plainText: "complete",
      markdown: "complete",
      revision: 2,
    };

    await pollClientEventBatch(queryClient, 5, async () => ({
      cursor: 8,
      events: [
        {
          type: "transcript.block-upserted",
          cursor: 8,
          previousCursor: 5,
          sessionRef: "NKEP79B8",
          revision: 2,
          block: completed,
        },
      ],
    }));

    const pages = queryClient.getQueryData<{ pages: TranscriptPageView[] }>(clientKeys.transcript("NKEP79B8"))?.pages;
    expect(pages?.[0]?.blocks).toEqual([]);
    expect(pages?.[1]?.blocks).toEqual([completed]);
  });

  it("refreshes an active Transcript snapshot when its Session revision changes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(clientKeys.session("NKEP79B8"), { sessionRef: "NKEP79B8", revision: 1 });
    queryClient.setQueryData(clientKeys.transcript("NKEP79B8"), {
      pageParams: [null],
      pages: [],
    });

    await applyClientEvent(queryClient, {
      type: "session.changed",
      cursor: 2,
      previousCursor: 1,
      sessionRef: "NKEP79B8",
      revision: 2,
      session: { sessionRef: "NKEP79B8", revision: 2 },
    } as ClientViewEvent);

    expect(queryClient.getQueryState(clientKeys.transcript("NKEP79B8"))?.isInvalidated).toBe(true);
  });

  it("retains every visible view when an atomic recovery bundle cannot be loaded", async () => {
    const queryClient = new QueryClient();
    const visibleCatalog = { revision: 7, bindings: [] };
    const visibleSession = { sessionRef: "NKEP79B8", revision: 9 };
    queryClient.setQueryData(clientKeys.catalog, visibleCatalog);
    queryClient.setQueryData(clientKeys.session("NKEP79B8"), visibleSession);

    await expect(
      recoverClientViews(queryClient, async () => {
        throw new Error("transcript snapshot failed");
      }),
    ).rejects.toThrow("transcript snapshot failed");

    expect(queryClient.getQueryData<unknown>(clientKeys.catalog)).toEqual(visibleCatalog);
    expect(queryClient.getQueryData<unknown>(clientKeys.session("NKEP79B8"))).toEqual(visibleSession);
  });

  it("does not bypass an equal-revision conflict in a loaded older Transcript page", async () => {
    const queryClient = new QueryClient();
    const olderBlock = {
      id: "older-message",
      type: "message" as const,
      origin: "runtime" as const,
      state: "complete" as const,
      plainText: "trusted",
      role: "assistant" as const,
      author: "Agent",
      markdown: "trusted",
      revision: 4,
      sequence: 2,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    queryClient.setQueryData(clientKeys.transcript("NKEP79B8"), {
      pageParams: [null, "s:3"],
      pages: [
        {
          sessionRef: "NKEP79B8",
          blocks: [],
          beforeCursor: "s:3",
          hasOlder: true,
          completeness: "complete",
        },
        {
          sessionRef: "NKEP79B8",
          blocks: [olderBlock],
          beforeCursor: null,
          hasOlder: false,
          completeness: "complete",
        },
      ] satisfies TranscriptPageView[],
    });

    await expect(
      pollClientEventBatch(queryClient, 5, async () => ({
        cursor: 8,
        events: [
          {
            type: "transcript.block-upserted",
            cursor: 8,
            previousCursor: 5,
            sessionRef: "NKEP79B8",
            revision: 4,
            block: { ...olderBlock, plainText: "conflict", markdown: "conflict" },
          },
        ],
      })),
    ).resolves.toBe(5);
    expect(
      queryClient.getQueryData<{ pages: TranscriptPageView[] }>(clientKeys.transcript("NKEP79B8"))?.pages[1]?.blocks[0],
    ).toEqual(olderBlock);
  });
});
