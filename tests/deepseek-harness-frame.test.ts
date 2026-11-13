import { describe, expect, it } from "bun:test";
import { encodeBridgeFrame } from "../src/plugin/official/deepseek-harness-frame.mjs";
import {
  DSH_BRIDGE_MAX_FRAME_BYTES,
  type DshBridgeEvent,
  parseDshBridgeFrame,
} from "../src/runtime/deepseek-harness-protocol";
import { toolResultBlocks, toolResultMessage } from "./fixtures/dsh-tool-result";

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
  it("uses a 16 MiB frame limit", () => {
    expect(DSH_BRIDGE_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });

  it("sends a frame within the limit unchanged", () => {
    const frame = toolResult("x".repeat(2 * 1024 * 1024));
    const result = encodeBridgeFrame(frame, DSH_BRIDGE_MAX_FRAME_BYTES);
    expect(result.degraded).toBeNull();
    expect(result.encoded).toBe(`${JSON.stringify(frame)}\n`);
  });

  it("truncates an oversized tool output to a marked preview that still parses", () => {
    const { encoded, degraded } = encodeBridgeFrame(toolResult("é".repeat(200_000)), LIMIT);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(LIMIT);
    expect(degraded).toMatchObject({ placeholder: false, fields: 1 });
    const frame = parseDshBridgeFrame(encoded.trimEnd()) as DshBridgeEvent;
    const text = toolResultBlocks(frame.event)[0]?.text as string;
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
    const blocks = toolResultBlocks(frame.event);
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
    const message = toolResultMessage(frame.event);
    message.content = [{ ...message.content[0], content: many.map((text) => ({ type: "text", text })) }];
    const { encoded, degraded } = encodeBridgeFrame(frame, 50 * 1024);
    expect(degraded?.placeholder).toBe(true);
    const parsed = parseDshBridgeFrame(encoded.trimEnd()) as DshBridgeEvent;
    expect(toolResultMessage(parsed.event).source?.callId).toBe("call-1");
    expect(toolResultMessage(parsed.event).content[0]?.toolCallId).toBe("call-1");
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
});
