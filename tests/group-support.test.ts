import { expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawChatApiClient } from "../src/api-client";
import { startBindingRuntime } from "../src/binding-runtime";
import { defaultConfig } from "../src/config";
import { type GroupIntakeClock, GroupIntakeCoordinator } from "../src/group-intake";
import { normalizeInboundMessage } from "../src/message-mapper";
import { ProjectCatalog } from "../src/projects";
import {
  type Envelope,
  EVENT,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/protocol";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import type { ConnectRuntimePrompt } from "../src/runtime/types";
import { createStateStore, type GroupSettingsRecord } from "../src/state";
import { fixedRuntimeAdapter } from "./runtime-adapter-fixture";

class MemoryTransport implements Transport {
  state: TransportState = "closed";
  handlers: TransportEvents | null = null;
  sent: Envelope[] = [];

  async connect(_url: string, handlers: TransportEvents): Promise<void> {
    this.state = "open";
    this.handlers = handlers;
    handlers.onOpen();
  }

  send(data: string): void {
    this.sent.push(parseEnvelope(data));
  }

  close(): void {
    this.state = "closed";
  }

  receive(envelope: Envelope): void {
    this.handlers?.onMessage(JSON.stringify(envelope));
  }
}

class ManualClock implements GroupIntakeClock {
  private nextTimerId = 1;
  private readonly timers = new Map<number, { deadline: number; callback: () => void }>();

  constructor(private currentTime: number) {}

  now(): number {
    return this.currentTime;
  }

  setTimer(callback: () => void, delayMilliseconds: number): number {
    const timerId = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(timerId, { deadline: this.currentTime + Math.max(0, delayMilliseconds), callback });
    return timerId;
  }

  clearTimer(timer: unknown): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }

  advance(milliseconds: number): void {
    const target = this.currentTime + milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.deadline <= target)
        .sort((left, right) => left[1].deadline - right[1].deadline || left[0] - right[0])[0];
      if (!due) break;
      this.currentTime = due[1].deadline;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.currentTime = target;
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(2);
  }
  throw new Error("timed out waiting for group protocol outcome");
}

function groupMessage(params: {
  id: string;
  text: string;
  chatId?: string;
  mentioned?: boolean;
  emittedAt?: number;
  dseq?: number;
  senderId?: string;
}): Envelope {
  const fragments = params.mentioned
    ? [
        { kind: "mention", user_id: "agent-user", display: "Work" },
        { kind: "text", text: ` ${params.text}` },
      ]
    : [{ kind: "text", text: params.text }];
  return {
    version: "2",
    event: EVENT.MESSAGE_SEND,
    trace_id: `trace-${params.id}`,
    emitted_at: params.emittedAt ?? 10,
    dseq: params.dseq ?? 1,
    chat_id: params.chatId ?? "group-1",
    chat_type: "group",
    sender: {
      id: params.senderId ?? "member-1",
      type: "direct",
      nick_name: params.senderId === "owner-user" ? "Owner" : "Member",
    },
    payload: {
      message_id: params.id,
      message_mode: "normal",
      message: {
        body: { fragments },
        context: {
          mentions: params.mentioned ? [{ user_id: "agent-user", display: "Work" }] : [],
          reply: null,
        },
        streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
      },
    },
  };
}

function directMessage(params: { id: string; text: string; dseq: number }): Envelope {
  return {
    version: "2",
    event: EVENT.MESSAGE_SEND,
    trace_id: `trace-${params.id}`,
    emitted_at: Date.now(),
    dseq: params.dseq,
    chat_id: "direct-owner",
    chat_type: "direct",
    sender: { id: "owner-user", type: "direct", nick_name: "Owner" },
    payload: {
      message_id: params.id,
      message_mode: "normal",
      message: {
        body: { fragments: [{ kind: "text", text: params.text }] },
        context: { mentions: [], reply: null },
        streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
      },
    },
  };
}

it("applies a persisted real-time all-message group policy without changing direct routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-support-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-1",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 1,
    },
    {
      conversationId: "group-delayed",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
  ]);
  const config = defaultConfig();
  const clock = new ManualClock(Date.now());
  config.defaultAgent = "work";
  config.agents = { work: { kind: "codex", displayName: "Work" } };
  const prompts: ConnectRuntimePrompt[] = [];
  let refuseRuntimeTurnOnce = true;
  const runtimeAdapters = new RuntimeAdapterRegistry([
    fixedRuntimeAdapter({
      kind: "codex",
      modes: ["read-only"],
      start: async () => ({
        prompt: async function* (input) {
          prompts.push(input);
          if (input.prompt.includes("reject this turn once") && refuseRuntimeTurnOnce) {
            refuseRuntimeTurnOnce = false;
            throw new Error("transient Runtime refusal");
          }
          await input.onAccepted?.();
          if (input.prompt.includes("silent please")) {
            yield {
              id: "silent-draft",
              position: "0.0",
              parentId: null,
              kind: "assistant",
              text: "draft that must stay buffered",
              state: "complete",
              source: "live",
              data: { outputKind: "assistant" },
            } as const;
            yield {
              id: "silent-final",
              position: "0.1",
              parentId: null,
              kind: "assistant",
              text: "<clawchat:no-reply/>",
              state: "complete",
              source: "live",
              data: { outputKind: "final" },
            } as const;
            return;
          }
          yield {
            id: "answer",
            position: "0.0",
            parentId: null,
            kind: "assistant",
            text: "group answer",
            state: "complete",
            source: "live",
            data: { outputKind: "final" },
          } as const;
        },
        close: mock(async () => undefined),
      }),
    }),
  ]);
  const transport = new MemoryTransport();
  const errors: string[] = [];
  let remoteRows: GroupSettingsRecord[] = [
    {
      conversationId: "group-1",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 1,
    },
    {
      conversationId: "group-delayed",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
    {
      conversationId: "group-timer",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 1,
      version: 1,
    },
  ];
  let groupSettingsReads = 0;
  let blockNextGroupSettingsRead = false;
  let releaseBlockedGroupSettingsRead: (() => void) | undefined;
  const clawChatApi = {
    agentsConnect: async () => ({}),
    getUserProfile: async () => ({ nickname: null }),
    updateMyProfile: async () => undefined,
    getMyGroupSettings: async () => {
      groupSettingsReads += 1;
      if (blockNextGroupSettingsRead) {
        blockNextGroupSettingsRead = false;
        await new Promise<void>((resolve) => {
          releaseBlockedGroupSettingsRead = resolve;
        });
      }
      return { authoritative: true, rows: remoteRows };
    },
  } satisfies ClawChatApiClient;
  const starting = startBindingRuntime({
    agentId: "work",
    activation: {
      localAgentId: "work",
      accessToken: "token",
      refreshToken: null,
      serverAgentId: "agent-server",
      userId: "agent-user",
      ownerUserId: "owner-user",
      conversationId: "owner-chat",
    },
    config,
    configPath: join(directory, "config.json"),
    deviceId: "device-local",
    stateStore,
    projects: new ProjectCatalog(stateStore),
    runtimeAdapters,
    wsTransport: transport,
    groupIntakeClock: clock,
    clawChatApi,
    verifyInstalledSkills: async () => undefined,
    writeError: (message) => errors.push(message),
  });
  await flush();
  transport.receive({
    version: "2",
    event: EVENT.CONNECT_CHALLENGE,
    trace_id: "challenge",
    emitted_at: 1,
    payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
  });
  await flush();
  const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
  if (!connect) throw new Error("connect frame was not sent");
  transport.receive({
    version: "2",
    event: EVENT.HELLO_OK,
    trace_id: connect.trace_id,
    emitted_at: 2,
    payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
  });
  const handle = await starting;

  transport.receive(groupMessage({ id: "group-message-1", text: "hello everyone" }));
  await Bun.sleep(20);
  expect(errors).toEqual([]);
  const prompt = await waitFor(() => prompts[0]);
  expect(prompt.prompt).toContain("hello everyone");
  expect(prompt.prompt).toContain("<clawchat_group_response_protocol>");
  expect(prompt.prompt).toContain("<clawchat:no-reply/>");
  const reply = await waitFor(() =>
    transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-1"),
  );
  expect(reply.payload).toMatchObject({
    message: { context: { reply: { reply_to_msg_id: "group-message-1" } } },
  });
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: reply.trace_id,
    emitted_at: 11,
    chat_id: "group-1",
    payload: { message_id: "reply-1", accepted_at: 11 },
  });

  transport.receive(
    groupMessage({
      id: "batch-message-1",
      text: "first idea",
      chatId: "group-delayed",
      emittedAt: Date.now(),
      dseq: 2,
    }),
  );
  await Bun.sleep(20);
  expect(prompts).toHaveLength(1);
  transport.receive(
    groupMessage({
      id: "batch-message-2",
      text: "please respond",
      chatId: "group-delayed",
      mentioned: true,
      emittedAt: Date.now() + 1,
      dseq: 3,
    }),
  );
  const batchPrompt = await waitFor(() => prompts[1]);
  expect(batchPrompt.prompt).toContain("[message 1] Member: first idea");
  expect(batchPrompt.prompt).toContain("[message 2] Member: please respond");
  expect(batchPrompt.prompt).toContain('"message_id":"batch-message-1"');
  expect(batchPrompt.prompt).toContain('"message_id":"batch-message-2"');
  const batchReply = await waitFor(() =>
    transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-delayed"),
  );
  expect(batchReply.payload).toMatchObject({
    message: { context: { reply: { reply_to_msg_id: "batch-message-2" } } },
  });
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: batchReply.trace_id,
    emitted_at: 22,
    chat_id: "group-delayed",
    payload: { message_id: "batch-reply", accepted_at: 22 },
  });

  const pendingSettingsMessage = groupMessage({
    id: "pending-settings-message",
    text: "pending before settings change",
    chatId: "group-delayed",
    emittedAt: Date.now(),
    dseq: 4,
  });
  transport.receive(pendingSettingsMessage);
  await Bun.sleep(20);
  expect(prompts).toHaveLength(2);

  remoteRows = [
    {
      conversationId: "group-1",
      muted: true,
      replyMode: "mention",
      batchDelaySeconds: 0,
      version: 2,
    },
    {
      conversationId: "group-rollover",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 2,
    },
    {
      conversationId: "group-oversize",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 2,
    },
    {
      conversationId: "group-refusal",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 2,
    },
    {
      conversationId: "group-timer",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 1,
      version: 2,
    },
  ];
  const readsBeforeInvalidation = groupSettingsReads;
  blockNextGroupSettingsRead = true;
  transport.receive({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "settings-changed",
    emitted_at: 23,
    dseq: 5,
    payload: {
      type: "agent.config.changed",
      entity_id: "agent-server",
      version: 2,
      event_id: "settings-event-2",
      message_id: "settings-message-2",
    },
  });
  await waitFor(() => (groupSettingsReads === readsBeforeInvalidation + 1 ? true : undefined));
  transport.receive({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "settings-changed-again",
    emitted_at: 24,
    dseq: 6,
    payload: {
      type: "agent.config.changed",
      entity_id: "agent-server",
      version: 3,
      event_id: "settings-event-3",
      message_id: "settings-message-3",
    },
  });
  const gatedGroupMessage = groupMessage({
    id: "gated-group-message",
    text: "must use safe mention-only fallback",
    chatId: "group-oversize",
    dseq: 7,
  });
  transport.receive(gatedGroupMessage);
  transport.receive(directMessage({ id: "direct-during-group-refresh", text: "private request", dseq: 8 }));
  const directPrompt = await waitFor(() => prompts.find((candidate) => candidate.prompt.endsWith("private request")));
  expect(directPrompt.prompt).not.toContain("<clawchat_group_response_protocol>");
  const directReply = await waitFor(() =>
    transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "direct-owner"),
  );
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: directReply.trace_id,
    emitted_at: 25,
    chat_id: "direct-owner",
    payload: { message_id: "direct-reply", accepted_at: 25 },
  });
  clock.advance(4_999);
  await flush();
  await expect(stateStore.hasHandledInboundMessage("work", "gated-group-message", gatedGroupMessage)).resolves.toBe(
    false,
  );
  clock.advance(1);
  await waitFor(async () =>
    (await stateStore.hasHandledInboundMessage("work", "gated-group-message", gatedGroupMessage)) ? true : undefined,
  );
  releaseBlockedGroupSettingsRead?.();
  await waitFor(() => (groupSettingsReads >= readsBeforeInvalidation + 2 ? true : undefined));
  await waitFor(async () => {
    const snapshot = await stateStore.getGroupSettingsSnapshot("work");
    return snapshot.rows[0]?.version === 2 && !snapshot.stale ? snapshot : undefined;
  });
  await expect(
    stateStore.hasHandledInboundMessage("work", "pending-settings-message", pendingSettingsMessage),
  ).resolves.toBe(true);
  transport.receive(groupMessage({ id: "muted-message", text: "do not answer", dseq: 9 }));
  await Bun.sleep(20);
  expect(prompts).toHaveLength(3);
  await expect(
    stateStore.hasHandledInboundMessage(
      "work",
      "muted-message",
      groupMessage({
        id: "muted-message",
        text: "do not answer",
        dseq: 9,
      }),
    ),
  ).resolves.toBe(true);

  const promptsBeforeOversize = prompts.length;
  transport.receive(
    groupMessage({
      id: "oversize-message",
      text: "x".repeat(64_000),
      chatId: "group-oversize",
      dseq: 10,
    }),
  );
  const oversizeReply = await waitFor(() =>
    transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-oversize"),
  );
  expect(JSON.stringify(oversizeReply.payload)).toContain("64,000-character");
  expect(prompts).toHaveLength(promptsBeforeOversize);
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: oversizeReply.trace_id,
    emitted_at: 26,
    chat_id: "group-oversize",
    payload: { message_id: "oversize-reply", accepted_at: 26 },
  });

  transport.receive(
    groupMessage({ id: "context-message", text: "the deployment is tonight", chatId: "group-context", dseq: 11 }),
  );
  await Bun.sleep(20);
  expect(prompts).toHaveLength(3);
  transport.receive(
    groupMessage({
      id: "mentioned-message",
      text: "what do you think?",
      chatId: "group-context",
      mentioned: true,
      dseq: 12,
    }),
  );
  const mentionedPrompt = await waitFor(() => prompts[3]);
  expect(mentionedPrompt.prompt).toContain('"recent_group_context"');
  expect(mentionedPrompt.prompt).toContain("the deployment is tonight");
  expect(mentionedPrompt.prompt).toContain("what do you think?");
  const mentionedReply = await waitFor(() =>
    transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-context"),
  );
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: mentionedReply.trace_id,
    emitted_at: 24,
    chat_id: "group-context",
    payload: { message_id: "mentioned-reply", accepted_at: 24 },
  });

  const repliesBeforeSilence = transport.sent.filter((event) => event.event === EVENT.MESSAGE_REPLY).length;
  const silentMessage = groupMessage({
    id: "silent-message",
    text: "silent please",
    chatId: "group-silent",
    mentioned: true,
    dseq: 13,
  });
  transport.receive(silentMessage);
  const silentPrompt = await waitFor(() => prompts[4]);
  expect(silentPrompt.prompt).toContain("silent please");
  await waitFor(async () =>
    (await stateStore.hasHandledInboundMessage("work", "silent-message", silentMessage)) ? true : undefined,
  );
  await Bun.sleep(20);
  expect(transport.sent.filter((event) => event.event === EVENT.MESSAGE_REPLY)).toHaveLength(repliesBeforeSilence);

  const rolloverFirstText = `rollover-first-${"a".repeat(20_000)}`;
  const rolloverSecondText = `rollover-second-${"b".repeat(20_000)}`;
  transport.receive(
    groupMessage({
      id: "rollover-first",
      text: rolloverFirstText,
      chatId: "group-rollover",
      emittedAt: clock.now(),
      dseq: 14,
    }),
  );
  await flush();
  transport.receive(
    groupMessage({
      id: "rollover-second",
      text: rolloverSecondText,
      chatId: "group-rollover",
      emittedAt: clock.now() + 1,
      dseq: 15,
    }),
  );
  const rolloverFirstPrompt = await waitFor(() =>
    prompts.find((candidate) => candidate.prompt.includes("rollover-first-")),
  );
  expect(rolloverFirstPrompt.prompt).not.toContain("rollover-second-");
  const rolloverFirstReply = await waitFor(() =>
    transport.sent.findLast((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-rollover"),
  );
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: rolloverFirstReply.trace_id,
    emitted_at: 27,
    chat_id: "group-rollover",
    payload: { message_id: "rollover-first-reply", accepted_at: 27 },
  });
  await waitFor(async () =>
    (await stateStore.hasHandledInboundMessage(
      "work",
      "rollover-first",
      groupMessage({
        id: "rollover-first",
        text: rolloverFirstText,
        chatId: "group-rollover",
        emittedAt: clock.now(),
        dseq: 14,
      }),
    ))
      ? true
      : undefined,
  );
  const promptsBeforeInspectionCommand = prompts.length;
  transport.receive(
    groupMessage({
      id: "rollover-status",
      text: "/status",
      chatId: "group-rollover",
      mentioned: true,
      emittedAt: clock.now() + 2,
      dseq: 16,
      senderId: "owner-user",
    }),
  );
  const statusReply = await waitFor(() => {
    const replies = transport.sent.filter(
      (event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-rollover",
    );
    return replies.length >= 2 ? replies.at(-1) : undefined;
  });
  expect(JSON.stringify(statusReply.payload)).toContain("ClawChat Connect status");
  expect(prompts).toHaveLength(promptsBeforeInspectionCommand);
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: statusReply.trace_id,
    emitted_at: 28,
    chat_id: "group-rollover",
    payload: { message_id: "rollover-status-reply", accepted_at: 28 },
  });
  transport.receive(
    groupMessage({
      id: "rollover-third",
      text: "flush the second intact batch",
      chatId: "group-rollover",
      mentioned: true,
      emittedAt: clock.now() + 3,
      dseq: 17,
    }),
  );
  const rolloverSecondPrompt = await waitFor(() =>
    prompts.find((candidate) => candidate.prompt.includes("rollover-second-")),
  );
  expect(rolloverSecondPrompt.prompt).toContain("flush the second intact batch");
  expect(rolloverSecondPrompt.prompt).not.toContain("/status");
  const rolloverSecondReply = await waitFor(() => {
    const replies = transport.sent.filter(
      (event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-rollover",
    );
    return replies.length >= 3 ? replies.at(-1) : undefined;
  });
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: rolloverSecondReply.trace_id,
    emitted_at: 29,
    chat_id: "group-rollover",
    payload: { message_id: "rollover-second-reply", accepted_at: 29 },
  });

  const refusedMessage = groupMessage({
    id: "refused-message",
    text: "reject this turn once",
    chatId: "group-refusal",
    dseq: 18,
  });
  transport.receive(refusedMessage);
  await waitFor(() => prompts.find((candidate) => candidate.prompt.includes("reject this turn once")));
  const refusalReply = await waitFor(() =>
    transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-refusal"),
  );
  expect(JSON.stringify(refusalReply.payload)).toContain("transient Runtime refusal");
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: refusalReply.trace_id,
    emitted_at: 27,
    chat_id: "group-refusal",
    payload: { message_id: "refusal-reply", accepted_at: 27 },
  });
  await expect(stateStore.hasHandledInboundMessage("work", "refused-message", refusedMessage)).resolves.toBe(false);

  const promptsBeforeTimer = prompts.length;
  transport.receive(
    groupMessage({
      id: "timer-message",
      text: "flush after the idle deadline",
      chatId: "group-timer",
      emittedAt: clock.now(),
      dseq: 19,
    }),
  );
  await flush();
  clock.advance(999);
  await flush();
  expect(prompts).toHaveLength(promptsBeforeTimer);
  clock.advance(1);
  const timerPrompt = await waitFor(() => prompts.find((candidate) => candidate.prompt.includes("idle deadline")));
  expect(timerPrompt.prompt).toContain("flush after the idle deadline");
  const timerReply = await waitFor(() =>
    transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-timer"),
  );
  transport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: timerReply.trace_id,
    emitted_at: 28,
    chat_id: "group-timer",
    payload: { message_id: "timer-reply", accepted_at: 28 },
  });

  await handle.close();

  remoteRows = [
    {
      conversationId: "group-recovery",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 3,
    },
    {
      conversationId: "group-refusal",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 3,
    },
  ];
  await stateStore.replaceGroupSettingsSnapshot("work", remoteRows);
  const overdue = groupMessage({
    id: "overdue-message",
    text: "recover this batch",
    chatId: "group-recovery",
    emittedAt: Date.now() - 61_000,
    dseq: 1,
  });
  await stateStore.upsertInboundMessage({
    agentId: "work",
    direction: "inbound",
    kind: "message",
    eventType: EVENT.MESSAGE_SEND,
    traceId: overdue.trace_id,
    chatId: overdue.chat_id,
    messageId: "overdue-message",
    text: "recover this batch",
    raw: overdue,
  });
  const recoveryTransport = new MemoryTransport();
  const recoveryStarting = startBindingRuntime({
    agentId: "work",
    activation: {
      localAgentId: "work",
      accessToken: "token",
      refreshToken: null,
      serverAgentId: "agent-server",
      userId: "agent-user",
      ownerUserId: "owner-user",
      conversationId: "owner-chat",
    },
    config,
    configPath: join(directory, "config.json"),
    deviceId: "device-local",
    stateStore,
    projects: new ProjectCatalog(stateStore),
    runtimeAdapters,
    wsTransport: recoveryTransport,
    groupIntakeClock: clock,
    clawChatApi,
    verifyInstalledSkills: async () => undefined,
    writeError: (message) => errors.push(message),
  });
  await flush();
  recoveryTransport.receive({
    version: "2",
    event: EVENT.CONNECT_CHALLENGE,
    trace_id: "challenge",
    emitted_at: 30,
    payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
  });
  await flush();
  const recoveryConnect = recoveryTransport.sent.find((event) => event.event === EVENT.CONNECT);
  if (!recoveryConnect) throw new Error("recovery connect frame was not sent");
  recoveryTransport.receive({
    version: "2",
    event: EVENT.HELLO_OK,
    trace_id: recoveryConnect.trace_id,
    emitted_at: 31,
    payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AC" },
  });
  const recoveryHandle = await recoveryStarting;
  const refusedRecoveryPrompt = await waitFor(() => {
    const matches = prompts.filter((candidate) => candidate.prompt.includes("reject this turn once"));
    return matches.length >= 2 ? matches.at(-1) : undefined;
  });
  expect(refusedRecoveryPrompt.prompt).toContain("reject this turn once");
  const refusedRecoveryReply = await waitFor(() =>
    recoveryTransport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-refusal"),
  );
  recoveryTransport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: refusedRecoveryReply.trace_id,
    emitted_at: 32,
    chat_id: "group-refusal",
    payload: { message_id: "refused-recovery-reply", accepted_at: 32 },
  });
  await expect(stateStore.hasHandledInboundMessage("work", "refused-message", refusedMessage)).resolves.toBe(true);
  clock.advance(0);
  await flush();
  const recoveryPrompt = await waitFor(() =>
    prompts.find((candidate) => candidate.prompt.includes("recover this batch")),
  );
  expect(recoveryPrompt.prompt).toContain("recover this batch");
  const recoveryReply = await waitFor(() =>
    recoveryTransport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "group-recovery"),
  );
  recoveryTransport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: recoveryReply.trace_id,
    emitted_at: 32,
    chat_id: "group-recovery",
    payload: { message_id: "recovery-reply", accepted_at: 32 },
  });
  await expect(stateStore.hasHandledInboundMessage("work", "overdue-message", overdue)).resolves.toBe(true);
  await recoveryHandle.close();
  await runtimeAdapters.close();
  await stateStore.close();
});

it("keeps a startup configuration invalidation stale after persisted settings finish loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-startup-invalidation-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-1",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 1,
    },
  ]);
  const originalSnapshotRead = stateStore.getGroupSettingsSnapshot.bind(stateStore);
  let signalSnapshotRead: (() => void) | undefined;
  const snapshotReadStarted = new Promise<void>((resolve) => {
    signalSnapshotRead = resolve;
  });
  let releaseSnapshotRead: (() => void) | undefined;
  const snapshotReadGate = new Promise<void>((resolve) => {
    releaseSnapshotRead = resolve;
  });
  stateStore.getGroupSettingsSnapshot = async (bindingId) => {
    signalSnapshotRead?.();
    await snapshotReadGate;
    return await originalSnapshotRead(bindingId);
  };
  let runtimeDispatches = 0;
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async () => {
      runtimeDispatches += 1;
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const initialization = coordinator.initialize();
  await snapshotReadStarted;
  const invalidation = coordinator.handleNotifySignal({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "startup-settings-change",
    emitted_at: 1,
    payload: { type: "agent.config.changed", event_id: "startup-settings-event" },
  });
  releaseSnapshotRead?.();
  await Promise.all([initialization, invalidation]);

  const envelope = groupMessage({ id: "startup-stale-message", text: "not mentioned" });
  const message = normalizeInboundMessage(envelope);
  if (!message) throw new Error("group fixture did not normalize");
  await stateStore.upsertInboundMessage({
    agentId: "work",
    direction: "inbound",
    kind: "message",
    eventType: EVENT.MESSAGE_SEND,
    traceId: envelope.trace_id,
    chatId: envelope.chat_id,
    messageId: message.messageId,
    text: message.text,
    raw: envelope,
  });
  await coordinator.accept(message);

  expect(runtimeDispatches).toBe(0);
  await expect(stateStore.hasHandledInboundMessage("work", message.messageId, envelope)).resolves.toBe(true);
  await coordinator.close();
  await stateStore.close();
});
