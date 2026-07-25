import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  ClientEventBatchView,
  ClientViewEvent,
  SessionCatalogView,
  TranscriptPageView,
} from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import { clientFetch } from "./http";
import { clientKeys } from "./query-options";

export function connectClientEvents(queryClient: QueryClient, cursor: number): () => void {
  let currentCursor = cursor;
  let polling = false;
  const events = new EventSource(`${CLIENT_API_PREFIX}/events?after=${cursor}`);
  const handle = (message: MessageEvent<string>) => {
    let event: ClientViewEvent;
    try {
      event = JSON.parse(message.data) as ClientViewEvent;
    } catch {
      return;
    }
    currentCursor = Math.max(currentCursor, event.cursor);
    applyClientEvent(queryClient, event);
  };
  for (const type of [
    "catalog.changed",
    "session.changed",
    "transcript.block-upserted",
    "transcript.block-removed",
    "snapshot-required",
  ]) {
    events.addEventListener(type, handle as EventListener);
  }
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      currentCursor = await pollClientEventBatch(queryClient, currentCursor);
    } catch {
      // Liveware may temporarily reconnect its HTTP relay; the next poll retries.
    } finally {
      polling = false;
    }
  };
  void poll();
  const pollTimer = setInterval(() => void poll(), 2_000);
  return () => {
    clearInterval(pollTimer);
    events.close();
  };
}

export async function pollClientEventBatch(
  queryClient: QueryClient,
  cursor: number,
  fetchBatch: (after: number) => Promise<ClientEventBatchView> = fetchClientEventBatch,
): Promise<number> {
  const batch = await fetchBatch(cursor);
  for (const event of batch.events) applyClientEvent(queryClient, event);
  return Math.max(cursor, batch.cursor);
}

async function fetchClientEventBatch(after: number): Promise<ClientEventBatchView> {
  return await clientFetch<ClientEventBatchView>(`${CLIENT_API_PREFIX}/events/batch?after=${after}`);
}

export function applyClientEvent(queryClient: QueryClient, event: ClientViewEvent): void {
  if (event.type === "catalog.changed") {
    queryClient.setQueryData(clientKeys.catalog, event.catalog);
    return;
  }
  if (event.type === "session.changed") {
    queryClient.setQueryData(clientKeys.session(event.sessionRef), event.session);
    return;
  }
  if (event.type === "snapshot-required") {
    void queryClient.invalidateQueries({ queryKey: ["client"] });
    return;
  }
  queryClient.setQueryData<InfiniteData<TranscriptPageView, string | null>>(
    clientKeys.transcript(event.sessionRef),
    (current) => {
      if (!current) return current;
      if (event.type === "transcript.block-removed") {
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            blocks: page.blocks.filter((block) => block.id !== event.blockId),
          })),
        };
      }
      let replaced = false;
      const pages = current.pages.map((page) => ({
        ...page,
        blocks: page.blocks.map((block) => {
          if (block.id !== event.block.id) return block;
          replaced = true;
          return event.block;
        }),
      }));
      if (!replaced && pages[0]) {
        pages[0] = {
          ...pages[0],
          blocks: [...pages[0].blocks, event.block].sort((left, right) => left.sequence - right.sequence),
        };
      }
      return { ...current, pages };
    },
  );
  const catalog = queryClient.getQueryData<SessionCatalogView>(clientKeys.catalog);
  const knownSession = catalog?.bindings.some((binding) =>
    binding.entries.some((entry) => entry.sessionRef === event.sessionRef),
  );
  if (catalog && !knownSession) {
    void queryClient.invalidateQueries({ queryKey: clientKeys.catalog, refetchType: "active" });
  }
}
