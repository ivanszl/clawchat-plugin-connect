import { describe, expect, it, mock } from "bun:test";
import type { Fragment, NormalizedInboundMessage } from "../src/protocol";
import { RuntimeInteractionRouter } from "../src/runtime/runtime-interaction-router";
import type { RuntimeInteractionPort, RuntimeInteractionRequest } from "../src/runtime/types";

function message(senderId: string, text: string): NormalizedInboundMessage {
  return {
    event: "message.send",
    chatId: "owner-conversation",
    chatType: "direct",
    messageId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    sender: { id: senderId, type: "direct", nick_name: senderId },
    emittedAt: Date.now(),
    text,
    fragments: [{ kind: "text", text }],
    mentions: [],
    replyToMessageId: null,
    raw: {
      version: "2",
      event: "message.send",
      trace_id: crypto.randomUUID(),
      emitted_at: Date.now(),
      chat_id: "owner-conversation",
      chat_type: "direct",
      sender: { id: senderId, type: "direct", nick_name: senderId },
      payload: {
        message_mode: "normal",
        message: { body: { fragments: [{ kind: "text", text }] }, context: { mentions: [], reply: null } },
      },
    },
  };
}

function approvalRequest(): RuntimeInteractionRequest {
  return {
    kind: "approval",
    action: "command",
    title: "允许运行命令？",
    description: "更新本地 Connect",
    command: "install dist/clawchat-connect ~/.local/bin/clawchat-connect",
    options: [
      { id: "approve-once", label: "仅此次允许" },
      { id: "approve-session", label: "本 Session 允许" },
      { id: "deny", label: "拒绝" },
    ],
  };
}

describe("Runtime Interaction surface routing", () => {
  it("keeps Client-originated interactions in Connect Client", async () => {
    const clientRequest = mock(async () => ({ kind: "approval" as const, optionId: "approve-once" as const }));
    const sendClawChatMessage = mock(async (_fragments: Fragment[]) => undefined);
    const router = new RuntimeInteractionRouter({
      clientPort: { request: clientRequest },
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage,
    });

    await expect(
      router.request(approvalRequest(), {
        sessionRef: "ABCDEFGH",
        turnId: "turn-client",
        origin: "client",
      }),
    ).resolves.toEqual({ kind: "approval", optionId: "approve-once" });
    expect(clientRequest).toHaveBeenCalledTimes(1);
    expect(sendClawChatMessage).not.toHaveBeenCalled();
  });

  it("renders ClawChat approval commands and accepts only the owner's matching reply", async () => {
    const sent: Fragment[][] = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage: async (fragments) => {
        sent.push(fragments);
      },
    });
    const result = router.request(approvalRequest(), {
      sessionRef: "ABCDEFGH",
      turnId: "turn-clawchat",
      origin: "clawchat",
    });
    while (sent.length === 0) await Bun.sleep(0);
    expect(sent[0]).toEqual([
      {
        kind: "text",
        text: "允许运行命令？\n更新本地 Connect\n\n/approve 仅此次允许\n/approve session 本 Session 允许\n/deny 拒绝",
      },
    ]);
    await expect(router.handleMessage(message("other-user", "/approve"))).resolves.toBe(false);
    await expect(router.handleMessage(message("owner-1", "/approve session"))).resolves.toBe(true);
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "approve-session" });
  });

  it("collects multi-step Agent answers in ClawChat before resuming Codex", async () => {
    const sent: Fragment[][] = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage: async (fragments) => {
        sent.push(fragments);
      },
    });
    const result = router.request(
      {
        kind: "user-input",
        title: "Codex 需要你的回答",
        description: "请回答 2 个问题。",
        questions: [
          {
            id: "color",
            header: "颜色",
            prompt: "选择颜色",
            secret: false,
            allowOther: false,
            options: [
              { id: "red", label: "红色" },
              { id: "blue", label: "蓝色" },
            ],
          },
          {
            id: "note",
            header: "备注",
            prompt: "请输入备注",
            secret: false,
            allowOther: true,
            options: null,
          },
        ],
        autoResolutionMs: null,
      },
      { sessionRef: "ABCDEFGH", turnId: "turn-question", origin: "clawchat" },
    );
    while (sent.length === 0) await Bun.sleep(0);
    expect(sent[0]).toEqual([{ kind: "text", text: "颜色：选择颜色\n\n/1 红色\n/2 蓝色" }]);
    await expect(router.handleMessage(message("owner-1", "/2"))).resolves.toBe(true);
    while (sent.length < 2) await Bun.sleep(0);
    expect(sent[1]).toEqual([expect.objectContaining({ kind: "text", text: expect.stringContaining("请输入备注") })]);
    await expect(router.handleMessage(message("owner-1", "今天发布"))).resolves.toBe(true);
    await expect(result).resolves.toEqual({
      kind: "user-input",
      answers: { color: ["蓝色"], note: ["今天发布"] },
    });
  });
});
