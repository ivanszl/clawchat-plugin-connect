import { describe, expect, it, mock } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ClientViewEvent, TranscriptPageView } from "../src/client-contract";
import { pollClientEventBatch } from "../web/src/client-interface/client-events";
import {
  catalogQueryOptions,
  clientKeys,
  sessionQueryOptions,
  transcriptQueryOptions,
} from "../web/src/client-interface/query-options";

describe("Connect Client event fallback", () => {
  it("polls only persisted Client events without repeatedly querying Runtime-backed views", async () => {
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
});
