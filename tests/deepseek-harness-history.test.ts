import { describe, expect, it } from "bun:test";
import { pageHistoryEvents } from "../src/plugin/official/deepseek-harness-history.mjs";

describe("DSH Bridge bounded history", () => {
  it("returns only the newest bounded window of history, with explicit completeness", () => {
    const events = Array.from({ length: 10 }, (_, seq) => ({
      seq,
      time: 1,
      type: seq === 6 ? "turn/start" : seq % 2 ? "user/message" : "x",
      data: { turn: seq < 6 ? 1 : 2, text: "p".repeat(1_000) },
    }));
    const newest = pageHistoryEvents(events, { maxBytes: 2_500 });
    expect(newest.events.map((event) => event.seq)).toEqual([8, 9]);
    expect(newest).toMatchObject({ complete: false, nextBeforeSeq: 8 });
    const walked: number[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = pageHistoryEvents(events, { maxBytes: 2_500, beforeSeq: cursor });
      walked.unshift(...page.events.map((event) => event.seq));
      if (page.nextBeforeSeq === null) break;
      cursor = page.nextBeforeSeq;
    }
    expect(walked).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pageHistoryEvents(events, { maxBytes: 1 << 30 })).toMatchObject({ complete: true, nextBeforeSeq: null });
    const latestTurn = pageHistoryEvents(events, { lastTurns: 1 });
    expect(latestTurn.events.map((event) => event.seq)).toEqual([6, 7, 8, 9]);
    expect(latestTurn).toMatchObject({ complete: false, nextBeforeSeq: null });
    expect(pageHistoryEvents(events, { lastTurns: 2 }).complete).toBe(true);
    expect(
      pageHistoryEvents(events, { types: ["user/message"], maxBytes: 1 << 30 }).events.map((event) => event.seq),
    ).toEqual([1, 3, 5, 7, 9]);
    expect(pageHistoryEvents(events, { limit: 1 })).toMatchObject({ events: [{ seq: 9 }], nextBeforeSeq: 9 });
    expect(pageHistoryEvents(events, { maxBytes: 10 }).events).toHaveLength(1);
    expect(pageHistoryEvents(events, { headerOnly: true }).events).toEqual([]);
    expect(pageHistoryEvents([], {})).toEqual({ events: [], complete: true, nextBeforeSeq: null });
  });
});
