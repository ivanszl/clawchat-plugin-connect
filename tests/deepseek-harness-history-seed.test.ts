import { describe, expect, it } from "bun:test";
import { pageHistoryEvents } from "../src/plugin/official/deepseek-harness-frame.mjs";
import { DshActivityProjector } from "../src/runtime/deepseek-harness-adapter";
import type { DshSessionEvent } from "../src/runtime/deepseek-harness-protocol";

/**
 * Starting a Turn seeds the Activity Projector from history, discards what that replay produces, and only emits
 * live Activities. The seed is now the latest Turn only (`history` with `lastTurnOnly`). These cases prove the live
 * Activities (ids, positions, order, text, state) are identical to a full-history replay.
 */
let sequence = 0;
const ev = (type: string, data: unknown): DshSessionEvent => ({ seq: ++sequence, time: sequence, type, data });

function userTurn(turn: number, text: string, opts: { endTurn?: boolean; tool?: boolean } = {}): DshSessionEvent[] {
  const events = [
    ev("turn/start", { turn }),
    ev("user/message", { turn, id: `m${turn}`, source: { kind: "user" }, content: [{ type: "text", text }] }),
    ev("step/start", { turn, step: 0 }),
    ev("assistant/chunk", { turn, step: 0, chunk: { type: "reasoning-delta", text: "thinking" } }),
    ev("assistant/chunk", { turn, step: 0, chunk: { type: "text-delta", text: `answer ${turn}` } }),
  ];
  if (opts.tool !== false) {
    events.push(
      ev("tool/call", { turn, callId: `c${turn}`, name: "bash", arguments: '{"command":"ls"}' }),
      ev("tool/result", {
        turn,
        message: {
          source: { callId: `c${turn}` },
          content: [{ type: "tool-result", toolCallId: `c${turn}`, content: [{ type: "text", text: "ok" }] }],
        },
      }),
    );
  }
  events.push(
    ev("assistant/message", { turn, step: 0, message: { content: [{ type: "text", text: `answer ${turn}` }] } }),
  );
  if (opts.endTurn !== false) events.push(ev("turn/end", { turn, reason: { kind: "completed" } }));
  return events;
}

const command = (id: string) => [
  ev("command/run", { commandId: id, name: "compact" }),
  ev("command/done", { commandId: id, name: "compact", result: "done" }),
];

function liveTurn(turn: number, text: string): DshSessionEvent[] {
  return userTurn(turn, text);
}

function replay(
  seed: readonly DshSessionEvent[],
  live: readonly DshSessionEvent[],
): ReturnType<DshActivityProjector["accept"]> {
  const projector = new DshActivityProjector("s1");
  for (const event of seed) projector.accept(structuredClone(event), "history");
  const out: ReturnType<DshActivityProjector["accept"]> = [];
  for (const event of live) out.push(...structuredClone(projector.accept(structuredClone(event), "live")));
  return out;
}

function expectEquivalent(history: DshSessionEvent[], live: DshSessionEvent[]) {
  const tail = pageHistoryEvents(history, { lastTurns: 1, maxBytes: 1 << 30 }).events;
  expect(tail.length).toBeLessThanOrEqual(history.length);
  const full = replay(history, live);
  const bounded = replay(tail, live);
  expect(full.length).toBeGreaterThan(0);
  expect(bounded).toEqual(full);
  return { full, tailLength: tail.length };
}

describe("bounded Turn-start history seed", () => {
  it("matches the full replay for a new Turn after several completed Turns", () => {
    sequence = 0;
    const history = [...userTurn(1, "a"), ...userTurn(2, "b"), ...userTurn(3, "c")];
    const { tailLength } = expectEquivalent(history, liveTurn(4, "d"));
    expect(tailLength).toBeLessThan(history.length);
  });

  it("matches for an empty Session and a first Turn", () => {
    sequence = 0;
    expectEquivalent([], liveTurn(1, "hello"));
  });

  it("matches when the latest Turn ended mid-stream (no turn/end) and a new Turn starts", () => {
    sequence = 0;
    const history = [...userTurn(1, "a"), ...userTurn(2, "b", { endTurn: false })];
    expectEquivalent(history, liveTurn(3, "c"));
  });

  it("matches steer mode: live events continue the latest, still-running Turn", () => {
    sequence = 0;
    const history = [...userTurn(1, "a"), ...userTurn(2, "b", { endTurn: false })];
    const steer = [
      ev("user/message", {
        turn: 2,
        id: "steer-1",
        source: { kind: "user" },
        content: [{ type: "text", text: "also" }],
      }),
      ev("step/start", { turn: 2, step: 1 }),
      ev("assistant/chunk", { turn: 2, step: 1, chunk: { type: "text-delta", text: "more" } }),
      ev("tool/call", { turn: 2, callId: "c2b", name: "bash", arguments: "{}" }),
      ev("assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "more" }] } }),
      ev("turn/end", { turn: 2, reason: { kind: "completed" } }),
    ];
    const { full } = expectEquivalent(history, steer);
    // Positions of the continued Turn keep counting after the seeded items, never restarting at 2.0.
    expect(full.some((activity) => activity.position === "2.0" && activity.id.includes("steer"))).toBe(false);
  });

  it("matches when a user message is logged before its turn/start and with command events around Turns", () => {
    sequence = 0;
    const early = [
      ev("user/message", { turn: 2, id: "m2", source: { kind: "user" }, content: [{ type: "text", text: "b" }] }),
      ev("turn/start", { turn: 2 }),
      ev("assistant/chunk", { turn: 2, step: 0, chunk: { type: "text-delta", text: "partial" } }),
    ];
    const history = [...userTurn(1, "a"), ...command("k1"), ...early, ...command("k2")];
    const live = [
      ev("step/start", { turn: 2, step: 1 }),
      ev("assistant/chunk", { turn: 2, step: 1, chunk: { type: "text-delta", text: "rest" } }),
      ev("tool/call", { turn: 2, callId: "late", name: "bash", arguments: "{}" }),
      ...command("k3"),
      ev("turn/end", { turn: 2, reason: { kind: "completed" } }),
      ...liveTurn(3, "next"),
    ];
    expectEquivalent(history, live);
  });

  it("falls back to the whole Session when events carry no Turn numbers", () => {
    sequence = 0;
    const history = [ev("session/title", { title: "x" }), ev("agent/inbox/spliced", {})];
    expect(pageHistoryEvents(history, { lastTurns: 1 }).events).toEqual(history);
  });

  it("matches when the seed is read in several budget-limited windows", () => {
    sequence = 0;
    const history = [...userTurn(1, "a"), ...userTurn(2, "b"), ...userTurn(3, "c")];
    const live = liveTurn(4, "d");
    const windows: DshSessionEvent[][] = [];
    let beforeSeq: number | undefined;
    for (;;) {
      const page = pageHistoryEvents(history, { lastTurns: 1, maxBytes: 600, beforeSeq });
      windows.unshift(page.events);
      if (page.nextBeforeSeq === null) break;
      beforeSeq = page.nextBeforeSeq;
    }
    expect(windows.length).toBeGreaterThan(1);
    expect(replay(windows.flat(), live)).toEqual(replay(history, live));
  });
});
