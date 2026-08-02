import { expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawChatApiClient } from "../src/api-client";
import { startBindingRuntime } from "../src/binding-runtime";
import { defaultConfig } from "../src/config";
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
    sender: { id: "member-1", type: "direct", nick_name: "Member" },
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
  config.defaultAgent = "work";
  config.agents = { work: { kind: "codex", displayName: "Work" } };
  const prompts: ConnectRuntimePrompt[] = [];
  const runtimeAdapters = new RuntimeAdapterRegistry([
    fixedRuntimeAdapter({
      kind: "codex",
      modes: ["read-only"],
      start: async () => ({
        prompt: async function* (input) {
          prompts.push(input);
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
  ];
  const clawChatApi = {
    agentsConnect: async () => ({}),
    getUserProfile: async () => ({ nickname: null }),
    updateMyProfile: async () => undefined,
    getMyGroupSettings: async () => ({ authoritative: true, rows: remoteRows }),
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
  ];
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
  await waitFor(async () => {
    const snapshot = await stateStore.getGroupSettingsSnapshot("work");
    return snapshot.rows[0]?.version === 2 && !snapshot.stale ? snapshot : undefined;
  });
  await expect(
    stateStore.hasHandledInboundMessage("work", "pending-settings-message", pendingSettingsMessage),
  ).resolves.toBe(true);
  transport.receive(groupMessage({ id: "muted-message", text: "do not answer", dseq: 6 }));
  await Bun.sleep(20);
  expect(prompts).toHaveLength(2);
  await expect(
    stateStore.hasHandledInboundMessage(
      "work",
      "muted-message",
      groupMessage({
        id: "muted-message",
        text: "do not answer",
        dseq: 6,
      }),
    ),
  ).resolves.toBe(true);

  transport.receive(
    groupMessage({ id: "context-message", text: "the deployment is tonight", chatId: "group-context", dseq: 7 }),
  );
  await Bun.sleep(20);
  expect(prompts).toHaveLength(2);
  transport.receive(
    groupMessage({
      id: "mentioned-message",
      text: "what do you think?",
      chatId: "group-context",
      mentioned: true,
      dseq: 8,
    }),
  );
  const mentionedPrompt = await waitFor(() => prompts[2]);
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
    dseq: 9,
  });
  transport.receive(silentMessage);
  const silentPrompt = await waitFor(() => prompts[3]);
  expect(silentPrompt.prompt).toContain("silent please");
  await waitFor(async () =>
    (await stateStore.hasHandledInboundMessage("work", "silent-message", silentMessage)) ? true : undefined,
  );
  await Bun.sleep(20);
  expect(transport.sent.filter((event) => event.event === EVENT.MESSAGE_REPLY)).toHaveLength(repliesBeforeSilence);

  await handle.close();

  remoteRows = [
    {
      conversationId: "group-recovery",
      muted: false,
      replyMode: "all",
      batchDelaySeconds: 60,
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
  const recoveryPrompt = await waitFor(() => prompts[4]);
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
