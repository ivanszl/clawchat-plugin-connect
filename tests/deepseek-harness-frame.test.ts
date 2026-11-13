import { describe, expect, it } from "bun:test";
import {
  DSH_BRIDGE_MAX_FRAME_BYTES,
  encodeBridgeFrame,
  pageHistoryEvents,
} from "../src/plugin/official/deepseek-harness-frame.mjs";
import {
  type DshBridgeEvent,
  DSH_BRIDGE_MAX_FRAME_BYTES as PROTOCOL_LIMIT,
  parseDshBridgeFrame,
} from "../src/runtime/deepseek-harness-protocol";

const LIMIT = 64 * 1024;

function toolResult(text: string, extra: unknown[] = []) {
  return {
    type: "event",
    sessionId: "s1",
    event: {
      seq: 7,
      time: 1,
      type: "tool/result",
      data: {
        turn: 2,
        message: {
          source: { callId: "call-1" },
          content: [
            { type: "tool-result", toolCallId: "call-1", isError: false, content: [{ type: "text", text }, ...extra] },
          ],
        },
      },
    },
  };
}

describe("DSH Bridge frame encoding", () => {
  it("shares one 16 MiB limit between the Bridge asset and the protocol", () => {
    expect(DSH_BRIDGE_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(PROTOCOL_LIMIT).toBe(DSH_BRIDGE_MAX_FRAME_BYTES);
  });

  it("sends a frame within the limit unchanged", () => {
    const frame = toolResult("x".repeat(2 * 1024 * 1024));
    const result = encodeBridgeFrame(frame);
    expect(result.degraded).toBeNull();
    expect(result.encoded).toBe(`${JSON.stringify(frame)}\n`);
  });

  it("truncates an oversized tool output to a marked preview that still parses", () => {
    const { encoded, degraded } = encodeBridgeFrame(toolResult("é".repeat(200_000)), LIMIT);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(LIMIT);
    expect(degraded).toMatchObject({ placeholder: false, fields: 1 });
    const frame = parseDshBridgeFrame(encoded.trimEnd()) as DshBridgeEvent;
    const text = (frame.event.data as any).message.content[0].content[0].text as string;
    expect(text).toEndWith("\n[output truncated: 400000 bytes]");
    expect(text).not.toContain("�");
    expect(frame.event.truncated).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
      fields: [{ originalBytes: 400_000, kind: "text" }],
    });
    expect(frame.event.seq).toBe(7);
  });

  it("omits inline base64 images instead of keeping a corrupt prefix", () => {
    const image = { type: "image", mediaType: "image/png", data: Buffer.alloc(300_000, 1).toString("base64") };
    const { encoded } = encodeBridgeFrame(toolResult("ok", [image]), LIMIT);
    const frame = parseDshBridgeFrame(encoded.trimEnd()) as DshBridgeEvent;
    const blocks = (frame.event.data as any).message.content[0].content;
    expect(blocks[0].text).toBe("ok");
    expect(blocks[1].data).toBe("[binary omitted: 400000 bytes]");
    expect(frame.event.truncated?.fields[0]).toMatchObject({ kind: "binary", previewBytes: 0 });
  });

  it("falls back to a minimal placeholder that keeps the Turn lifecycle fields", () => {
    const many = Array.from({ length: 400 }, (_, index) => `${index}:${"y".repeat(500)}`);
    const frame = {
      type: "event",
      sessionId: "s1",
      event: { seq: 9, time: 2, type: "turn/end", data: { turn: 3, reason: { kind: "completed" }, blob: many } },
    };
    const { encoded, degraded } = encodeBridgeFrame(frame, 50 * 1024);
    expect(degraded).toMatchObject({ placeholder: true });
    const parsed = parseDshBridgeFrame(encoded.trimEnd()) as DshBridgeEvent;
    expect(parsed.event).toMatchObject({
      seq: 9,
      type: "turn/end",
      data: { turn: 3, reason: { kind: "completed" } },
      truncated: { truncated: true, placeholder: true },
    });
  });

  it("keeps a tool/result placeholder attached to its call", () => {
    const many = Array.from({ length: 400 }, (_, index) => `${index}:${"y".repeat(500)}`);
    const frame = toolResult("x");
    (frame.event.data as any).message.content[0].content = many.map((text) => ({ type: "text", text }));
    const { encoded, degraded } = encodeBridgeFrame(frame, 50 * 1024);
    expect(degraded?.placeholder).toBe(true);
    const parsed = parseDshBridgeFrame(encoded.trimEnd()) as DshBridgeEvent;
    expect((parsed.event.data as any).message.source.callId).toBe("call-1");
    expect((parsed.event.data as any).message.content[0].toolCallId).toBe("call-1");
  });

  it("degrades interactions and ok responses but refuses what cannot shrink", () => {
    const interaction = {
      type: "interaction",
      id: "i1",
      sessionId: "s1",
      request: { kind: "approval", action: "command", title: "t", description: "d".repeat(200_000), options: [] },
    };
    const degradedLine = encodeBridgeFrame(interaction, LIMIT).encoded.trimEnd();
    expect(parseDshBridgeFrame(degradedLine)).toMatchObject({ type: "interaction", id: "i1" });
    expect(JSON.parse(degradedLine).truncated.truncated).toBe(true);

    const response = { type: "response", id: "r1", ok: true, result: { events: [{ text: "z".repeat(200_000) }] } };
    const degradedResponse = parseDshBridgeFrame(encodeBridgeFrame(response, LIMIT).encoded.trimEnd());
    expect(degradedResponse).toMatchObject({ type: "response", id: "r1", ok: true });

    const many = { type: "response", id: "r2", ok: true, result: Array.from({ length: 400 }, () => "q".repeat(500)) };
    expect(() => encodeBridgeFrame(many, 50 * 1024)).toThrow(expect.objectContaining({ code: "frame-too-large" }));
    const error = { type: "response", id: "r3", ok: false, error: { code: "x", message: "m".repeat(LIMIT) } };
    expect(() => encodeBridgeFrame(error, LIMIT)).toThrow(expect.objectContaining({ code: "frame-too-large" }));
  });

  it("turns an unencodable event into a placeholder instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { encoded } = encodeBridgeFrame(
      { type: "event", sessionId: "s1", event: { seq: 1, time: 1, type: "x", data: circular } },
      LIMIT,
    );
    expect(parseDshBridgeFrame(encoded.trimEnd())).toMatchObject({ type: "event", event: { type: "x" } });
  });

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
