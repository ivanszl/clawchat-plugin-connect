import { expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawChatApiClient } from "../src/clawchat/api-client";
import { type GroupIntakeClock, GroupIntakeCoordinator } from "../src/clawchat/group-intake";
import { inboundContentDigest } from "../src/clawchat/inbound-identity";
import { normalizeInboundMessage } from "../src/clawchat/message-mapper";
import {
  type Envelope,
  EVENT,
  type Fragment,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/clawchat/protocol";
import { defaultConfig } from "../src/config";
import { createStateStore, type GroupSettingsRecord } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import {
  type ConnectRuntimePrompt,
  type RuntimeInputIdentity,
  runtimeInputIdentityContains,
} from "../src/runtime/types";
import { startBindingRuntime } from "../src/service/binding-runtime";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { fixedRuntimeAdapter, pluginBinding } from "./runtime-adapter-fixture";

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
  attachmentCount?: number;
}): Envelope {
  const fragments: Fragment[] = params.mentioned
    ? [
        { kind: "mention", user_id: "agent-user", display: "Work" },
        { kind: "text", text: ` ${params.text}` },
      ]
    : [{ kind: "text", text: params.text }];
  for (let index = 0; index < (params.attachmentCount ?? 0); index += 1) {
    fragments.push({
      kind: "file",
      url: `https://media.example/${params.id}-${index}.bin`,
      name: `${params.id}-${index}.bin`,
    });
  }
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
  config.agents = { work: pluginBinding({}, { displayName: "Work" }) };
  const prompts: ConnectRuntimePrompt[] = [];
  let acceptedRecoveryIdentity: RuntimeInputIdentity | null = null;
  let refuseRuntimeTurnOnce = true;
  const runtimeAdapters = new RuntimeAdapterRegistry([
    fixedRuntimeAdapter({
      kind: "codex",
      modes: ["read-only"],
      reconcileInput: async (_binding, runtimeThreadId, candidate) =>
        runtimeThreadId === "thread-accepted-batch" &&
        acceptedRecoveryIdentity &&
        runtimeInputIdentityContains(acceptedRecoveryIdentity, candidate)
          ? { outcome: "accepted", identity: acceptedRecoveryIdentity }
          : { outcome: "absent" },
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
    workspaces: new WorkspaceCatalog(stateStore),
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
  const mentionedContext = JSON.parse(mentionedPrompt.prompt.split("\n")[1] ?? "null") as {
    content_digest?: string;
    recent_group_context?: Array<{ content_digest?: string }>;
  };
  expect(mentionedContext.content_digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(mentionedContext.recent_group_context?.[0]?.content_digest).toMatch(/^[a-f0-9]{64}$/u);
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
  transport.receive(
    groupMessage({
      id: "rollover-concurrent",
      text: "arrived while the preceding batch was submitting",
      chatId: "group-rollover",
      emittedAt: clock.now() + 2,
      dseq: 16,
    }),
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
      emittedAt: clock.now() + 3,
      dseq: 17,
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
      emittedAt: clock.now() + 4,
      dseq: 18,
    }),
  );
  const rolloverSecondPrompt = await waitFor(() =>
    prompts.find((candidate) => candidate.prompt.includes("rollover-second-")),
  );
  expect(rolloverSecondPrompt.prompt).toContain("flush the second intact batch");
  expect(rolloverSecondPrompt.prompt).toContain("arrived while the preceding batch was submitting");
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
    dseq: 19,
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
      dseq: 20,
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
    {
      conversationId: "group-startup-muted",
      muted: true,
      replyMode: "mention",
      batchDelaySeconds: 0,
      version: 3,
    },
  ];
  await stateStore.replaceGroupSettingsSnapshot("work", [
    ...remoteRows.filter((row) => row.conversationId !== "group-startup-muted"),
    {
      conversationId: "group-startup-muted",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 2,
    },
  ]);
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
  await stateStore.upsertRuntimeSession({
    chatId: "group-recovery",
    sessionId: "session-from-failed-group-submit",
    agentId: "work",
    runtimeSessionId: "thread-from-failed-group-submit",
    isCurrent: true,
    hasMessages: true,
  });
  const failedGroupSession = await stateStore.getCurrentRuntimeSession("group-recovery", "work");
  if (!failedGroupSession) throw new Error("expected failed group Session");
  await stateStore.upsertTranscriptBlock(failedGroupSession.sessionRef, {
    id: "b_failed_group_submit",
    type: "message",
    origin: "clawchat",
    state: "complete",
    plainText: "recover this batch",
    role: "user",
    author: "ClawChat",
    markdown: "recover this batch",
  });
  const startupMuted = groupMessage({
    id: "startup-muted-message",
    text: "must wait for authoritative startup settings",
    chatId: "group-startup-muted",
    emittedAt: Date.now() - 1_000,
    dseq: 2,
  });
  await stateStore.upsertInboundMessage({
    agentId: "work",
    direction: "inbound",
    kind: "message",
    eventType: EVENT.MESSAGE_SEND,
    traceId: startupMuted.trace_id,
    chatId: startupMuted.chat_id,
    messageId: "startup-muted-message",
    text: "must wait for authoritative startup settings",
    raw: startupMuted,
  });
  const acceptedContext = groupMessage({
    id: "accepted-context",
    text: "read-only background",
    chatId: "group-accepted",
    emittedAt: Date.now() - 3_000,
    dseq: 20,
  });
  const acceptedFirst = groupMessage({
    id: "accepted-first",
    text: "first accepted batch input",
    chatId: "group-accepted",
    emittedAt: Date.now() - 2_000,
    dseq: 21,
  });
  const acceptedAnchor = groupMessage({
    id: "accepted-anchor",
    text: "second accepted batch input",
    chatId: "group-accepted",
    emittedAt: Date.now() - 1_000,
    dseq: 22,
  });
  for (const [message, messageId, text] of [
    [acceptedContext, "accepted-context", "read-only background"],
    [acceptedFirst, "accepted-first", "first accepted batch input"],
    [acceptedAnchor, "accepted-anchor", "second accepted batch input"],
  ] as const) {
    await stateStore.upsertInboundMessage({
      agentId: "work",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: message.trace_id,
      chatId: message.chat_id,
      messageId,
      text,
      raw: message,
    });
  }
  await stateStore.markInboundMessageHandled("work", "accepted-context", acceptedContext, "mention-context");
  acceptedRecoveryIdentity = {
    origin: "clawchat",
    anchor: { messageId: "accepted-anchor", contentDigest: inboundContentDigest(acceptedAnchor) },
    actionable: [
      { messageId: "accepted-first", contentDigest: inboundContentDigest(acceptedFirst) },
      { messageId: "accepted-anchor", contentDigest: inboundContentDigest(acceptedAnchor) },
    ],
    context: [{ messageId: "accepted-context", contentDigest: inboundContentDigest(acceptedContext) }],
  };
  await stateStore.upsertRuntimeSession({
    chatId: "group-accepted",
    sessionId: "session-accepted-batch",
    agentId: "work",
    runtimeSessionId: "thread-accepted-batch",
    isCurrent: true,
    hasMessages: true,
  });
  const directRecovery = directMessage({
    id: "direct-recovery-message",
    text: "private recovery must not wait for group settings",
    dseq: 3,
  });
  await stateStore.upsertInboundMessage({
    agentId: "work",
    direction: "inbound",
    kind: "message",
    eventType: EVENT.MESSAGE_SEND,
    traceId: directRecovery.trace_id,
    chatId: directRecovery.chat_id,
    messageId: "direct-recovery-message",
    text: "private recovery must not wait for group settings",
    raw: directRecovery,
  });
  const recoveryTransport = new MemoryTransport();
  blockNextGroupSettingsRead = true;
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
    workspaces: new WorkspaceCatalog(stateStore),
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
  await waitFor(() => (releaseBlockedGroupSettingsRead ? true : undefined));
  await waitFor(() => prompts.find((candidate) => candidate.prompt.includes("private recovery must not wait")));
  const directRecoveryReply = await waitFor(() =>
    recoveryTransport.sent.find(
      (event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === directRecovery.chat_id,
    ),
  );
  recoveryTransport.receive({
    version: "2",
    event: EVENT.MESSAGE_ACK,
    trace_id: directRecoveryReply.trace_id,
    emitted_at: 31,
    chat_id: directRecovery.chat_id,
    payload: { message_id: "direct-recovery-reply", accepted_at: 31 },
  });
  await Bun.sleep(20);
  expect(prompts.some((candidate) => candidate.prompt.includes("authoritative startup settings"))).toBe(false);
  releaseBlockedGroupSettingsRead?.();
  releaseBlockedGroupSettingsRead = undefined;
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
  await expect(stateStore.hasHandledInboundMessage("work", "startup-muted-message", startupMuted)).resolves.toBe(true);
  await expect(stateStore.hasHandledInboundMessage("work", "accepted-first", acceptedFirst)).resolves.toBe(true);
  await expect(stateStore.hasHandledInboundMessage("work", "accepted-anchor", acceptedAnchor)).resolves.toBe(true);
  expect(prompts.some((candidate) => candidate.prompt.includes("accepted batch input"))).toBe(false);
  expect(prompts.some((candidate) => candidate.prompt.includes("authoritative startup settings"))).toBe(false);
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

it("supplies mention context only until it first enters the Runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-mention-context-once-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-context-once",
      muted: false,
      replyMode: "mention",
      batchDelaySeconds: 0,
      version: 1,
    },
  ]);
  const dispatchedContexts: string[][] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatchedContexts.push(message.groupMentionContext?.map((entry) => entry.message_id) ?? []);
      await onTurnAccepted();
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const accept = async (envelope: Envelope) => {
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
  };

  await accept(groupMessage({ id: "old-context", text: "old context", chatId: "group-context-once" }));
  await accept(
    groupMessage({
      id: "first-mention",
      text: "use old context once",
      chatId: "group-context-once",
      mentioned: true,
    }),
  );
  await accept(groupMessage({ id: "fresh-context", text: "fresh context", chatId: "group-context-once" }));
  await accept(
    groupMessage({
      id: "second-mention",
      text: "use only fresh context",
      chatId: "group-context-once",
      mentioned: true,
    }),
  );

  expect(dispatchedContexts).toEqual([["old-context"], ["fresh-context"]]);
  await coordinator.close();
  await stateStore.close();
});

it("preserves mention context when an empty addressing mention does not enter the Runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-empty-mention-context-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-empty-mention",
      muted: false,
      replyMode: "mention",
      batchDelaySeconds: 0,
      version: 1,
    },
  ]);
  const dispatchedContexts: string[][] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatchedContexts.push(message.groupMentionContext?.map((entry) => entry.message_id) ?? []);
      await onTurnAccepted();
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const accept = async (envelope: Envelope) => {
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
  };

  await accept(groupMessage({ id: "preserved-context", text: "keep me", chatId: "group-empty-mention" }));
  await accept(groupMessage({ id: "empty-mention", text: "", chatId: "group-empty-mention", mentioned: true }));
  await accept(
    groupMessage({
      id: "real-mention-after-empty",
      text: "now enter the Runtime",
      chatId: "group-empty-mention",
      mentioned: true,
    }),
  );

  expect(dispatchedContexts).toEqual([[], ["preserved-context"]]);
  await coordinator.close();
  await stateStore.close();
});

it("does not select the same mention context for concurrent Runtime turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-mention-context-race-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-context-race",
      muted: false,
      replyMode: "mention",
      batchDelaySeconds: 0,
      version: 1,
    },
  ]);
  let releaseFirstDispatch: (() => void) | undefined;
  const firstDispatchGate = new Promise<void>((resolve) => {
    releaseFirstDispatch = resolve;
  });
  let signalFirstDispatch: (() => void) | undefined;
  const firstDispatchStarted = new Promise<void>((resolve) => {
    signalFirstDispatch = resolve;
  });
  const dispatchedContexts: string[][] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatchedContexts.push(message.groupMentionContext?.map((entry) => entry.message_id) ?? []);
      if (dispatchedContexts.length === 1) {
        signalFirstDispatch?.();
        await firstDispatchGate;
      }
      await onTurnAccepted();
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const persist = async (envelope: Envelope) => {
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
    return message;
  };

  await coordinator.accept(
    await persist(groupMessage({ id: "race-context", text: "shared context", chatId: "group-context-race" })),
  );
  const first = coordinator.accept(
    await persist(
      groupMessage({
        id: "race-first-mention",
        text: "first turn",
        chatId: "group-context-race",
        mentioned: true,
      }),
    ),
  );
  await firstDispatchStarted;
  const second = coordinator.accept(
    await persist(
      groupMessage({
        id: "race-second-mention",
        text: "second turn",
        chatId: "group-context-race",
        mentioned: true,
      }),
    ),
  );
  await Bun.sleep(10);
  expect(dispatchedContexts).toEqual([["race-context"]]);
  releaseFirstDispatch?.();
  await Promise.all([first, second]);

  expect(dispatchedContexts).toEqual([["race-context"], []]);
  await coordinator.close();
  await stateStore.close();
});

it("waits for preceding mention context to become selectable before dispatching a concurrent mention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-preceding-context-race-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-preceding-context-race",
      muted: false,
      replyMode: "mention",
      batchDelaySeconds: 0,
      version: 1,
    },
  ]);
  let releaseContextMark: () => void = () => undefined;
  const contextMarkGate = new Promise<void>((resolve) => {
    releaseContextMark = resolve;
  });
  let signalContextMark: () => void = () => undefined;
  const contextMarkStarted = new Promise<void>((resolve) => {
    signalContextMark = resolve;
  });
  const originalMark = stateStore.markInboundMessageHandled.bind(stateStore);
  stateStore.markInboundMessageHandled = async (bindingId, messageId, raw, outcome) => {
    if (messageId === "concurrent-preceding-context") {
      signalContextMark();
      await contextMarkGate;
    }
    await originalMark(bindingId, messageId, raw, outcome);
  };
  const dispatchedContexts: string[][] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatchedContexts.push(message.groupMentionContext?.map((entry) => entry.message_id) ?? []);
      await onTurnAccepted();
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const persist = async (envelope: Envelope) => {
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
    return message;
  };

  const context = coordinator.accept(
    await persist(
      groupMessage({
        id: "concurrent-preceding-context",
        text: "must precede the mention",
        chatId: "group-preceding-context-race",
      }),
    ),
  );
  await contextMarkStarted;
  const mention = coordinator.accept(
    await persist(
      groupMessage({
        id: "concurrent-following-mention",
        text: "use the preceding context",
        chatId: "group-preceding-context-race",
        mentioned: true,
      }),
    ),
  );
  await Bun.sleep(10);
  releaseContextMark();
  await Promise.all([context, mention]);

  expect(dispatchedContexts).toEqual([["concurrent-preceding-context"]]);
  await coordinator.close();
  await stateStore.close();
});

it("blocks an ordered mutation after a refused batch and enforces the absolute batch deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-ordering-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-ordering",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
    {
      conversationId: "group-maximum-wait",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 5,
      version: 1,
    },
    {
      conversationId: "group-attachments",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
  ]);
  const clock = new ManualClock(1_000_000);
  const dispatched: Array<{ chatId: string; text: string; attachments: number }> = [];
  const rejections: string[] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    clock,
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatched.push({
        chatId: message.chatId,
        text: message.text,
        attachments: message.fragments.filter((fragment) => fragment.kind === "file").length,
      });
      if (message.chatId === "group-attachments") await onTurnAccepted();
      return false;
    },
    reject: async (_message, reason) => {
      rejections.push(reason);
    },
    writeError: () => undefined,
  });
  const accept = async (envelope: Envelope) => {
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
  };

  await accept(
    groupMessage({
      id: "before-refused-mutation",
      text: "batch must be accepted before mutation",
      chatId: "group-ordering",
      emittedAt: clock.now(),
    }),
  );
  await accept(
    groupMessage({
      id: "refused-mutation",
      text: "/new",
      chatId: "group-ordering",
      mentioned: true,
      senderId: "owner-user",
      emittedAt: clock.now() + 1,
    }),
  );
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.text).toContain("batch must be accepted before mutation");
  expect(dispatched[0]?.text).not.toContain("/new");
  await expect(
    stateStore.hasHandledInboundMessage(
      "work",
      "refused-mutation",
      groupMessage({
        id: "refused-mutation",
        text: "/new",
        chatId: "group-ordering",
        mentioned: true,
        senderId: "owner-user",
        emittedAt: clock.now() + 1,
      }),
    ),
  ).resolves.toBe(false);

  for (let index = 0; index < 8; index += 1) {
    if (index > 0) clock.advance(4_000);
    await flush();
    await accept(
      groupMessage({
        id: `maximum-wait-${index}`,
        text: `continuous activity ${index}`,
        chatId: "group-maximum-wait",
        emittedAt: clock.now(),
      }),
    );
  }
  expect(dispatched).toHaveLength(1);
  clock.advance(2_000);
  await waitFor(() => (dispatched.length === 2 ? dispatched[1] : undefined));
  expect(dispatched[1]?.text).toContain("continuous activity 0");
  expect(dispatched[1]?.text).toContain("continuous activity 7");

  await accept(
    groupMessage({
      id: "ten-attachments",
      text: "first intact attachment batch",
      chatId: "group-attachments",
      attachmentCount: 10,
      emittedAt: clock.now(),
    }),
  );
  await accept(
    groupMessage({
      id: "overflow-attachment",
      text: "next intact attachment batch",
      chatId: "group-attachments",
      attachmentCount: 1,
      emittedAt: clock.now() + 1,
    }),
  );
  expect(dispatched[2]).toMatchObject({ chatId: "group-attachments", attachments: 10 });
  expect(dispatched[2]?.text).not.toContain("next intact attachment batch");
  await accept(
    groupMessage({
      id: "flush-overflow-attachment",
      text: "flush the attachment rollover",
      chatId: "group-attachments",
      mentioned: true,
      emittedAt: clock.now() + 2,
    }),
  );
  expect(dispatched[3]).toMatchObject({ chatId: "group-attachments", attachments: 1 });
  expect(dispatched[3]?.text).toContain("next intact attachment batch");
  expect(dispatched[3]?.text).toContain("flush the attachment rollover");
  const tooManyAttachments = groupMessage({
    id: "too-many-attachments",
    text: "reject this intact message",
    chatId: "group-attachments",
    attachmentCount: 11,
    emittedAt: clock.now() + 3,
  });
  await accept(tooManyAttachments);
  expect(dispatched).toHaveLength(4);
  expect(rejections).toHaveLength(1);
  expect(rejections[0]).toContain("10-attachment");
  await expect(stateStore.hasHandledInboundMessage("work", "too-many-attachments", tooManyAttachments)).resolves.toBe(
    true,
  );

  await coordinator.close();
  await stateStore.close();
});

it("replaces delayed Group Message Batch content when the same message id is updated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-batch-update-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-batch-update",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 5,
      version: 1,
    },
  ]);
  const clock = new ManualClock(0);
  const dispatched: string[] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatched.push(message.text);
      await onTurnAccepted();
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
    clock,
  });
  const originalEnvelope = groupMessage({
    id: "updated-in-place",
    text: "obsolete batch content",
    chatId: "group-batch-update",
    emittedAt: 0,
  });
  const updatedEnvelope = groupMessage({
    id: "updated-in-place",
    text: "current batch content",
    chatId: "group-batch-update",
    emittedAt: 4_000,
  });
  const accept = async (envelope: Envelope) => {
    const message = normalizeInboundMessage(envelope);
    if (!message) throw new Error("group batch update fixture did not normalize");
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
  };

  try {
    await accept(originalEnvelope);
    clock.advance(4_000);
    await accept(updatedEnvelope);
    clock.advance(4_000);
    await flush();
    expect(dispatched).toEqual([]);
    clock.advance(1_000);
    await waitFor(() => (dispatched.length === 1 ? dispatched[0] : undefined));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("current batch content");
    expect(dispatched[0]).not.toContain("obsolete batch content");
    await expect(stateStore.hasHandledInboundMessage("work", "updated-in-place", updatedEnvelope)).resolves.toBe(true);
    await expect(stateStore.hasHandledInboundMessage("work", "updated-in-place", originalEnvelope)).resolves.toBe(
      false,
    );

    await accept(
      groupMessage({
        id: "updated-maximum",
        text: "maximum original content",
        chatId: "group-batch-update",
        emittedAt: clock.now(),
      }),
    );
    for (let index = 1; index <= 7; index += 1) {
      clock.advance(4_000);
      await accept(
        groupMessage({
          id: "updated-maximum",
          text: `maximum update ${index}`,
          chatId: "group-batch-update",
          emittedAt: clock.now(),
        }),
      );
    }
    expect(dispatched).toHaveLength(1);
    clock.advance(2_000);
    await waitFor(() => (dispatched.length === 2 ? dispatched[1] : undefined));
    expect(dispatched[1]).toContain("maximum update 7");
    expect(dispatched[1]).not.toContain("maximum original content");
  } finally {
    await coordinator.close();
    await stateStore.close();
  }
});

it("restarts the absolute batch window when an oversized update removes the first source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-batch-oversized-update-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-batch-oversized-update",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
  ]);
  const clock = new ManualClock(0);
  const dispatched: string[] = [];
  const rejections: string[] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatched.push(message.text);
      await onTurnAccepted();
      return false;
    },
    reject: async (_message, reason) => {
      rejections.push(reason);
    },
    writeError: () => undefined,
    clock,
  });
  const accept = async (envelope: Envelope) => {
    const message = normalizeInboundMessage(envelope);
    if (!message) throw new Error("oversized group batch update fixture did not normalize");
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
  };

  try {
    await accept(
      groupMessage({
        id: "removed-first-source",
        text: "obsolete first source",
        chatId: "group-batch-oversized-update",
        emittedAt: clock.now(),
      }),
    );
    clock.advance(30_000);
    await accept(
      groupMessage({
        id: "remaining-source",
        text: "remaining source",
        chatId: "group-batch-oversized-update",
        emittedAt: clock.now(),
      }),
    );
    await accept(
      groupMessage({
        id: "removed-first-source",
        text: "x".repeat(64_001),
        chatId: "group-batch-oversized-update",
        emittedAt: clock.now(),
      }),
    );

    expect(rejections).toHaveLength(1);
    clock.advance(30_000);
    await flush();
    expect(dispatched).toEqual([]);
    clock.advance(30_000);
    await waitFor(() => (dispatched.length === 1 ? dispatched[0] : undefined));
    expect(dispatched[0]).toContain("remaining source");
    expect(dispatched[0]).not.toContain("obsolete first source");
  } finally {
    await coordinator.close();
    await stateStore.close();
  }
});

it("joins an in-flight settings notification before group shutdown returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-notify-close-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", []);
  const originalMarkStale = stateStore.markGroupSettingsSnapshotStale.bind(stateStore);
  let publishMarkStarted: () => void = () => undefined;
  const markStarted = new Promise<void>((resolve) => {
    publishMarkStarted = resolve;
  });
  let releaseMark: () => void = () => undefined;
  const markGate = new Promise<void>((resolve) => {
    releaseMark = resolve;
  });
  stateStore.markGroupSettingsSnapshotStale = async (bindingId) => {
    publishMarkStarted();
    await markGate;
    await originalMarkStale(bindingId);
  };
  let settingsReads = 0;
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: {
      getMyGroupSettings: async () => {
        settingsReads += 1;
        return { authoritative: true, rows: [] };
      },
    },
    dispatch: async () => false,
    reject: async () => undefined,
    writeError: () => undefined,
  });
  await coordinator.initialize();
  const notification = coordinator.handleNotifySignal({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "notify-close",
    emitted_at: 1,
    payload: { type: "agent.config.changed", event_id: "notify-close" },
  });
  await markStarted;
  const closing = coordinator.close();

  try {
    await expect(Promise.race([closing.then(() => "closed"), Bun.sleep(20).then(() => "waiting")])).resolves.toBe(
      "waiting",
    );
    releaseMark();
    await Promise.all([notification, closing]);
    expect(settingsReads).toBe(0);
  } finally {
    releaseMark();
    await Promise.allSettled([notification, closing]);
    await stateStore.close();
  }
});

it("does not dispatch a pending batch from a settings refresh after shutdown begins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-refresh-close-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-refresh-close",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
  ]);
  let publishSettingsReadStarted: () => void = () => undefined;
  const settingsReadStarted = new Promise<void>((resolve) => {
    publishSettingsReadStarted = resolve;
  });
  let releaseSettingsRead: () => void = () => undefined;
  const settingsReadGate = new Promise<void>((resolve) => {
    releaseSettingsRead = resolve;
  });
  const dispatched: string[] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: {
      getMyGroupSettings: async () => {
        publishSettingsReadStarted();
        await settingsReadGate;
        return {
          authoritative: true,
          rows: [
            {
              conversationId: "group-refresh-close",
              muted: false,
              replyMode: "all" as const,
              batchDelaySeconds: 0,
              version: 2,
            },
          ],
        };
      },
    },
    dispatch: async (message) => {
      dispatched.push(message.text);
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  await coordinator.initialize();
  const envelope = groupMessage({
    id: "refresh-close-pending",
    text: "must not dispatch during close",
    chatId: "group-refresh-close",
  });
  const message = normalizeInboundMessage(envelope);
  if (!message) throw new Error("group refresh close fixture did not normalize");
  await coordinator.accept(message);
  const notification = coordinator.handleNotifySignal({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "refresh-close-notify",
    emitted_at: 2,
    payload: { type: "agent.config.changed", event_id: "refresh-close-notify" },
  });
  await settingsReadStarted;
  const closing = coordinator.close();

  try {
    releaseSettingsRead();
    await Promise.all([notification, closing]);
    expect(dispatched).toEqual([]);
  } finally {
    releaseSettingsRead();
    await Promise.allSettled([notification, closing]);
    await stateStore.close();
  }
});

it("isolates identical group ids across Agent Bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-binding-scope-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "shared-group",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
  ]);
  await stateStore.replaceGroupSettingsSnapshot("personal", [
    {
      conversationId: "shared-group",
      muted: true,
      replyMode: "mention",
      batchDelaySeconds: 0,
      version: 1,
    },
  ]);
  const workDispatches: string[] = [];
  let personalDispatches = 0;
  const coordinator = (bindingId: "work" | "personal") =>
    new GroupIntakeCoordinator({
      bindingId,
      agentUserId: "agent-user",
      stateStore,
      api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
      dispatch: async (message, _mode, onTurnAccepted) => {
        if (bindingId === "work") workDispatches.push(message.text);
        else personalDispatches += 1;
        await onTurnAccepted();
        return false;
      },
      reject: async () => undefined,
      writeError: () => undefined,
    });
  const work = coordinator("work");
  const personal = coordinator("personal");
  const firstEnvelope = groupMessage({
    id: "binding-scoped-first",
    text: "only the work Binding may batch this",
    chatId: "shared-group",
  });
  const flushEnvelope = groupMessage({
    id: "binding-scoped-flush",
    text: "flush work only",
    chatId: "shared-group",
    mentioned: true,
  });
  const first = normalizeInboundMessage(firstEnvelope);
  const flushMessage = normalizeInboundMessage(flushEnvelope);
  if (!first || !flushMessage) throw new Error("group fixture did not normalize");
  for (const bindingId of ["work", "personal"] as const) {
    await stateStore.upsertInboundMessage({
      agentId: bindingId,
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: firstEnvelope.trace_id,
      chatId: firstEnvelope.chat_id,
      messageId: first.messageId,
      text: first.text,
      raw: firstEnvelope,
    });
  }
  await stateStore.upsertInboundMessage({
    agentId: "work",
    direction: "inbound",
    kind: "message",
    eventType: EVENT.MESSAGE_SEND,
    traceId: flushEnvelope.trace_id,
    chatId: flushEnvelope.chat_id,
    messageId: flushMessage.messageId,
    text: flushMessage.text,
    raw: flushEnvelope,
  });

  await Promise.all([work.accept(first), personal.accept(first)]);
  await work.accept(flushMessage);

  expect(workDispatches).toHaveLength(1);
  expect(workDispatches[0]).toContain("only the work Binding may batch this");
  expect(workDispatches[0]).toContain("flush work only");
  expect(personalDispatches).toBe(0);
  await expect(stateStore.hasHandledInboundMessage("personal", first.messageId, firstEnvelope)).resolves.toBe(true);
  await work.close();
  await personal.close();
  await stateStore.close();
});

it("submits a batch once when its timer and settings reconciliation race", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-reconcile-race-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-race",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 1,
      version: 1,
    },
  ]);
  let signalSettingsRead: (() => void) | undefined;
  const settingsRead = new Promise<void>((resolve) => {
    signalSettingsRead = resolve;
  });
  let releaseSettingsRead: (() => void) | undefined;
  const settingsGate = new Promise<void>((resolve) => {
    releaseSettingsRead = resolve;
  });
  const clock = new ManualClock(2_000_000);
  const dispatched: string[] = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: {
      getMyGroupSettings: async () => {
        signalSettingsRead?.();
        await settingsGate;
        return {
          authoritative: true,
          rows: [
            {
              conversationId: "group-race",
              muted: false,
              replyMode: "all" as const,
              batchDelaySeconds: 0,
              version: 2,
            },
          ],
        };
      },
    },
    clock,
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatched.push(message.text);
      await onTurnAccepted();
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const envelope = groupMessage({
    id: "timer-reconcile-race",
    text: "submit exactly once",
    chatId: "group-race",
    emittedAt: clock.now(),
  });
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
  const notification = coordinator.handleNotifySignal({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "timer-reconcile-settings",
    emitted_at: clock.now(),
    payload: { type: "agent.config.changed", event_id: "timer-reconcile-settings" },
  });
  await settingsRead;
  clock.advance(1_000);
  await flush();
  releaseSettingsRead?.();
  await notification;
  await waitFor(() => (dispatched.length > 0 ? dispatched[0] : undefined));
  await flush();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toContain("submit exactly once");

  await coordinator.close();
  await stateStore.close();
});

it("does not let an obsolete reconciliation discard a batch after a newer notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-notification-race-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  const allMessages = {
    conversationId: "group-notification-race",
    muted: false,
    replyMode: "all" as const,
    batchDelaySeconds: 60,
    version: 1,
  };
  await stateStore.replaceGroupSettingsSnapshot("work", [allMessages]);
  let settingsReads = 0;
  let releaseFirstDispatch: (() => void) | undefined;
  const firstDispatchGate = new Promise<void>((resolve) => {
    releaseFirstDispatch = resolve;
  });
  const dispatched: Array<{ text: string; attachments: number }> = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: {
      getMyGroupSettings: async () => {
        settingsReads += 1;
        return settingsReads === 1
          ? {
              authoritative: true,
              rows: [{ ...allMessages, replyMode: "mention" as const, batchDelaySeconds: 0, version: 2 }],
            }
          : { authoritative: true, rows: [{ ...allMessages, version: 3 }] };
      },
    },
    dispatch: async (message, _mode, onTurnAccepted) => {
      dispatched.push({
        text: message.text,
        attachments: message.fragments.filter((fragment) => fragment.kind === "file").length,
      });
      await onTurnAccepted();
      if (dispatched.length === 1) await firstDispatchGate;
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const accept = async (envelope: Envelope) => {
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
  };
  await accept(
    groupMessage({
      id: "notification-race-full",
      text: "first full batch",
      chatId: "group-notification-race",
      attachmentCount: 10,
    }),
  );
  const overflow = accept(
    groupMessage({
      id: "notification-race-overflow",
      text: "must survive obsolete reconciliation",
      chatId: "group-notification-race",
      attachmentCount: 1,
    }),
  );
  await waitFor(() => (dispatched.length === 1 ? true : undefined));
  const firstNotification = coordinator.handleNotifySignal({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "notification-race-first",
    emitted_at: 1,
    payload: { type: "agent.config.changed", event_id: "notification-race-first" },
  });
  await waitFor(() => (settingsReads === 1 ? true : undefined));
  const secondNotification = coordinator.handleNotifySignal({
    version: "2",
    event: EVENT.NOTIFY_SIGNAL,
    trace_id: "notification-race-second",
    emitted_at: 2,
    payload: { type: "agent.config.changed", event_id: "notification-race-second" },
  });
  releaseFirstDispatch?.();
  await Promise.all([overflow, firstNotification, secondNotification]);
  expect(settingsReads).toBe(2);

  await accept(
    groupMessage({
      id: "notification-race-flush",
      text: "flush the surviving batch",
      chatId: "group-notification-race",
      mentioned: true,
    }),
  );
  expect(dispatched).toHaveLength(2);
  expect(dispatched[1]).toMatchObject({ attachments: 1 });
  expect(dispatched[1]?.text).toContain("must survive obsolete reconciliation");
  expect(dispatched[1]?.text).toContain("flush the surviving batch");

  await coordinator.close();
  await stateStore.close();
});

it("leaves zero-delay turns and inspection commands to the Runtime queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-group-runtime-queue-"));
  const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
  await stateStore.replaceGroupSettingsSnapshot("work", [
    {
      conversationId: "group-zero-delay",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 0,
      version: 1,
    },
    {
      conversationId: "group-inspection",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
      version: 1,
    },
  ]);
  let releaseDispatches: (() => void) | undefined;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatches = resolve;
  });
  const dispatched: Array<{ chatId: string; text: string; batch: boolean }> = [];
  const coordinator = new GroupIntakeCoordinator({
    bindingId: "work",
    agentUserId: "agent-user",
    stateStore,
    api: { getMyGroupSettings: async () => ({ authoritative: false, rows: [] }) },
    dispatch: async (message) => {
      dispatched.push({ chatId: message.chatId, text: message.text, batch: Boolean(message.groupBatch) });
      if (message.chatId === "group-zero-delay" || message.groupBatch) await dispatchGate;
      return false;
    },
    reject: async () => undefined,
    writeError: () => undefined,
  });
  const normalized = (envelope: Envelope) => {
    const message = normalizeInboundMessage(envelope);
    if (!message) throw new Error("group fixture did not normalize");
    return message;
  };

  const firstZeroDelay = coordinator.accept(
    normalized(groupMessage({ id: "zero-first", text: "first immediate", chatId: "group-zero-delay" })),
  );
  await waitFor(() => (dispatched.length === 1 ? true : undefined));
  const secondZeroDelay = coordinator.accept(
    normalized(groupMessage({ id: "zero-second", text: "second immediate", chatId: "group-zero-delay" })),
  );
  await waitFor(() => (dispatched.length === 2 ? true : undefined));

  await coordinator.accept(
    normalized(groupMessage({ id: "inspection-pending", text: "pending batch", chatId: "group-inspection" })),
  );
  const batchFlush = coordinator.accept(
    normalized(
      groupMessage({
        id: "inspection-flush",
        text: "flush pending batch",
        chatId: "group-inspection",
        mentioned: true,
      }),
    ),
  );
  await waitFor(() => (dispatched.some((candidate) => candidate.batch) ? true : undefined));
  const inspection = coordinator.accept(
    normalized(
      groupMessage({
        id: "inspection-status",
        text: "/status",
        chatId: "group-inspection",
        mentioned: true,
        senderId: "owner-user",
      }),
    ),
  );
  await waitFor(() =>
    dispatched.some((candidate) => !candidate.batch && candidate.text.includes("/status")) ? true : undefined,
  );

  releaseDispatches?.();
  await Promise.all([firstZeroDelay, secondZeroDelay, batchFlush, inspection]);
  expect(dispatched.filter((candidate) => candidate.chatId === "group-zero-delay")).toHaveLength(2);
  expect(dispatched.some((candidate) => !candidate.batch && candidate.text.includes("/status"))).toBe(true);
  await coordinator.close();
  await stateStore.close();
});
