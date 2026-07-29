import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  ClientEventBatchView,
  ClientViewEvent,
  SessionCatalogView,
  SessionView,
  TranscriptPageView,
} from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import {
  ClientViewContinuity,
  type ClientViewSnapshot,
  type DeliveredClientViewEvent,
} from "../../../src/client-interface/client-view-continuity";
import { clientFetch, clientFetchSnapshot } from "./http";
import { clientKeys } from "./query-options";

const continuities = new WeakMap<QueryClient, ClientViewContinuity>();
const recoveries = new WeakMap<QueryClient, Promise<void>>();

export function connectClientEvents(queryClient: QueryClient, cursor: number): () => void {
  const continuity = continuityFor(queryClient);
  void continuity.install({ watermark: cursor });
  let polling = false;
  const events = new EventSource(`${CLIENT_API_PREFIX}/events?after=${continuity.current().cursor}`);
  const handle = (message: MessageEvent<string>) => {
    let event: ClientViewEvent;
    try {
      event = JSON.parse(message.data) as ClientViewEvent;
    } catch {
      return;
    }
    void applyClientEvent(queryClient, event);
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
      await pollClientEventBatch(queryClient, continuity.current().cursor);
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

export function mergeClientViewSnapshot(queryClient: QueryClient, snapshot: ClientViewSnapshot): void {
  const continuity = continuityFor(queryClient);
  continuity.merge(snapshot);
  syncContinuityState(queryClient, continuity, true);
}

export async function pollClientEventBatch(
  queryClient: QueryClient,
  cursor: number,
  fetchBatch: (after: number) => Promise<ClientEventBatchView> = fetchClientEventBatch,
): Promise<number> {
  await continuityFor(queryClient).install({ watermark: cursor });
  const batch = await fetchBatch(cursor);
  for (const event of batch.events) await applyClientEvent(queryClient, event);
  return continuityFor(queryClient).current().cursor;
}

async function fetchClientEventBatch(after: number): Promise<ClientEventBatchView> {
  return await clientFetch<ClientEventBatchView>(`${CLIENT_API_PREFIX}/events/batch?after=${after}`);
}

export async function applyClientEvent(queryClient: QueryClient, event: ClientViewEvent): Promise<void> {
  const continuity = continuityFor(queryClient);
  if (!Number.isSafeInteger(event.previousCursor) || (event.previousCursor ?? -1) < 0) {
    await recoverClientViews(queryClient).catch(() => undefined);
    return;
  }
  const committed = await continuity.receive(event as DeliveredClientViewEvent);
  syncContinuityState(queryClient, continuity, false);
  for (const changed of committed) mergeTranscriptEvent(queryClient, changed);
  if (continuity.current().status === "recovering") {
    await recoverClientViews(queryClient).catch(() => undefined);
  }
}

function continuityFor(queryClient: QueryClient): ClientViewContinuity {
  let continuity = continuities.get(queryClient);
  if (!continuity) {
    continuity = new ClientViewContinuity();
    const catalog = queryClient.getQueryData<SessionCatalogView>(clientKeys.catalog);
    const sessions = queryClient
      .getQueriesData<SessionView>({ queryKey: ["client", "session"] })
      .flatMap(([, session]) => (session ? [session] : []));
    const transcripts = queryClient
      .getQueriesData<InfiniteData<TranscriptPageView, string | null>>({ queryKey: ["client", "transcript"] })
      .flatMap(([, transcript]) => (transcript?.pages[0] ? [transcript.pages[0]] : []));
    void continuity.install({
      watermark: 0,
      ...(catalog ? { catalog } : {}),
      sessions,
      transcripts,
    });
    continuities.set(queryClient, continuity);
  }
  return continuity;
}

function syncContinuityState(
  queryClient: QueryClient,
  continuity: ClientViewContinuity,
  installTranscripts: boolean,
): void {
  const state = continuity.current();
  if (state.catalog) queryClient.setQueryData<SessionCatalogView>(clientKeys.catalog, state.catalog);
  for (const [sessionRef, session] of state.sessions) {
    queryClient.setQueryData<SessionView>(clientKeys.session(sessionRef), session);
  }
  if (!installTranscripts) return;
  for (const [sessionRef, transcript] of state.transcripts) {
    queryClient.setQueryData<InfiniteData<TranscriptPageView, string | null>>(
      clientKeys.transcript(sessionRef),
      (current) => {
        if (!current) return current;
        const pages = [...current.pages];
        pages[0] = transcript;
        return { ...current, pages };
      },
    );
  }
}

function mergeTranscriptEvent(queryClient: QueryClient, event: DeliveredClientViewEvent): void {
  if (event.type !== "transcript.block-upserted" && event.type !== "transcript.block-removed") return;
  queryClient.setQueryData<InfiniteData<TranscriptPageView, string | null>>(
    clientKeys.transcript(event.sessionRef),
    (current) => {
      if (!current) return current;
      if (event.type === "transcript.block-removed") {
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            blocks: page.blocks.filter((block) => block.id !== event.blockId || block.revision > event.revision),
          })),
        };
      }
      let found = false;
      const pages = current.pages.map((page) => {
        const existing = page.blocks.find((block) => block.id === event.block.id);
        if (!existing) return page;
        found = true;
        if (existing.revision >= event.block.revision) return page;
        return {
          ...page,
          blocks: page.blocks.map((block) => (block.id === event.block.id ? event.block : block)),
        };
      });
      if (!found && pages[0]) {
        pages[0] = {
          ...pages[0],
          blocks: [...pages[0].blocks, event.block].sort((left, right) => left.sequence - right.sequence),
        };
      }
      return { ...current, pages };
    },
  );
}

export async function recoverClientViews(
  queryClient: QueryClient,
  load: (client: QueryClient) => Promise<ClientViewSnapshot> = loadActiveClientViews,
): Promise<void> {
  const existing = recoveries.get(queryClient);
  if (existing) return await existing;
  const recovery = (async () => {
    const snapshot = await load(queryClient);
    const continuity = continuityFor(queryClient);
    const committed = await continuity.install(snapshot);
    syncContinuityState(queryClient, continuity, true);
    for (const event of committed) mergeTranscriptEvent(queryClient, event);
  })();
  recoveries.set(queryClient, recovery);
  try {
    await recovery;
  } finally {
    if (recoveries.get(queryClient) === recovery) recoveries.delete(queryClient);
  }
}

async function loadActiveClientViews(queryClient: QueryClient): Promise<ClientViewSnapshot> {
  const queries = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["client"] })
    .filter((query) => query.getObserversCount() > 0);
  const sessionRefs = new Set<string>();
  const transcriptRefs = new Set<string>();
  let catalogActive = false;
  for (const query of queries) {
    const [scope, kind, ref] = query.queryKey;
    if (scope !== "client") continue;
    if (kind === "session-catalog") catalogActive = true;
    if (kind === "session" && typeof ref === "string") sessionRefs.add(ref);
    if (kind === "transcript" && typeof ref === "string") transcriptRefs.add(ref);
  }
  const catalog = catalogActive
    ? clientFetchSnapshot<SessionCatalogView>(`${CLIENT_API_PREFIX}/session-catalog?refresh=1`)
    : Promise.resolve(null);
  const sessions = [...sessionRefs].map(
    async (sessionRef) =>
      await clientFetchSnapshot<SessionView>(
        `${CLIENT_API_PREFIX}/sessions/${encodeURIComponent(sessionRef)}?refresh=1`,
      ),
  );
  const transcripts = [...transcriptRefs].map(
    async (sessionRef) =>
      await clientFetchSnapshot<TranscriptPageView>(
        `${CLIENT_API_PREFIX}/sessions/${encodeURIComponent(sessionRef)}/transcript?limit=100`,
      ),
  );
  const [catalogSnapshot, sessionSnapshots, transcriptSnapshots] = await Promise.all([
    catalog,
    Promise.all(sessions),
    Promise.all(transcripts),
  ]);
  const snapshots = [...(catalogSnapshot ? [catalogSnapshot] : []), ...sessionSnapshots, ...transcriptSnapshots];
  if (snapshots.length === 0) {
    return { watermark: continuityFor(queryClient).current().cursor };
  }
  return {
    watermark: Math.min(...snapshots.map((snapshot) => snapshot.watermark)),
    ...(catalogSnapshot ? { catalog: catalogSnapshot.value } : {}),
    sessions: sessionSnapshots.map((snapshot) => snapshot.value),
    transcripts: transcriptSnapshots.map((snapshot) => snapshot.value),
  };
}
