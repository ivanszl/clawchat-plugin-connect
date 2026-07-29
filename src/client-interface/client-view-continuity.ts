import type {
  ClientViewEvent,
  SessionCatalogView,
  SessionView,
  TranscriptBlock,
  TranscriptPageView,
} from "../client-contract";

export type DeliveredClientViewEvent = ClientViewEvent & { previousCursor: number };

export interface ClientViewSnapshot {
  watermark: number;
  catalog?: SessionCatalogView;
  sessions?: SessionView[];
  transcripts?: TranscriptPageView[];
}

export interface ClientViewContinuityState {
  cursor: number;
  status: "current" | "recovering" | "offline";
  catalog: SessionCatalogView | null;
  sessions: ReadonlyMap<string, SessionView>;
  transcripts: ReadonlyMap<string, TranscriptPageView>;
}

export class ClientViewContinuity {
  private readonly buffered = new Map<number, DeliveredClientViewEvent>();
  private readonly tombstones = new Map<string, Map<string, number>>();
  private readonly observedTranscriptBlocks = new Map<string, Map<string, TranscriptBlock>>();
  private state: ClientViewContinuityState = {
    cursor: 0,
    status: "offline",
    catalog: null,
    sessions: new Map(),
    transcripts: new Map(),
  };

  current(): ClientViewContinuityState {
    return this.state;
  }

  async install(snapshot: ClientViewSnapshot): Promise<readonly DeliveredClientViewEvent[]> {
    const replacesTranscript = snapshot.watermark >= this.state.cursor;
    const cursor = Math.max(snapshot.watermark, this.state.cursor);
    this.state = {
      cursor,
      status: "current",
      catalog: newerView(this.state.catalog, snapshot.catalog),
      sessions: mergeSessions(this.state.sessions, snapshot.sessions),
      transcripts: mergeTranscripts(this.state.transcripts, snapshot.transcripts, this.tombstones, replacesTranscript),
    };
    if (replacesTranscript) {
      for (const transcript of snapshot.transcripts ?? []) {
        this.tombstones.delete(transcript.sessionRef);
        this.observeTranscriptPage(transcript, !transcript.hasOlder);
      }
    } else {
      for (const transcript of snapshot.transcripts ?? []) this.observeTranscriptPage(transcript);
    }
    for (const cursor of this.buffered.keys()) {
      if (cursor <= snapshot.watermark) this.buffered.delete(cursor);
    }
    return this.drain();
  }

  merge(snapshot: Omit<ClientViewSnapshot, "watermark">): void {
    this.state = {
      ...this.state,
      catalog: newerView(this.state.catalog, snapshot.catalog),
      sessions: mergeSessions(this.state.sessions, snapshot.sessions),
      transcripts: mergeTranscripts(this.state.transcripts, snapshot.transcripts, this.tombstones, false),
    };
    for (const transcript of snapshot.transcripts ?? []) this.observeTranscriptPage(transcript);
  }

  observeTranscriptPage(transcript: TranscriptPageView, replace = false): void {
    const blocks = replace
      ? new Map<string, TranscriptBlock>()
      : (this.observedTranscriptBlocks.get(transcript.sessionRef) ?? new Map<string, TranscriptBlock>());
    for (const block of transcript.blocks) {
      const existing = blocks.get(block.id);
      if (!existing || block.revision > existing.revision) blocks.set(block.id, block);
    }
    this.observedTranscriptBlocks.set(transcript.sessionRef, blocks);
  }

  async receive(event: DeliveredClientViewEvent): Promise<readonly DeliveredClientViewEvent[]> {
    if (event.cursor <= this.state.cursor) return [];
    const duplicate = this.buffered.get(event.cursor);
    if (duplicate && !sameValue(duplicate, event)) {
      this.state = { ...this.state, status: "recovering" };
      return [];
    }
    this.buffered.set(event.cursor, event);
    return this.drain();
  }

  private drain(): DeliveredClientViewEvent[] {
    const changed: DeliveredClientViewEvent[] = [];
    while (true) {
      const ready = [...this.buffered.values()].filter((event) => event.previousCursor === this.state.cursor);
      if (ready.length !== 1) break;
      const event = ready[0];
      if (!event) break;
      const result = this.apply(event);
      if (result === "conflict") break;
      if (result === "changed") changed.push(event);
      this.buffered.delete(event.cursor);
    }
    this.state = {
      ...this.state,
      status: this.buffered.size === 0 ? "current" : "recovering",
    };
    return changed;
  }

  private apply(event: DeliveredClientViewEvent): "changed" | "unchanged" | "conflict" {
    if (event.type === "catalog.changed") {
      const current = this.state.catalog;
      if (current && event.catalog.revision < current.revision) {
        this.state = { ...this.state, cursor: event.cursor };
        return "unchanged";
      }
      if (current && event.catalog.revision === current.revision && !sameValue(current, event.catalog)) {
        this.state = { ...this.state, status: "recovering" };
        return "conflict";
      }
      this.state = {
        ...this.state,
        cursor: event.cursor,
        catalog: event.catalog,
      };
      return "changed";
    }
    if (event.type === "session.changed") {
      const current = this.state.sessions.get(event.sessionRef);
      if (current && event.session.revision === current.revision && !sameValue(current, event.session))
        return "conflict";
      const sessions = new Map(this.state.sessions);
      const changed = !current || event.session.revision > current.revision;
      if (changed) sessions.set(event.sessionRef, event.session);
      this.state = { ...this.state, cursor: event.cursor, sessions };
      return changed ? "changed" : "unchanged";
    }
    if (event.type === "snapshot-required") return "conflict";
    const transcript = this.state.transcripts.get(event.sessionRef);
    const tombstones = this.tombstones.get(event.sessionRef) ?? new Map<string, number>();
    this.tombstones.set(event.sessionRef, tombstones);
    if (event.type === "transcript.block-removed") {
      const currentTombstone = tombstones.get(event.blockId) ?? 0;
      if (event.revision > currentTombstone) tombstones.set(event.blockId, event.revision);
      const observed = this.observedTranscriptBlocks.get(event.sessionRef);
      const observedBlock = observed?.get(event.blockId);
      if (observedBlock && observedBlock.revision <= event.revision) observed?.delete(event.blockId);
      const transcripts = new Map(this.state.transcripts);
      if (transcript) {
        transcripts.set(event.sessionRef, {
          ...transcript,
          blocks: transcript.blocks.filter((block) => block.id !== event.blockId || block.revision > event.revision),
        });
      }
      this.state = { ...this.state, cursor: event.cursor, transcripts };
      return "changed";
    }
    const removedAt = tombstones.get(event.block.id);
    if (removedAt !== undefined && removedAt >= event.block.revision) {
      this.state = { ...this.state, cursor: event.cursor };
      return "unchanged";
    }
    const transcripts = new Map(this.state.transcripts);
    const observedExisting = this.observedTranscriptBlocks.get(event.sessionRef)?.get(event.block.id);
    if (
      observedExisting &&
      observedExisting.revision === event.block.revision &&
      !sameValue(observedExisting, event.block)
    ) {
      return "conflict";
    }
    if (transcript) {
      const existing = transcript.blocks.find((block) => block.id === event.block.id) ?? observedExisting;
      if (existing && existing.revision === event.block.revision && !sameValue(existing, event.block))
        return "conflict";
      const changed = !existing || event.block.revision > existing.revision;
      if (changed) {
        const observed = this.observedTranscriptBlocks.get(event.sessionRef) ?? new Map<string, TranscriptBlock>();
        observed.set(event.block.id, event.block);
        this.observedTranscriptBlocks.set(event.sessionRef, observed);
        transcripts.set(event.sessionRef, {
          ...transcript,
          blocks: [...transcript.blocks.filter((block) => block.id !== event.block.id), event.block].sort(
            (left, right) => left.sequence - right.sequence,
          ),
        });
      }
      this.state = { ...this.state, cursor: event.cursor, transcripts };
      return changed ? "changed" : "unchanged";
    }
    if (observedExisting && observedExisting.revision >= event.block.revision) {
      this.state = { ...this.state, cursor: event.cursor, transcripts };
      return "unchanged";
    }
    const observed = this.observedTranscriptBlocks.get(event.sessionRef) ?? new Map<string, TranscriptBlock>();
    observed.set(event.block.id, event.block);
    this.observedTranscriptBlocks.set(event.sessionRef, observed);
    this.state = { ...this.state, cursor: event.cursor, transcripts };
    return "changed";
  }
}

function newerView<T extends { revision: number }>(current: T | null, incoming: T | undefined): T | null {
  if (!incoming) return current;
  if (!current || incoming.revision > current.revision) return incoming;
  return current;
}

function mergeSessions(
  current: ReadonlyMap<string, SessionView>,
  incoming: SessionView[] | undefined,
): ReadonlyMap<string, SessionView> {
  if (!incoming) return current;
  const merged = new Map(current);
  for (const session of incoming) {
    const existing = merged.get(session.sessionRef);
    if (!existing || session.revision > existing.revision) merged.set(session.sessionRef, session);
  }
  return merged;
}

function mergeTranscripts(
  current: ReadonlyMap<string, TranscriptPageView>,
  incoming: TranscriptPageView[] | undefined,
  tombstones: ReadonlyMap<string, ReadonlyMap<string, number>>,
  replace: boolean,
): ReadonlyMap<string, TranscriptPageView> {
  if (!incoming) return current;
  const merged = new Map(current);
  for (const transcript of incoming) {
    const removed = tombstones.get(transcript.sessionRef);
    const visible = removed
      ? {
          ...transcript,
          blocks: transcript.blocks.filter((block) => (removed.get(block.id) ?? 0) < block.revision),
        }
      : transcript;
    const existing = merged.get(transcript.sessionRef);
    merged.set(transcript.sessionRef, existing && !replace ? mergeTranscript(existing, visible) : visible);
  }
  return merged;
}

function mergeTranscript(current: TranscriptPageView, incoming: TranscriptPageView): TranscriptPageView {
  const blocks = new Map<string, TranscriptBlock>(current.blocks.map((block) => [block.id, block]));
  for (const block of incoming.blocks) {
    const existing = blocks.get(block.id);
    if (!existing || block.revision > existing.revision) blocks.set(block.id, block);
  }
  return {
    ...incoming,
    blocks: [...blocks.values()].sort((left, right) => left.sequence - right.sequence),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
