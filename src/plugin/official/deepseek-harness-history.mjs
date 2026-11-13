// Bounded reads of a DSH Session's events for the Bridge `history` method.
// Dependency-free: shipped as a sibling Plugin asset of the Bridge.

const byteLength = (value) => Buffer.byteLength(value);

export const DSH_BRIDGE_HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
const HISTORY_PAGE_BYTES_CEILING = 8 * 1024 * 1024;

// Mirrors the event types DshActivityProjector.project() maps to no Activity.
const PROJECTOR_IGNORED_TYPES = new Set([
  "turn/start",
  "step/start",
  "step/end",
  "request/header",
  "request/context",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "agent/inbox/spliced",
]);

const turnOf = (event) => (Number.isSafeInteger(event?.data?.turn) ? event.data.turn : undefined);

/**
 * Select one bounded window of Session events for the Bridge `history` method. The window is always the newest
 * matching events, so no caller can ask the Bridge for a whole Session in one frame.
 *
 * Params (all optional): `headerOnly` (no events), `lastTurns` (scope: the N latest Turns plus Turn-less command
 * events and other bucket-0 events, which share one position counter in the Activity Projector), `types` (event type allow-list),
 * `beforeSeq` (exclusive cursor: continue to older events), `limit` (max events) and `maxBytes` (encoded budget,
 * default 4 MiB, capped at 8 MiB). A window holds at least one event so a single oversized event still makes
 * progress (it is degraded when the response is encoded). Events come back in ascending order.
 *
 * `complete` is true only when no matching Session event was left out (by the budget or by the `lastTurns`
 * scope). `nextBeforeSeq` is non-null only when the budget cut the window: it is the cursor for the next older
 * window inside the same scope.
 */
export function pageHistoryEvents(events, params = {}) {
  if (params.headerOnly === true) return { events: [], complete: events.length === 0, nextBeforeSeq: null };
  const types = Array.isArray(params.types) ? new Set(params.types.filter((type) => typeof type === "string")) : null;
  const matches = (event) => !types || types.has(event.type);
  const beforeSeq = Number.isSafeInteger(params.beforeSeq) ? params.beforeSeq : Number.POSITIVE_INFINITY;
  let scopeStart = 0;
  if (Number.isSafeInteger(params.lastTurns) && params.lastTurns > 0) {
    const turns = [...new Set(events.map(turnOf).filter((turn) => turn !== undefined))].sort((a, b) => a - b);
    if (turns.length > 0) {
      const threshold = turns[Math.max(0, turns.length - params.lastTurns)];
      const first = events.findIndex((event) => (turnOf(event) ?? Number.NEGATIVE_INFINITY) >= threshold);
      scopeStart = first < 0 ? 0 : first;
    }
  }
  // Events that land on position bucket 0 share one counter in the Activity Projector, so a lastTurns scope keeps
  // them from the whole Session: commands, turn-0 events, and any Activity-producing event before the first
  // numbered Turn. Events the Projector ignores outright (PROJECTOR_IGNORED_TYPES) never matter.
  const firstTurnIndex = events.findIndex((event) => turnOf(event) !== undefined);
  const inScope = (event, index) =>
    index >= scopeStart ||
    (params.lastTurns > 0 &&
      (event.type === "command/run" ||
        event.type === "command/done" ||
        turnOf(event) === 0 ||
        ((firstTurnIndex < 0 || index < firstTurnIndex) && !PROJECTOR_IGNORED_TYPES.has(event.type))));
  const budget = Math.min(
    Number.isSafeInteger(params.maxBytes) && params.maxBytes > 0 ? params.maxBytes : DSH_BRIDGE_HISTORY_PAGE_BYTES,
    HISTORY_PAGE_BYTES_CEILING,
  );
  const limit = Number.isSafeInteger(params.limit) && params.limit > 0 ? params.limit : Number.POSITIVE_INFINITY;
  const window = [];
  let used = 0;
  let leftOut = false;
  let budgetCut = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!(event.seq < beforeSeq) || !matches(event)) continue;
    if (!inScope(event, index)) {
      leftOut = true;
      continue;
    }
    const size = byteLength(JSON.stringify(event)) + 1;
    if (window.length > 0 && (used + size > budget || window.length >= limit)) {
      leftOut = true;
      budgetCut = true;
      break;
    }
    window.push(event);
    used += size;
  }
  window.reverse();
  return { events: window, complete: !leftOut, nextBeforeSeq: budgetCut ? window[0].seq : null };
}
