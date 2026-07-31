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

function groupMessage(senderId: string, text: string): NormalizedInboundMessage {
  return {
    ...message(senderId, text),
    chatId: "group-conversation",
    chatType: "group",
    fragments: [
      { kind: "mention", user_id: "agent-1", display: "Agent" },
      { kind: "text", text: ` ${text}` },
    ],
    mentions: ["agent-1"],
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
    const sendClawChatMessage = mock(async (_delivery: { fragments: Fragment[] }) => undefined);
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
        deliveryConfirmation: Promise.resolve(),
      }),
    ).resolves.toEqual({ kind: "approval", optionId: "approve-once" });
    expect(clientRequest).toHaveBeenCalledTimes(1);
    expect(sendClawChatMessage).not.toHaveBeenCalled();
  });

  it("rejects ClawChat interactions without native delivery confirmation", async () => {
    const controller = new AbortController();
    const sendClawChatMessage = mock(async (_delivery: { fragments: Fragment[] }) => undefined);
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage,
    });

    const result = router.request(approvalRequest(), {
      sessionRef: "ABCDEFGH",
      turnId: "turn-clawchat",
      origin: "clawchat",
      signal: controller.signal,
      deliveryConfirmation: undefined as unknown as Promise<void>,
      clawchat: {
        chatId: "owner-conversation",
        chatType: "direct",
        sourceMessageId: "message-direct",
      },
    });
    const rejection = expect(result).rejects.toThrow("Native delivery confirmation is required");
    await Bun.sleep(0);
    controller.abort();

    await rejection;
    expect(sendClawChatMessage).not.toHaveBeenCalled();
  });

  it("rejects ClawChat interactions without their originating conversation route", async () => {
    const sendClawChatMessage = mock(async (_delivery: { fragments: Fragment[] }) => {
      throw new Error("Unexpected presentation");
    });
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage,
    });

    const result = router.request(approvalRequest(), {
      sessionRef: "ABCDEFGH",
      turnId: "turn-clawchat",
      origin: "clawchat",
      deliveryConfirmation: Promise.resolve(),
    });

    await expect(result).rejects.toThrow("Originating ClawChat conversation route is required");
    expect(sendClawChatMessage).not.toHaveBeenCalled();
  });

  it("renders sanitized direct ClawChat approval commands and accepts only the owner's matching reply", async () => {
    const sent: Fragment[][] = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery.fragments);
      },
    });
    const result = router.request(
      { ...approvalRequest(), description: "token=short-secret" },
      {
        sessionRef: "ABCDEFGH",
        turnId: "turn-clawchat",
        origin: "clawchat",
        deliveryConfirmation: Promise.resolve(),
        clawchat: {
          chatId: "owner-conversation",
          chatType: "direct",
          sourceMessageId: "message-direct",
        },
      },
    );
    while (sent.length === 0) await Bun.sleep(0);
    expect(JSON.stringify(sent[0])).not.toContain("short-secret");
    expect(sent[0]).toEqual([
      {
        kind: "text",
        text: "Runtime command approval requested\nReview the Runtime request and choose one of the Connect decisions below.\n\n/approve 仅此次允许\n/approve session 本 Session 允许\n/deny 拒绝",
      },
    ]);
    await expect(router.handleMessage(message("other-user", "/approve"))).resolves.toBe(false);
    await expect(router.handleMessage(message("owner-1", "/approve session"))).resolves.toBe(true);
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "approve-session" });
  });

  it("presents and settles a group approval in its originating conversation", async () => {
    const sent: Array<{
      chatId: string;
      chatType: "direct" | "group";
      sourceMessageId: string | null;
      fragments: Fragment[];
    }> = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    const result = router.request(
      { ...approvalRequest(), description: "token=do-not-publish" },
      {
        sessionRef: "ABCDEFGH",
        turnId: "turn-group",
        origin: "clawchat",
        deliveryConfirmation: Promise.resolve(),
        clawchat: {
          chatId: "group-conversation",
          chatType: "group",
          sourceMessageId: "message-group",
        },
      },
    );
    while (sent.length === 0) await Bun.sleep(0);

    expect(sent[0]).toMatchObject({
      chatId: "group-conversation",
      chatType: "group",
      sourceMessageId: "message-group",
      fragments: [
        {
          kind: "text",
          text: expect.stringContaining("Session ABCDEFGH"),
        },
      ],
    });
    expect(JSON.stringify(sent[0].fragments)).not.toContain("do-not-publish");
    await expect(router.handleMessage(groupMessage("member-1", "/approve"))).resolves.toBe(true);
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "approve-once" });
    expect(sent.at(-1)).toMatchObject({
      chatId: "group-conversation",
      fragments: [
        expect.objectContaining({
          kind: "text",
          text: expect.stringContaining("member-1 approved once for Session ABCDEFGH"),
        }),
      ],
    });

    await expect(router.handleMessage(groupMessage("member-2", "/deny"))).resolves.toBe(true);
    expect(sent.at(-1)?.fragments).toEqual([
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("member-1 approved once for Session ABCDEFGH"),
      }),
    ]);
  });

  it("accepts a structured group response only for its exact Interaction and route", async () => {
    const sent: Array<{
      interactionId: string | null;
      chatId: string;
      chatType: "direct" | "group";
      fragments: Fragment[];
    }> = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    const result = router.request(approvalRequest(), {
      sessionRef: "ABCDEFGH",
      turnId: "turn-group",
      origin: "clawchat",
      deliveryConfirmation: Promise.resolve(),
      clawchat: {
        chatId: "group-conversation",
        chatType: "group",
        sourceMessageId: "message-group",
      },
    });
    while (sent.length === 0) await Bun.sleep(0);
    const interactionId = sent[0].interactionId;
    if (!interactionId) throw new Error("Expected an Interaction identity in its presentation");
    const action = {
      type: "connect_runtime_interaction",
      interaction_id: interactionId,
      option_id: "deny",
    };

    await expect(
      router.handleInteractionSubmit({
        version: "2",
        event: "interaction.submit",
        trace_id: crypto.randomUUID(),
        emitted_at: Date.now(),
        chat_id: "different-group",
        chat_type: "group",
        sender: { id: "member-1", type: "direct", nick_name: "Member" },
        payload: { action },
      }),
    ).resolves.toBe(true);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);

    await expect(
      router.handleInteractionSubmit({
        version: "2",
        event: "interaction.submit",
        trace_id: crypto.randomUUID(),
        emitted_at: Date.now(),
        chat_id: "group-conversation",
        chat_type: "group",
        sender: { id: "member-2", type: "direct", nick_name: "Member 2" },
        payload: { action },
      }),
    ).resolves.toBe(true);
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "deny" });

    await expect(
      router.handleInteractionSubmit({
        version: "2",
        event: "interaction.submit",
        trace_id: crypto.randomUUID(),
        emitted_at: Date.now(),
        chat_id: "group-conversation",
        chat_type: "group",
        sender: { id: "member-3", type: "direct", nick_name: "Member 3" },
        payload: { action: { ...action, option_id: "approve-once" } },
      }),
    ).resolves.toBe(true);
    expect(sent.at(-1)?.fragments).toEqual([
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("Member 2 denied for Session ABCDEFGH"),
      }),
    ]);
  });

  it("reports group resolution only after native delivery confirmation", async () => {
    const sent: Array<{ fragments: Fragment[] }> = [];
    let confirmDelivery: () => void = () => undefined;
    const deliveryConfirmation = new Promise<void>((resolve) => {
      confirmDelivery = resolve;
    });
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    const result = router.request(approvalRequest(), {
      sessionRef: "ABCDEFGH",
      turnId: "turn-group",
      origin: "clawchat",
      deliveryConfirmation,
      clawchat: {
        chatId: "group-conversation",
        chatType: "group",
        sourceMessageId: "message-group",
      },
    });
    while (sent.length === 0) await Bun.sleep(0);

    const response = router.handleMessage(groupMessage("member-1", "/approve"));
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "approve-once" });
    await Bun.sleep(0);
    expect(sent).toHaveLength(1);

    confirmDelivery();
    await expect(response).resolves.toBe(true);
    expect(sent.at(-1)?.fragments).toEqual([
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("member-1 approved once for Session ABCDEFGH"),
      }),
    ]);
  });

  it("accepts a structured free-text answer for its exact current question", async () => {
    const sent: Array<{ interactionId: string | null; fragments: Fragment[] }> = [];
    let confirmDelivery: () => void = () => undefined;
    const deliveryConfirmation = new Promise<void>((resolve) => {
      confirmDelivery = resolve;
    });
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    const result = router.request(
      {
        kind: "user-input",
        title: "Version",
        description: "Choose a version",
        autoResolutionMs: null,
        questions: [
          {
            id: "version",
            header: "Version",
            prompt: "Use https://private.example/input?opaque=short-secret",
            secret: false,
            allowOther: true,
            options: null,
          },
        ],
      },
      {
        sessionRef: "ABCDEFGH",
        turnId: "turn-group",
        origin: "clawchat",
        deliveryConfirmation,
        clawchat: {
          chatId: "group-conversation",
          chatType: "group",
          sourceMessageId: "message-group",
        },
      },
    );
    while (sent.length === 0) await Bun.sleep(0);
    expect(JSON.stringify(sent[0].fragments)).not.toContain("short-secret");
    expect(JSON.stringify(sent[0].fragments)).not.toContain("Version");
    expect(sent[0].fragments).toEqual([
      expect.objectContaining({ kind: "text", text: expect.stringContaining("Question 1") }),
    ]);
    const interactionId = sent[0].interactionId;
    if (!interactionId) throw new Error("Expected an Interaction identity in its presentation");

    const submission = router.handleInteractionSubmit({
      version: "2",
      event: "interaction.submit",
      trace_id: crypto.randomUUID(),
      emitted_at: Date.now(),
      chat_id: "group-conversation",
      chat_type: "group",
      sender: { id: "member-1", type: "direct", nick_name: "Member" },
      payload: {
        type: "connect_runtime_interaction",
        interaction_id: interactionId,
        question_id: "version",
        answer: "v1.4.0",
      },
    });
    await expect(result).resolves.toEqual({
      kind: "user-input",
      answers: { version: ["v1.4.0"] },
    });
    await Bun.sleep(0);
    expect(sent).toHaveLength(1);

    confirmDelivery();
    await expect(submission).resolves.toBe(true);
    expect(sent.at(-1)?.fragments).toEqual([
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("Member's answers were delivered for Session ABCDEFGH"),
      }),
    ]);
  });

  it("publishes a terminal group failure when native delivery is rejected", async () => {
    const sent: Array<{ fragments: Fragment[] }> = [];
    let rejectDelivery: (error: Error) => void = () => undefined;
    const deliveryConfirmation = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    const result = router.request(approvalRequest(), {
      sessionRef: "ABCDEFGH",
      turnId: "turn-group",
      origin: "clawchat",
      deliveryConfirmation,
      clawchat: {
        chatId: "group-conversation",
        chatType: "group",
        sourceMessageId: "message-group",
      },
    });
    while (sent.length === 0) await Bun.sleep(0);

    const response = router.handleMessage(groupMessage("member-1", "/deny"));
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "deny" });
    rejectDelivery(new Error("native transport failed"));
    await expect(response).resolves.toBe(true);
    expect(sent.at(-1)?.fragments).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "Session ABCDEFGH failed: Runtime response delivery was not confirmed.",
      }),
    ]);
  });

  it("does not guess between multiple compatible group approvals", async () => {
    const sent: Array<{ fragments: Fragment[] }> = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    let settled = 0;
    const context = {
      sessionRef: "ABCDEFGH",
      origin: "clawchat" as const,
      deliveryConfirmation: Promise.resolve(),
      clawchat: {
        chatId: "group-conversation",
        chatType: "group" as const,
        sourceMessageId: "message-group",
      },
    };
    const first = router
      .request(approvalRequest(), { ...context, turnId: "turn-first" })
      .then(() => {
        settled += 1;
      })
      .catch(() => undefined);
    const second = router
      .request(approvalRequest(), { ...context, turnId: "turn-second" })
      .then(() => {
        settled += 1;
      })
      .catch(() => undefined);
    while (sent.length < 2) await Bun.sleep(0);

    await expect(router.handleMessage(groupMessage("member-1", "/approve"))).resolves.toBe(true);
    await Bun.sleep(0);
    expect(settled).toBe(0);
    expect(sent.at(-1)?.fragments).toEqual([
      expect.objectContaining({ kind: "text", text: expect.stringContaining("multiple pending approvals") }),
    ]);

    await router.close();
    await Promise.all([first, second]);
  });

  it("reserves group response commands when no Interaction is pending", async () => {
    const sent: Array<{ fragments: Fragment[] }> = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });

    await expect(router.handleMessage(groupMessage("member-1", "/approve"))).resolves.toBe(true);
    expect(sent).toEqual([
      expect.objectContaining({
        fragments: [
          expect.objectContaining({
            kind: "text",
            text: expect.stringContaining("No pending approval"),
          }),
        ],
      }),
    ]);
  });

  it("rejects non-canonical approval command casing without settling", async () => {
    const sent: Array<{ fragments: Fragment[] }> = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    let settled = false;
    const result = router
      .request(approvalRequest(), {
        sessionRef: "ABCDEFGH",
        turnId: "turn-case",
        origin: "clawchat",
        deliveryConfirmation: Promise.resolve(),
        clawchat: {
          chatId: "group-conversation",
          chatType: "group",
          sourceMessageId: "message-group",
        },
      })
      .then((response) => {
        settled = true;
        return response;
      });
    while (sent.length === 0) await Bun.sleep(0);

    await expect(router.handleMessage(groupMessage("member-1", "/APPROVE"))).resolves.toBe(true);
    expect(settled).toBe(false);
    expect(sent.at(-1)?.fragments).toEqual([expect.objectContaining({ kind: "text", text: "Usage: @Agent /approve" })]);

    await expect(router.handleMessage(groupMessage("member-1", "/approve"))).resolves.toBe(true);
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "approve-once" });
  });

  it("collects multi-step Agent answers in ClawChat before resuming Codex", async () => {
    const sent: Fragment[][] = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery.fragments);
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
      {
        sessionRef: "ABCDEFGH",
        turnId: "turn-question",
        origin: "clawchat",
        deliveryConfirmation: Promise.resolve(),
        clawchat: {
          chatId: "owner-conversation",
          chatType: "direct",
          sourceMessageId: "message-direct",
        },
      },
    );
    while (sent.length === 0) await Bun.sleep(0);
    expect(sent[0]).toEqual([{ kind: "text", text: "颜色：选择颜色\n\n/1 红色\n/2 蓝色" }]);
    await expect(router.handleMessage(message("owner-1", "/02"))).resolves.toBe(true);
    expect(sent.at(-1)).toEqual([
      expect.objectContaining({ kind: "text", text: expect.stringContaining("/1 红色\n/2 蓝色") }),
    ]);
    await expect(router.handleMessage(message("owner-1", "/2"))).resolves.toBe(true);
    while (sent.length < 3) await Bun.sleep(0);
    expect(sent[2]).toEqual([expect.objectContaining({ kind: "text", text: expect.stringContaining("请输入备注") })]);
    await expect(router.handleMessage(message("owner-1", "今天发布"))).resolves.toBe(false);
    await expect(router.handleMessage(message("owner-1", "/answer 今天发布"))).resolves.toBe(true);
    await expect(result).resolves.toEqual({
      kind: "user-input",
      answers: { color: ["蓝色"], note: ["今天发布"] },
    });
  });

  it("accepts an explicit custom answer when the current choice allows Other", async () => {
    const sent: Fragment[][] = [];
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery.fragments);
      },
    });
    const result = router.request(
      {
        kind: "user-input",
        title: "Codex 需要你的回答",
        description: "选择颜色。",
        questions: [
          {
            id: "color",
            header: "颜色",
            prompt: "选择或输入颜色",
            secret: false,
            allowOther: true,
            options: [{ id: "red", label: "红色" }],
          },
        ],
        autoResolutionMs: null,
      },
      {
        sessionRef: "ABCDEFGH",
        turnId: "turn-other",
        origin: "clawchat",
        deliveryConfirmation: Promise.resolve(),
        clawchat: {
          chatId: "owner-conversation",
          chatType: "direct",
          sourceMessageId: "message-direct",
        },
      },
    );
    while (sent.length === 0) await Bun.sleep(0);

    await expect(router.handleMessage(message("owner-1", "/answer 紫色"))).resolves.toBe(true);
    await expect(result).resolves.toEqual({
      kind: "user-input",
      answers: { color: ["紫色"] },
    });
  });

  it("publishes a terminal group state when the originating Turn ends", async () => {
    const sent: Array<{ chatId: string; fragments: Fragment[] }> = [];
    const controller = new AbortController();
    const router = new RuntimeInteractionRouter({
      clientPort: { request: mock() } as RuntimeInteractionPort,
      ownerUserId: "owner-1",
      ownerConversationId: "owner-conversation",
      agentUserId: "agent-1",
      sendClawChatMessage: async (delivery) => {
        sent.push(delivery);
      },
    });
    const result = router.request(approvalRequest(), {
      sessionRef: "ABCDEFGH",
      turnId: "turn-aborted",
      origin: "clawchat",
      signal: controller.signal,
      deliveryConfirmation: Promise.resolve(),
      clawchat: {
        chatId: "group-conversation",
        chatType: "group",
        sourceMessageId: "message-group",
      },
    });
    while (sent.length === 0) await Bun.sleep(0);

    controller.abort();
    await expect(result).rejects.toThrow("Runtime request ended");
    while (sent.length < 2) await Bun.sleep(0);
    expect(sent.at(-1)).toMatchObject({
      chatId: "group-conversation",
      fragments: [
        expect.objectContaining({
          kind: "text",
          text: expect.stringContaining("Session ABCDEFGH cancelled: Runtime request ended"),
        }),
      ],
    });
    await expect(router.handleMessage(groupMessage("member-1", "/approve"))).resolves.toBe(true);
  });
});
