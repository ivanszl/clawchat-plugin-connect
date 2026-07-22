import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { ClientViewEvent, TranscriptPageView } from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import { clientKeys } from "./query-options";

export function connectClientEvents(queryClient: QueryClient, cursor: number): () => void {
  const events = new EventSource(`${CLIENT_API_PREFIX}/events?after=${cursor}`);
  const handle = (message: MessageEvent<string>) => {
    let event: ClientViewEvent;
    try {
      event = JSON.parse(message.data) as ClientViewEvent;
    } catch {
      return;
    }
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
  return () => events.close();
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
  void queryClient.invalidateQueries({ queryKey: clientKeys.session(event.sessionRef), refetchType: "active" });
  void queryClient.invalidateQueries({ queryKey: clientKeys.catalog, refetchType: "active" });
}
