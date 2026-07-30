import { describe, expect, it } from "bun:test";
import { addressInboundMessage, buildReplyTextMessagePayload, isMessageAddressedToAgent } from "../src/message-mapper";
import type { NormalizedInboundMessage } from "../src/protocol";

function inboundMessage(chatType: "direct" | "group"): NormalizedInboundMessage {
  return {
    event: "message.send",
    chatId: "chat-1",
    chatType,
    messageId: "message-1",
    traceId: "trace-1",
    sender: { id: "user-1", type: "direct", nick_name: "User" },
    emittedAt: Date.now(),
    text: "question",
    fragments: [{ kind: "text", text: "question" }],
    mentions: [],
    replyToMessageId: null,
    raw: {} as never,
  };
}

describe("ClawChat reply payloads", () => {
  it("sends a direct-message response without quoting the inbound message", () => {
    const payload = buildReplyTextMessagePayload("answer", inboundMessage("direct"));

    expect(payload.message.context.reply).toBeNull();
  });

  it("keeps the inbound-message quote on a group response", () => {
    const payload = buildReplyTextMessagePayload("answer", inboundMessage("group"));

    expect(payload.message.context.reply).toEqual({
      reply_to_msg_id: "message-1",
      reply_preview: {
        id: "user-1",
        nick_name: "User",
        fragments: [{ kind: "text", text: "question" }],
      },
    });
  });
});

describe("ClawChat inbound addressing", () => {
  it("accepts direct messages without a mention", () => {
    expect(isMessageAddressedToAgent(inboundMessage("direct"), "agent-1")).toBe(true);
  });

  it("accepts only group messages that mention the activated Agent", () => {
    const unmentioned = inboundMessage("group");
    const contextOnly = { ...unmentioned, mentions: ["agent-1"] };
    const mentioned = {
      ...contextOnly,
      fragments: [{ kind: "mention", user_id: "agent-1", display: "Agent" }],
    };

    expect(isMessageAddressedToAgent(unmentioned, "agent-1")).toBe(false);
    expect(isMessageAddressedToAgent(contextOnly, "agent-1")).toBe(false);
    expect(isMessageAddressedToAgent(mentioned, "agent-1")).toBe(true);
  });

  it("keeps attachment-only addressed input free of synthetic prompt text", () => {
    const message = {
      ...inboundMessage("group"),
      text: "@Agent[file: report.txt]",
      fragments: [
        { kind: "mention", user_id: "agent-1", display: "Agent" },
        { kind: "file", url: "https://media.example/report.txt", name: "report.txt" },
      ],
      mentions: ["agent-1"],
    } satisfies NormalizedInboundMessage;

    expect(addressInboundMessage(message, "agent-1")?.message.text).toBe("");
  });
});
