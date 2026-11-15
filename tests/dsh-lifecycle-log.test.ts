import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboundContentDigest } from "../src/clawchat/inbound-identity";
import {
  type Envelope,
  EVENT,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/clawchat/protocol";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { createDeepSeekHarnessRuntimeAdapter } from "../src/runtime/deepseek-harness-adapter";
import type { DshBridgeClient } from "../src/runtime/deepseek-harness-process";
import type {
  DshBridgeEvent,
  DshBridgeHello,
  DshBridgeInteraction,
  DshSessionEvent,
} from "../src/runtime/deepseek-harness-protocol";
import {
  BridgeExitError,
  BridgeTimeoutError,
  classifyFailure,
  LIFECYCLE_PREFIX,
  LIFECYCLE_REASONS,
  LifecycleLog,
  ReplySendError,
  redactLifecycleError,
  ShutdownError,
} from "../src/runtime/lifecycle-log";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { type BindingRuntimeHandle, startBindingRuntime } from "../src/service/binding-runtime";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { fixedRuntimeAdapter, pluginBinding } from "./runtime-adapter-fixture";

const OWNER = "usr_owner";
const AGENT = "usr_agent";

const HELLO: DshBridgeHello = {
  type: "hello",
  protocol: { name: "clawchat-connect-dsh-bridge", major: 2, build: "test" },
  home: "",
  profile: "default",
  capabilities: {
    promptQueue: true,
    promptSteer: true,
    cancel: true,
    durableReceipt: true,
    history: true,
    approvals: true,
    questions: false,
    models: true,
    presets: false,
    permissionPresets: false,
    skills: false,
    commands: false,
    imageInput: false,
    localProducedFilePresentation: false,
    portableArtifactOutput: false,
    archive: false,
    restore: false,
    delete: false,
    crossProcessSessionOwnership: false,
  },
};

function nativeEvent(seq: number, type: string, data: unknown): DshSessionEvent {
  return { seq, time: seq, type, data };
}

type PromptScript = (bridge: ScriptedBridge, sessionId: string, inputId: string) => Promise<void>;

/** A DSH Bridge whose Turns are scripted: each prompt runs the script, which emits native events itself. */
class ScriptedBridge implements DshBridgeClient {
  readonly hello: DshBridgeHello;
  readonly prompts: string[] = [];
  failNextCreate = false;
  /** Native history served for resumed sessions (user messages the Runtime already took). */
  readonly histories = new Map<string, DshSessionEvent[]>();
  script: PromptScript = async (bridge, sessionId) => bridge.completeTurn(sessionId, "done", "completed");
  private readonly listeners = new Set<(event: DshBridgeEvent) => void>();
  private readonly interactionListeners = new Set<(interaction: DshBridgeInteraction) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly interactionWaiters: Array<() => void> = [];
  private readonly cwds = new Map<string, string>();
  private sequence = 0;

  constructor(
    home: string,
    private readonly workspace: string,
  ) {
    this.hello = structuredClone(HELLO);
    this.hello.home = home;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const values = params as { sessionId?: string; inputId?: string; cwd?: string };
    const sessionId = values.sessionId ?? "missing";
    if (method === "create" && this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("bridge refused to create the session");
    }
    if (method === "create" && values.cwd) this.cwds.set(sessionId, values.cwd);
    const cwd = this.cwds.get(sessionId) ?? this.workspace;
    if (method === "create" || method === "resume") {
      return { sessionId, header: { id: sessionId, createdAt: 1, cwd } } as T;
    }
    if (method === "history") {
      const types = (params as { types?: string[] }).types;
      const events = (this.histories.get(sessionId) ?? []).filter((event) => !types || types.includes(event.type));
      return {
        header: { id: sessionId, createdAt: 1, cwd },
        events,
        complete: true,
        nextBeforeSeq: null,
      } as T;
    }
    if (method === "models") return [] as T;
    if (method === "selectModel") return (params as { model: unknown }).model as T;
    if (method === "interactionResponse") {
      this.interactionWaiters.shift()?.();
      return { accepted: true } as T;
    }
    if (method === "cancel") return { reason: "aborted", idle: true } as T;
    if (method === "prompt") {
      const inputId = values.inputId ?? "missing";
      this.prompts.push(inputId);
      // Admission returns at once; the Turn then runs on its own, like a real Bridge.
      void this.script(this, sessionId, inputId).catch(() => undefined);
      return { inputId, messageId: inputId } as T;
    }
    throw new Error(`Unexpected scripted DSH Bridge request: ${method}`);
  }

  startTurn(sessionId: string): void {
    this.emit(sessionId, nativeEvent(++this.sequence, "turn/start", { turn: 1 }));
  }

  completeTurn(sessionId: string, reply: string, reason: "completed" | "error" | "aborted"): void {
    this.startTurn(sessionId);
    if (reason === "completed") {
      this.emit(
        sessionId,
        nativeEvent(++this.sequence, "assistant/message", {
          turn: 1,
          step: 0,
          message: { content: [{ type: "text", text: reply }] },
        }),
      );
    }
    this.emit(sessionId, nativeEvent(++this.sequence, "turn/end", { turn: 1, reason: { kind: reason } }));
  }

  async askApproval(sessionId: string): Promise<void> {
    const answered = new Promise<void>((resolve) => this.interactionWaiters.push(resolve));
    const interaction: DshBridgeInteraction = {
      type: "interaction",
      id: `approval-${++this.sequence}`,
      sessionId,
      request: {
        kind: "approval",
        action: "command",
        title: "run",
        description: "run a command",
        options: [
          { id: "approve-once", label: "once" },
          { id: "deny", label: "deny" },
        ],
      },
    };
    for (const listener of this.interactionListeners) listener(interaction);
    await answered;
  }

  /** The Bridge process dies: no further event will ever arrive. */
  die(): void {
    this.fail(new BridgeExitError("DeepSeek Harness process exited unexpectedly (code 1)"));
  }

  /** Connect itself closes the bridge while a Turn is running. */
  shutdown(): void {
    this.fail(new ShutdownError("DeepSeek Harness Bridge closed"));
  }

  private fail(error: Error): void {
    for (const listener of this.failureListeners) listener(error);
    this.failureListeners.clear();
  }

  onEvent(listener: (event: DshBridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onInteraction(listener: (interaction: DshBridgeInteraction) => void): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async close(): Promise<void> {}

  private emit(sessionId: string, event: DshSessionEvent): void {
    for (const listener of this.listeners) listener({ type: "event", sessionId, event });
  }
}

class MemoryTransport implements Transport {
  state: TransportState = "closed";
  handlers: TransportEvents | null = null;
  sent: Envelope[] = [];
  failReplies = false;
  rejectReplies = false;
  private ackCount = 0;

  async connect(_url: string, handlers: TransportEvents): Promise<void> {
    this.state = "open";
    this.handlers = handlers;
    handlers.onOpen();
  }

  send(data: string): void {
    const envelope = parseEnvelope(data);
    if (envelope.event === EVENT.MESSAGE_REPLY && this.failReplies) throw new Error("transport write failed");
    this.sent.push(envelope);
    if (envelope.event === EVENT.MESSAGE_REPLY) {
      const id = `reply-${++this.ackCount}`;
      if (this.rejectReplies) {
        queueMicrotask(() =>
          this.receive({
            version: "2",
            event: EVENT.MESSAGE_ERROR,
            trace_id: envelope.trace_id,
            emitted_at: 1,
            chat_id: envelope.chat_id,
            payload: { code: "rejected", reason: "not allowed", rejected_at: 1 },
          } as Envelope),
        );
        return;
      }
      queueMicrotask(() =>
        this.receive({
          version: "2",
          event: EVENT.MESSAGE_ACK,
          trace_id: envelope.trace_id,
          emitted_at: 1,
          chat_id: envelope.chat_id,
          payload: { message_id: id, accepted_at: 1 },
        }),
      );
    }
  }

  close(): void {
    this.state = "closed";
  }

  receive(envelope: Envelope): void {
    this.handlers?.onMessage(JSON.stringify(envelope));
  }
}

interface Fixture {
  bridge: ScriptedBridge;
  transport: MemoryTransport;
  lines: string[];
  records(): Array<Record<string, unknown>>;
  /** Lines of one message, as `step[:reason]`, in order. */
  steps(msg: string): string[];
  /** All lines as `step[:reason] msg`, in order. */
  trace(): string[];
  send(options: SendOptions): void;
  waitFor(predicate: () => boolean): Promise<void>;
  errors: string[];
}

interface SendOptions {
  id: string;
  text: string;
  chat?: string;
  type?: "direct" | "group";
  sender?: string;
  mentionAgent?: boolean;
  attachmentName?: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startFixture(
  options: {
    approvalDeadlineMs?: number;
    seedUnhandled?: SendOptions[];
    /** Runs after seeding and before the Binding starts. */
    beforeStart?: (context: {
      stateStore: ReturnType<typeof createStateStore>;
      bridge: ScriptedBridge;
    }) => Promise<void>;
    unlabelled?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "clawchat-dsh-lifecycle-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(join(home, "profiles", "default"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const canonicalHome = await realpath(home);
  const canonicalWorkspace = await realpath(workspace);
  const bridge = new ScriptedBridge(canonicalHome, canonicalWorkspace);
  const adapter = createDeepSeekHarnessRuntimeAdapter({
    bridgePath: "/bridge.mjs",
    bridgeBuild: "test",
    probeExecutable: () => ({ path: "/dsh" }),
    createBridge: async () => bridge,
  });
  const stateStore = createStateStore({ dbPath: join(root, "state.sqlite") });
  const workspaces = new WorkspaceCatalog(stateStore);
  for (const seeded of options.seedUnhandled ?? []) {
    const envelope = envelopeFor(seeded, 1, "seed");
    await stateStore.upsertInboundMessage({
      agentId: "dsh",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: envelope.trace_id,
      chatId: envelope.chat_id ?? null,
      messageId: seeded.id,
      text: seeded.text,
      raw: envelope,
    });
  }
  const config = defaultConfig();
  config.defaultAgent = "dsh";
  config.agents = {
    dsh: {
      ...pluginBinding({}, { displayName: "Agent" }),
      profile: "default",
      homePath: canonicalHome,
    } as ReturnType<typeof pluginBinding>,
  };
  await options.beforeStart?.({ stateStore, bridge });
  const runtimeAdapters = new RuntimeAdapterRegistry([
    fixedRuntimeAdapter((options.unlabelled ? { ...adapter, lifecycleLabel: undefined } : adapter) as never),
  ]);
  const transport = new MemoryTransport();
  const lines: string[] = [];
  const errors: string[] = [];
  const starting = startBindingRuntime({
    agentId: "dsh",
    activation: {
      localAgentId: "dsh",
      accessToken: "token",
      refreshToken: null,
      serverAgentId: "agt_server",
      userId: AGENT,
      ownerUserId: OWNER,
      conversationId: "chat-owner",
    },
    config,
    configPath: join(root, "config.json"),
    deviceId: "device-local",
    stateStore,
    workspaces,
    runtimeAdapters,
    wsTransport: transport,
    clawChatApi: {
      getUserProfile: async () => ({ nickname: "Someone" }),
      getMyGroupSettings: async () => ({ authoritative: false, rows: [] }),
    } as never,
    verifyInstalledSkills: async () => undefined,
    writeError: (message) => errors.push(message),
    writeLifecycle: (line) => lines.push(line),
    ...(options.approvalDeadlineMs ? { approvalDeadlineMs: options.approvalDeadlineMs } : {}),
  });
  for (let attempt = 0; attempt < 100 && !transport.handlers; attempt += 1) await Bun.sleep(1);
  transport.receive({
    version: "2",
    event: EVENT.CONNECT_CHALLENGE,
    trace_id: "challenge",
    emitted_at: 1,
    payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
  });
  await Bun.sleep(5);
  const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
  if (!connect) throw new Error("connect frame was not sent");
  transport.receive({
    version: "2",
    event: EVENT.HELLO_OK,
    trace_id: connect.trace_id,
    emitted_at: 2,
    payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
  });
  let dseq = 0;
  const handle: BindingRuntimeHandle = await starting;
  cleanups.push(async () => {
    await handle.close();
    await runtimeAdapters.close();
    await stateStore.close();
  });
  const records = () => lines.map((line) => JSON.parse(line.slice(LIFECYCLE_PREFIX.length)) as Record<string, unknown>);
  const label = (record: Record<string, unknown>) =>
    record.reason ? `${record.step}:${record.reason}` : String(record.step);
  return {
    bridge,
    transport,
    lines,
    errors,
    records,
    steps: (msg) =>
      records()
        .filter((record) => record.msg === msg)
        .map(label),
    trace: () => records().map((record) => `${label(record)} ${record.msg}`),
    send: (message) => transport.receive(envelopeFor(message, ++dseq, `${dseq}`)),
    waitFor: async (predicate) => {
      const deadline = Date.now() + 3_000;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error(
            `condition not met; lines so far:\n${lines.join("\n")}\nERR:${errors.join("")}\nSENT:${transport.sent.map((e) => e.event).join(",")}`,
          );
        await Bun.sleep(2);
      }
    },
  };
}

function envelopeFor(message: SendOptions, dseq: number, trace: string): Envelope {
  const mention = message.mentionAgent ? [{ kind: "mention", user_id: AGENT, display: "Agent" }] : [];
  return {
    version: "2",
    event: EVENT.MESSAGE_SEND,
    trace_id: `trace-${message.id}-${trace}`,
    emitted_at: 3,
    dseq,
    chat_id: message.chat ?? "chat-owner",
    chat_type: message.type ?? "direct",
    sender: { id: message.sender ?? OWNER, type: "direct", nick_name: "Sender" },
    payload: {
      message_id: message.id,
      message_mode: "normal",
      message: {
        body: {
          fragments: [
            ...mention,
            { kind: "text", text: message.text },
            ...(message.attachmentName
              ? [
                  {
                    kind: "file",
                    url: "https://media.invalid/attachment",
                    name: message.attachmentName,
                    mime: "application/pdf",
                    size: 10,
                  },
                ]
              : []),
          ],
        },
        context: { mentions: message.mentionAgent ? [{ user_id: AGENT, display: "Agent" }] : [], reply: null },
        streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
      },
    },
  } as Envelope;
}

const finished = (fixture: Fixture, msg: string) => () =>
  fixture.steps(msg).some((step) => step.startsWith("turn_finished") || step.startsWith("turn_failed"));

describe("DSH message lifecycle log (O-08)", () => {
  it("logs every step of a normal turn once, in order, with ids", async () => {
    const fixture = await startFixture();
    fixture.send({ id: "msg-1", text: "hello there" });
    await fixture.waitFor(finished(fixture, "msg-1"));

    expect(fixture.records().map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { v: 1, runtime: "dsh", step: "received", msg: "msg-1", chat: "chat-owner" },
      { v: 1, runtime: "dsh", step: "turn_started", msg: "msg-1", turn: "msg-1", chat: "chat-owner" },
      { v: 1, runtime: "dsh", step: "reply_sent", msg: "msg-1", turn: "msg-1", chat: "chat-owner" },
      { v: 1, runtime: "dsh", step: "turn_finished", msg: "msg-1", turn: "msg-1", chat: "chat-owner" },
    ]);
    for (const record of fixture.records()) {
      expect(record.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
    }
    expect(fixture.lines.every((line) => line.startsWith("clawchat-lifecycle {"))).toBe(true);
  });

  it("logs nothing for a redelivery of a message id that was already handled", async () => {
    const fixture = await startFixture();
    fixture.send({ id: "msg-dup", text: "once" });
    await fixture.waitFor(finished(fixture, "msg-dup"));
    // The handled marker is written after the Turn is accepted; wait for it before redelivering.
    await Bun.sleep(30);
    const before = [...fixture.lines];
    fixture.send({ id: "msg-dup", text: "once" });
    fixture.send({ id: "msg-dup", text: "once" });
    await Bun.sleep(100);

    expect(fixture.lines).toEqual(before);
    expect(fixture.steps("msg-dup")).toEqual(["received", "turn_started", "reply_sent", "turn_finished"]);
    expect(fixture.bridge.prompts).toEqual(["msg-dup"]);
  });

  it("keeps the real outcome of a turn that is still running when its message id is redelivered", async () => {
    const fixture = await startFixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.bridge.script = async (bridge, sessionId) => {
      bridge.startTurn(sessionId);
      await gate;
      bridge.completeTurn(sessionId, "late answer", "completed");
    };
    fixture.send({ id: "msg-run", text: "slow one" });
    await fixture.waitFor(() => fixture.steps("msg-run").includes("turn_started"));
    // The input was accepted, so the id is already marked handled: the redelivery takes the early-drop path.
    await Bun.sleep(30);
    fixture.send({ id: "msg-run", text: "slow one" });
    await Bun.sleep(50);
    release();
    await fixture.waitFor(finished(fixture, "msg-run"));
    await Bun.sleep(30);

    expect(fixture.steps("msg-run")).toEqual(["received", "turn_started", "reply_sent", "turn_finished"]);
  });

  it("logs exactly one terminal line for a message whose first attempt failed and a retry later succeeded", async () => {
    const fixture = await startFixture();
    fixture.bridge.failNextCreate = true;
    fixture.send({ id: "msg-retry", text: "try twice" });
    await Bun.sleep(100);
    // The failed attempt is an internal retry: no terminal line, no turn.
    expect(fixture.steps("msg-retry")).toEqual(["received"]);
    expect(fixture.bridge.prompts).toEqual([]);

    fixture.send({ id: "msg-retry", text: "try twice" });
    await fixture.waitFor(finished(fixture, "msg-retry"));
    await Bun.sleep(50);

    expect(fixture.steps("msg-retry")).toEqual(["received", "turn_started", "reply_sent", "turn_finished"]);
    expect(
      fixture.records().filter((record) => ["ignored", "turn_finished", "turn_failed"].includes(String(record.step))),
    ).toHaveLength(1);
  });

  it("logs nothing extra for an unfinished message that a restart processes again", async () => {
    const fixture = await startFixture({ seedUnhandled: [{ id: "msg-left", text: "interrupted", chat: "chat-left" }] });
    await fixture.waitFor(() => fixture.steps("msg-left").includes("turn_finished"));
    await Bun.sleep(50);

    expect(fixture.steps("msg-left")).toEqual(["received", "turn_started", "reply_sent", "turn_finished"]);
  });

  it("logs turn_failed restart for an unfinished message the restart abandons because the Runtime already took it", async () => {
    const seeded: SendOptions = { id: "msg-taken", text: "already submitted", chat: "chat-taken" };
    const fixture = await startFixture({
      seedUnhandled: [seeded],
      beforeStart: async ({ stateStore, bridge }) => {
        await stateStore.upsertRuntimeSession({
          chatId: "chat-taken",
          sessionId: "session-taken",
          agentId: "dsh",
          runtimeSessionId: "thread-taken",
          isCurrent: true,
          hasMessages: true,
        });
        const raw = envelopeFor(seeded, 1, "seed");
        const context = JSON.stringify({
          origin: "clawchat",
          message_id: seeded.id,
          content_digest: inboundContentDigest(raw),
        });
        bridge.histories.set("thread-taken", [
          nativeEvent(1, "user/message", {
            turn: 1,
            id: seeded.id,
            source: {
              kind: "user",
              connectInputId: seeded.id,
              connectInputOrigin: "clawchat",
              clawchatTurnContext: context,
            },
            content: [{ type: "text", text: "x" }],
          }),
        ]);
      },
    });
    await fixture.waitFor(() => fixture.steps("msg-taken").includes("turn_failed:restart"));
    await Bun.sleep(50);

    expect(fixture.steps("msg-taken")).toEqual(["received", "turn_failed:restart"]);
    expect(fixture.bridge.prompts).toEqual([]);
  });

  it("hands the reply over before the turn finishes and stamps reply_sent with the send time", async () => {
    const fixture = await startFixture();
    fixture.send({ id: "msg-order", text: "order" });
    await fixture.waitFor(finished(fixture, "msg-order"));
    const records = fixture.records();
    const reply = records.find((record) => record.step === "reply_sent");
    const done = records.find((record) => record.step === "turn_finished");
    expect(reply).toBeDefined();
    expect(reply).not.toHaveProperty("reply");
    expect(String(reply?.ts) <= String(done?.ts)).toBe(true);
    expect(records.map((record) => record.step)).toEqual(["received", "turn_started", "reply_sent", "turn_finished"]);
  });

  it("logs an unaddressed group message and a non-owner control command as ignored with their reasons", async () => {
    const fixture = await startFixture();
    fixture.send({ id: "msg-group", text: "chatter", chat: "chat-group", type: "group", sender: "usr_friend" });
    fixture.send({ id: "msg-cmd", text: "/new", sender: "usr_stranger", chat: "chat-stranger" });
    await fixture.waitFor(() => fixture.records().filter((record) => record.step === "ignored").length === 2);

    expect(fixture.steps("msg-group")).toEqual(["received", "ignored:not_addressed"]);
    expect(fixture.steps("msg-cmd")).toEqual(["received", "ignored:not_owner"]);
    expect(fixture.bridge.prompts).toEqual([]);
  });

  it("logs a message that arrives while an approval is pending as ignored pending_interaction", async () => {
    const fixture = await startFixture();
    fixture.bridge.script = async (bridge, sessionId) => {
      bridge.startTurn(sessionId);
      await bridge.askApproval(sessionId);
      bridge.completeTurn(sessionId, "approved and done", "completed");
    };
    fixture.send({ id: "msg-a", text: "do the thing" });
    await fixture.waitFor(() => fixture.steps("msg-a").includes("interaction_pending"));
    fixture.send({ id: "msg-b", text: "are you there" });
    await fixture.waitFor(() => fixture.steps("msg-b").length === 2);

    expect(fixture.trace()).toEqual([
      "received msg-a",
      "turn_started msg-a",
      "interaction_pending msg-a",
      "received msg-b",
      "ignored:pending_interaction msg-b",
    ]);
    const pending = fixture.records().find((record) => record.step === "interaction_pending");
    expect(pending).toMatchObject({ msg: "msg-a", turn: "msg-a", chat: "chat-owner" });

    fixture.send({ id: "msg-c", text: "/approve" });
    await fixture.waitFor(finished(fixture, "msg-a"));
    expect(fixture.steps("msg-a")).toEqual([
      "received",
      "turn_started",
      "interaction_pending",
      "reply_sent",
      "turn_finished",
    ]);
    expect(fixture.steps("msg-c")).toEqual(["received", "ignored:interaction_response"]);
  });

  it("logs an approval that expires as interaction_expired with reason timeout, and the turn goes on", async () => {
    const fixture = await startFixture({ approvalDeadlineMs: 30 });
    fixture.bridge.script = async (bridge, sessionId) => {
      bridge.startTurn(sessionId);
      await bridge.askApproval(sessionId);
      bridge.completeTurn(sessionId, "went on after the denial", "completed");
    };
    fixture.send({ id: "msg-exp", text: "needs approval" });
    await fixture.waitFor(finished(fixture, "msg-exp"));

    expect(fixture.trace()).toEqual([
      "received msg-exp",
      "turn_started msg-exp",
      "interaction_pending msg-exp",
      "interaction_expired:timeout msg-exp",
      "reply_sent msg-exp",
      "turn_finished msg-exp",
    ]);
    expect(fixture.records().find((record) => record.step === "interaction_expired")).toMatchObject({
      turn: "msg-exp",
      chat: "chat-owner",
    });
  });

  it("logs a model error as turn_failed model_error with the native reason code only", async () => {
    const fixture = await startFixture();
    fixture.bridge.script = async (bridge, sessionId) => bridge.completeTurn(sessionId, "", "error");
    fixture.send({ id: "msg-model", text: "break the model" });
    await fixture.waitFor(finished(fixture, "msg-model"));

    const failed = fixture.records().find((record) => record.step === "turn_failed");
    expect(failed).toMatchObject({ msg: "msg-model", turn: "msg-model", reason: "model_error", error: "error" });
    expect(fixture.steps("msg-model").filter((step) => step.startsWith("turn_"))).toEqual([
      "turn_started",
      "turn_failed:model_error",
    ]);
  });

  it("ends a turn as turn_failed bridge_exit when the Bridge dies mid-turn instead of hanging", async () => {
    const fixture = await startFixture();
    fixture.bridge.script = async (bridge, sessionId) => {
      bridge.startTurn(sessionId);
      bridge.die();
    };
    fixture.send({ id: "msg-die", text: "crash please" });
    await fixture.waitFor(finished(fixture, "msg-die"));

    expect(fixture.steps("msg-die").slice(0, 3)).toEqual(["received", "turn_started", "turn_failed:bridge_exit"]);
    expect(fixture.records().find((record) => record.step === "turn_failed")).toMatchObject({
      turn: "msg-die",
      error: "BridgeExitError",
    });
  });

  it("logs a reply that cannot be handed to ClawChat as turn_failed send_failed, without a reply_sent", async () => {
    const fixture = await startFixture();
    fixture.transport.failReplies = true;
    fixture.send({ id: "msg-send", text: "answer me" });
    await fixture.waitFor(finished(fixture, "msg-send"));

    expect(fixture.steps("msg-send")).toEqual(["received", "turn_started", "turn_failed:send_failed"]);
    expect(fixture.records().find((record) => record.step === "turn_failed")).toMatchObject({ error: "Error" });
  });

  it("logs reply_sent at hand-off and turn_failed send_failed when the server rejects the reply", async () => {
    const fixture = await startFixture();
    fixture.transport.rejectReplies = true;
    fixture.send({ id: "msg-reject", text: "answer me" });
    await fixture.waitFor(finished(fixture, "msg-reject"));

    expect(fixture.steps("msg-reject")).toEqual(["received", "turn_started", "reply_sent", "turn_failed:send_failed"]);
    expect(fixture.records().find((record) => record.step === "turn_failed")).toMatchObject({
      error: "MessageSendError",
    });
  });

  it("writes nothing and sends no failure notice when Connect itself closes the bridge mid-turn", async () => {
    const fixture = await startFixture();
    fixture.bridge.script = async (bridge, sessionId) => {
      bridge.startTurn(sessionId);
      bridge.shutdown();
    };
    fixture.send({ id: "msg-stop", text: "interrupted by shutdown" });
    await fixture.waitFor(() => fixture.steps("msg-stop").includes("turn_started"));
    await Bun.sleep(100);

    expect(fixture.steps("msg-stop")).toEqual(["received", "turn_started"]);
    expect(fixture.transport.sent.filter((envelope) => envelope.event === EVENT.MESSAGE_REPLY)).toEqual([]);
  });

  it("writes no lifecycle lines for a Runtime whose Adapter declares no label", async () => {
    const fixture = await startFixture({ unlabelled: true });
    fixture.send({ id: "msg-quiet", text: "hello" });
    await fixture.waitFor(() => fixture.bridge.prompts.includes("msg-quiet"));
    await Bun.sleep(100);
    expect(fixture.lines).toEqual([]);
  });

  it("logs a cancelled turn as turn_failed cancelled", async () => {
    const fixture = await startFixture();
    fixture.bridge.script = async (bridge, sessionId) => {
      bridge.startTurn(sessionId);
      await Bun.sleep(20);
      bridge.completeTurn(sessionId, "", "aborted");
    };
    fixture.send({ id: "msg-cancel", text: "long task" });
    await fixture.waitFor(finished(fixture, "msg-cancel"));
    expect(fixture.steps("msg-cancel").filter((step) => step.startsWith("turn_f"))).toEqual(["turn_failed:cancelled"]);
  });

  it("logs a message queued behind a running turn as queued busy, then runs it", async () => {
    const fixture = await startFixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    fixture.bridge.script = async (bridge, sessionId) => {
      if (first) {
        first = false;
        bridge.startTurn(sessionId);
        await gate;
      }
      bridge.completeTurn(sessionId, "ok", "completed");
    };
    fixture.send({ id: "msg-first", text: "slow" });
    await fixture.waitFor(() => fixture.steps("msg-first").includes("turn_started"));
    fixture.send({ id: "msg-second", text: "queued behind" });
    await fixture.waitFor(() => fixture.steps("msg-second").includes("queued:busy"));
    release();
    await fixture.waitFor(finished(fixture, "msg-second"));

    expect(fixture.steps("msg-second")).toEqual([
      "received",
      "queued:busy",
      "turn_started",
      "reply_sent",
      "turn_finished",
    ]);
  });

  it("never writes message text or attachment names into any lifecycle line", async () => {
    const fixture = await startFixture();
    const secretText = "TOPSECRETTEXT-4711";
    const secretFile = "quarterly-salary-sheet.pdf";
    fixture.send({ id: "msg-x1", text: secretText, attachmentName: secretFile });
    await fixture.waitFor(finished(fixture, "msg-x1"));
    fixture.send({
      id: "msg-x2",
      text: `${secretText} /stranger`,
      sender: "usr_stranger",
      chat: "chat-s",
      type: "group",
    });
    fixture.send({ id: "msg-x3", text: `/new ${secretText}`, sender: "usr_stranger", chat: "chat-s2" });
    fixture.bridge.script = async (bridge, sessionId) => bridge.completeTurn(sessionId, "", "error");
    fixture.send({ id: "msg-x4", text: secretText, attachmentName: secretFile });
    await fixture.waitFor(finished(fixture, "msg-x4"));
    await fixture.waitFor(() => fixture.steps("msg-x3").length === 2);

    expect(fixture.lines.length).toBeGreaterThan(8);
    const everything = fixture.lines.join("\n");
    expect(everything).not.toContain("TOPSECRET");
    expect(everything).not.toContain("quarterly");
    expect(everything).not.toContain(".pdf");
    expect(everything).not.toContain("done");
  });
});

describe("lifecycle log module", () => {
  const clock = () => new Date("2026-11-15T08:00:00.123Z");

  it("writes one prefixed JSON line per step with the fixed fields", async () => {
    const written: string[] = [];
    const log = new LifecycleLog({ write: (line) => written.push(line), now: clock });
    log.received({ messageId: "m1", chatId: "c1" });
    log.turnStarted(["m1"], "t1", "c1");
    log.turnFinished(["m1"], "t1", "c1");
    await log.flush();
    expect(written).toEqual([
      'clawchat-lifecycle {"v":1,"ts":"2026-11-15T08:00:00.123Z","runtime":"dsh","step":"received","msg":"m1","chat":"c1"}',
      'clawchat-lifecycle {"v":1,"ts":"2026-11-15T08:00:00.123Z","runtime":"dsh","step":"turn_started","msg":"m1","turn":"t1","chat":"c1"}',
      'clawchat-lifecycle {"v":1,"ts":"2026-11-15T08:00:00.123Z","runtime":"dsh","step":"turn_finished","msg":"m1","turn":"t1","chat":"c1"}',
    ]);
    expect(LIFECYCLE_REASONS).toContain("pending_interaction");
  });

  it("writes one received and one terminal line per id, nothing after the terminal, and survives a restart", async () => {
    const written: string[] = [];
    const claimed = new Set<string>();
    const ledger = {
      claim: async (key: string) => !claimed.has(key) && !!claimed.add(key),
      has: async (key: string) => claimed.has(key),
    };
    const steps = () =>
      written.map((line) => (JSON.parse(line.slice(LIFECYCLE_PREFIX.length)) as { step: string }).step);
    const first = new LifecycleLog({ write: (line) => written.push(line), ledger });
    first.received({ messageId: "m1", chatId: "c1" });
    first.received({ messageId: "m1", chatId: "c1" });
    first.ignored(["m1"], "c1", "no_turn");
    first.turnFailed(["m1"], undefined, "c1", { reason: "runtime_error" });
    first.turnStarted(["m1"], "t1", "c1");
    await first.flush();
    expect(steps()).toEqual(["received", "ignored"]);

    const afterRestart = new LifecycleLog({ write: (line) => written.push(line), ledger });
    afterRestart.received({ messageId: "m1", chatId: "c1" });
    afterRestart.turnFailed(["m1"], undefined, "c1", { reason: "restart" });
    afterRestart.received({ messageId: "m2", chatId: "c1" });
    afterRestart.turnFailed(["m2"], undefined, "c1", { reason: "restart" });
    await afterRestart.flush();
    expect(steps()).toEqual(["received", "ignored", "received", "turn_failed"]);
  });

  it("requires a reason exactly where the format does, enforced by the types", () => {
    const log = LifecycleLog.silent();
    // @ts-expect-error ignored needs a reason
    log.ignored(["m"], "c");
    // @ts-expect-error a failure reason is not an ignore reason
    log.ignored(["m"], "c", "send_failed");
    // @ts-expect-error turn_failed needs a failure with a reason
    log.turnFailed(["m"], undefined, "c", {});
    // @ts-expect-error free text is not a reason
    log.turnFailed(["m"], undefined, "c", { reason: "something the user said" });
    // @ts-expect-error queued only takes its own reasons
    log.queued(["m"], "c", "not_addressed");
    expect(true).toBe(true);
  });

  it("keeps only an error class or code and redacts credentials", () => {
    expect(redactLifecycleError(new TypeError("Bearer abc.def message text"))).toBe("TypeError");
    expect(redactLifecycleError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(redactLifecycleError("Bearer sk-live-0123456789abcdef")).toBe("Bearer [redacted]");
    expect(redactLifecycleError("sk-live-0123456789abcdef")).toBe("[redacted]");
    expect(redactLifecycleError("a1b2c3d4e5f6a7b8c9d0e1f2a3b4")).toBe("[redacted]");
    expect(redactLifecycleError("x".repeat(500))?.length).toBeLessThanOrEqual(200);
    expect(redactLifecycleError({})).toBeUndefined();
  });

  it("classifies failures by tag, abort and timeout, never by message content", () => {
    expect(classifyFailure(new ReplySendError("anything", { cause: new TypeError("x") }))).toEqual({
      reason: "send_failed",
      error: "TypeError",
    });
    expect(classifyFailure(new BridgeTimeoutError("slow"))).toEqual({ reason: "timeout", error: "BridgeTimeoutError" });
    expect(classifyFailure(new BridgeExitError("gone"))).toEqual({ reason: "bridge_exit", error: "BridgeExitError" });
    expect(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" })).reason).toBe("cancelled");
    expect(classifyFailure(new Error("request timed out: prompt")).reason).toBe("runtime_error");
    expect(classifyFailure(new Error("secret user text")).reason).toBe("runtime_error");
    expect(classifyFailure(new Error("secret user text")).error).toBe("Error");
  });
});
