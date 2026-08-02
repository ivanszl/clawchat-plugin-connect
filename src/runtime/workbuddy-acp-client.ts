import { connect, type Socket } from "node:net";
import type { ConnectRuntimePrompt, RuntimeActivity } from "./types";
import {
  WorkBuddyDiscoveryError,
  type WorkBuddyEndpointVerification,
  type WorkBuddyProcessIdentity,
} from "./workbuddy-task-discovery";

const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;

export interface WorkBuddyConnectedSocketIdentity {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

export interface WorkBuddyAcpTaskAttachment {
  readonly verification: WorkBuddyEndpointVerification;
  prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeActivity>;
  close(): Promise<void>;
}

export async function verifyWorkBuddyAiEndpoint(
  input: { endpoint: string; taskId: string; workspace: string; acpVersion: number },
  timeoutMs: number,
  readConnectedOwner: (identity: WorkBuddyConnectedSocketIdentity) => Promise<WorkBuddyProcessIdentity | null>,
): Promise<WorkBuddyEndpointVerification> {
  const attachment = await openWorkBuddyAiTaskEndpoint(input, timeoutMs, readConnectedOwner);
  try {
    return attachment.verification;
  } finally {
    await attachment.close();
  }
}

export async function openWorkBuddyAiTaskEndpoint(
  input: { endpoint: string; taskId: string; workspace: string; acpVersion: number },
  timeoutMs: number,
  readConnectedOwner: (identity: WorkBuddyConnectedSocketIdentity) => Promise<WorkBuddyProcessIdentity | null>,
): Promise<WorkBuddyAcpTaskAttachment> {
  let connectionId = "";
  let sessionToken = "";
  const connection = await PersistentHttpConnection.open(input.endpoint, timeoutMs);
  try {
    const bootstrap = await connection.request("POST", `${connection.pathname}/connect`, {
      "x-codebuddy-request": "1",
    });
    if (bootstrap.statusCode < 200 || bootstrap.statusCode >= 300) {
      throw new Error(`ACP connect failed with HTTP ${bootstrap.statusCode}`);
    }
    const credentials = parseJson(bootstrap.body.toString("utf8"), "connect response") as {
      connectionId?: unknown;
      sessionToken?: unknown;
    };
    if (typeof credentials.connectionId !== "string" || !credentials.connectionId) {
      throw new Error("ACP connect response omitted its connection identifier");
    }
    connectionId = credentials.connectionId;
    sessionToken = typeof credentials.sessionToken === "string" ? credentials.sessionToken : "";

    // This is the exact established TCP socket reused by initialize and load, not a listener snapshot.
    const connectionOwner = await readConnectedOwner(connection.identity());
    const headers = acpHeaders(connectionId, sessionToken);
    const initialized = await postRpc(connection, headers, 1, "initialize", {
      protocolVersion: input.acpVersion,
      clientInfo: { name: "clawchat-connect-discovery", version: "1" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const initializedProtocol = (initialized.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (initializedProtocol !== input.acpVersion) {
      throw new Error("ACP initialize returned an incompatible protocol version");
    }
    const loaded = await postRpc(connection, headers, 2, "session/load", {
      sessionId: input.taskId,
      cwd: input.workspace,
      mcpServers: [],
    });
    const observedTaskId = loaded.taskIds.find((candidate) => candidate !== input.taskId) ?? loaded.taskIds[0];
    if (!observedTaskId) throw new Error("ACP replay emitted no Task identity");
    const verification = {
      taskId: observedTaskId,
      replayFingerprint: replayFingerprint(loaded.messageIds),
      replayStarted: loaded.replayStarted,
      replayCompleted: loaded.replayCompleted,
      activities: replayActivities(loaded.replayMessages),
      connectionOwner,
    };
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (connectionId) {
        await connection
          .request("DELETE", connection.pathname, acpHeaders(connectionId, sessionToken))
          .catch(() => undefined);
      }
      connection.close();
    };
    return {
      verification,
      prompt: (promptInput) => {
        if (closed) throw new Error("WorkBuddy Task Attachment is closed");
        return streamPrompt(
          connection,
          acpHeaders(connectionId, sessionToken),
          input.taskId,
          verification,
          promptInput,
        );
      },
      close,
    };
  } catch (error) {
    if (connectionId) {
      await connection
        .request("DELETE", connection.pathname, acpHeaders(connectionId, sessionToken))
        .catch(() => undefined);
    }
    connection.close();
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    throw new Error(redact(error instanceof Error ? error.message : String(error), [connectionId, sessionToken]));
  }
}

interface RpcObservation {
  result?: unknown;
  taskIds: string[];
  replayStarted: boolean;
  replayCompleted: boolean;
  replayActive: boolean;
  messageIds: string[];
  replayMessages: ReplayMessage[];
}

interface ReplayMessage {
  id: string;
  kind: import("./types").RuntimeActivity["kind"];
  text: string;
}

async function postRpc(
  connection: PersistentHttpConnection,
  headers: Record<string, string>,
  id: number,
  method: string,
  params: unknown,
  onPayload?: (payload: unknown) => void,
): Promise<RpcObservation> {
  const decoder = new SseDecoder((payload) => {
    observeRpcPayload(payload, id, observation);
    onPayload?.(payload);
  });
  const observation: RpcObservation = {
    taskIds: [],
    replayStarted: false,
    replayCompleted: false,
    replayActive: false,
    messageIds: [],
    replayMessages: [],
  };
  const response = await connection.request(
    "POST",
    connection.pathname,
    headers,
    Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
    (chunk) => decoder.push(chunk.toString("utf8")),
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`ACP ${method} failed with HTTP ${response.statusCode}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    decoder.finish();
  } else {
    const payload = parseJson(response.body.toString("utf8"), `${method} response`);
    observeRpcPayload(payload, id, observation);
    onPayload?.(payload);
  }
  if (observation.result === undefined) throw new Error(`ACP ${method} returned no JSON-RPC result`);
  return observation;
}

class SseDecoder {
  private buffer = "";

  constructor(private readonly onPayload: (payload: unknown) => void) {}

  push(value: string): void {
    this.buffer += value;
    this.consume(false);
  }

  finish(): void {
    this.consume(true);
  }

  private consume(final: boolean): void {
    const blocks = this.buffer.split(/\r?\n\r?\n/u);
    const tail = blocks.pop() ?? "";
    this.buffer = final ? "" : tail;
    for (const block of blocks) this.consumeBlock(block);
    if (final && tail.trim()) this.consumeBlock(tail);
  }

  private consumeBlock(block: string): void {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) this.onPayload(parseJson(data, "event stream payload"));
  }
}

function observeRpcPayload(payload: unknown, expectedId: number, observation: RpcObservation): void {
  if (typeof payload !== "object" || payload === null) return;
  const message = payload as Record<string, unknown>;
  if (message.id === expectedId && !("method" in message)) {
    if (message.error) throw new Error("ACP JSON-RPC request failed");
    observation.result = message.result ?? {};
    return;
  }
  if (message.method !== "session/update") return;
  const params = message.params as Record<string, unknown> | undefined;
  const taskId = params?.sessionId;
  if (typeof taskId === "string" && !observation.taskIds.includes(taskId)) observation.taskIds.push(taskId);
  const update = params?.update as Record<string, unknown> | undefined;
  const meta = update?._meta as Record<string, unknown> | undefined;
  if (meta?.["codebuddy.ai/historyReplay"] === "start") {
    observation.replayStarted = true;
    observation.replayActive = true;
  }
  if (observation.replayActive) {
    const messageId = update?.messageId;
    if (typeof messageId === "string" && !observation.messageIds.includes(messageId)) {
      observation.messageIds.push(messageId);
    }
    if (update) observeReplayUpdate(update, observation.replayMessages);
  }
  if (meta?.["codebuddy.ai/historyReplay"] === "end") {
    observation.replayCompleted = true;
    observation.replayActive = false;
  }
}

function observeReplayUpdate(update: Record<string, unknown>, messages: ReplayMessage[]): void {
  const updateKind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "native_update";
  if (NON_TRANSCRIPT_UPDATES.has(updateKind)) return;
  const messageKind = replayMessageKind(updateKind);
  const messageId = stringField(update, "messageId");
  const content = visibleText(update.content);
  if (messageKind && messageId && content) {
    upsertReplayMessage(messages, { id: messageId, kind: messageKind, text: content }, true);
    return;
  }
  if (updateKind === "tool_call" || updateKind === "tool_call_update") {
    const id = stringField(update, "toolCallId", "callId", "id") ?? syntheticReplayId(updateKind, messages);
    const text =
      stringField(update, "title", "name", "status") ?? (visibleText(update.content) || "WorkBuddy tool activity");
    upsertReplayMessage(messages, { id, kind: "tool", text }, false);
    return;
  }
  if (updateKind === "plan") {
    const id = stringField(update, "planId", "id") ?? syntheticReplayId(updateKind, messages);
    const text = planText(update.entries) || "WorkBuddy plan update";
    upsertReplayMessage(messages, { id, kind: "plan", text }, false);
    return;
  }
  const nativeId = stringField(update, "updateId", "id");
  const id = nativeId
    ? `${nativeId}:${updateKind}`
    : messageId
      ? `${messageId}:${updateKind}`
      : syntheticReplayId(updateKind, messages);
  upsertReplayMessage(messages, { id, kind: "unknown", text: `WorkBuddy ${updateKind}` }, false);
}

const NON_TRANSCRIPT_UPDATES = new Set([
  "session_info_update",
  "available_commands_update",
  "current_mode_update",
  "config_options_update",
]);

function upsertReplayMessage(messages: ReplayMessage[], message: ReplayMessage, append: boolean): void {
  const existing = messages.find((candidate) => candidate.id === message.id && candidate.kind === message.kind);
  if (!existing) {
    messages.push(message);
    return;
  }
  existing.text = append ? existing.text + message.text : message.text || existing.text;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function syntheticReplayId(updateKind: string, messages: ReplayMessage[]): string {
  return `${updateKind}:${messages.length}`;
}

function planText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) =>
      entry && typeof entry === "object"
        ? stringField(entry as Record<string, unknown>, "content", "title", "status")
        : null,
    )
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}

function replayMessageKind(value: unknown): ReplayMessage["kind"] | null {
  if (value === "user_message_chunk") return "user";
  if (value === "agent_message_chunk") return "assistant";
  if (value === "agent_thought_chunk") return "reasoning";
  return null;
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(visibleText).join("");
  if (!value || typeof value !== "object") return "";
  const content = value as Record<string, unknown>;
  return content.type === "text" && typeof content.text === "string" ? content.text : "";
}

function replayActivities(messages: ReplayMessage[]): import("./types").RuntimeActivity[] {
  let turn = 0;
  let item = 0;
  let started = false;
  return messages.map((message) => {
    if (message.kind === "user") {
      if (started) turn += 1;
      item = 1;
      started = true;
    } else {
      if (!started) started = true;
      item += 1;
    }
    return {
      id: `workbuddy:${message.kind}:${message.id}`,
      position: `${turn}.${item}`,
      parentId: null,
      kind: message.kind,
      text: message.text,
      state: "complete",
      source: "history",
    };
  });
}

function streamPrompt(
  connection: PersistentHttpConnection,
  headers: Record<string, string>,
  taskId: string,
  verification: WorkBuddyEndpointVerification,
  input: ConnectRuntimePrompt,
): AsyncIterable<RuntimeActivity> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("WorkBuddy text prompt is required");
  if (input.media?.length) throw new Error("WorkBuddy Task Attachments currently support text turns only");
  const queue = new AsyncActivityQueue();
  const projector = new LiveTurnProjector(nextTurnOrdinal(verification.activities), input);
  const requestId = Date.now();
  const userMessageId = workBuddyUserMessageId(input, requestId);
  let accepted: Promise<void> | null = null;
  void postRpc(
    connection,
    headers,
    requestId,
    "session/prompt",
    {
      sessionId: taskId,
      prompt: [{ type: "text", text: input.prompt }],
      _meta: {
        messageId: userMessageId,
        "codebuddy.ai": {
          userMessageId,
          messageRequestId: userMessageId,
        },
      },
    },
    (payload) => {
      if (!isTaskUpdate(payload, taskId)) return;
      if (!accepted) {
        accepted = input.onAccepted?.() ?? Promise.resolve();
        for (const activity of projector.accepted()) queue.push(activity);
      }
      for (const activity of projector.observe(payload)) queue.push(activity);
    },
  )
    .then(async (observation) => {
      await accepted;
      for (const activity of projector.complete(observation.result)) queue.push(activity);
      queue.end();
    })
    .catch((error) => queue.fail(error instanceof Error ? error : new Error(String(error))));
  return queue;
}

function workBuddyUserMessageId(input: ConnectRuntimePrompt, requestId: number): string {
  const origin = input.turnOrigin === "clawchat" ? "clawchat" : "client";
  const turnId = (input.turnId ?? `request-${requestId}`).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return `clawchat-connect-${origin}-${turnId}`;
}

function isTaskUpdate(payload: unknown, taskId: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const message = payload as Record<string, unknown>;
  if (message.method !== "session/update") return false;
  const params = message.params as Record<string, unknown> | undefined;
  return params?.sessionId === taskId;
}

function nextTurnOrdinal(activities: RuntimeActivity[]): number {
  let result = -1;
  for (const activity of activities) {
    const turn = Number(activity.position.split(".", 1)[0]);
    if (Number.isSafeInteger(turn)) result = Math.max(result, turn);
  }
  return result + 1;
}

class LiveTurnProjector {
  private readonly activities = new Map<string, RuntimeActivity>();
  private nextItem = 1;
  private terminal = false;
  private submittedUserId: string | null = null;

  constructor(
    private readonly turn: number,
    private readonly input: ConnectRuntimePrompt,
  ) {}

  accepted(): RuntimeActivity[] {
    if (this.submittedUserId) return [];
    const nativeId = this.input.turnId ? `connect:${this.input.turnId}` : `connect-turn:${this.turn}`;
    const activity = this.upsert(
      "user:submitted",
      "user",
      nativeId,
      this.input.prompt,
      "complete",
      false,
      this.userData(),
    );
    this.submittedUserId = activity.id;
    return [activity];
  }

  observe(payload: unknown): RuntimeActivity[] {
    const message = payload as Record<string, unknown>;
    const params = message.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) return [];
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "session_end") return this.terminalize(terminalState(update.stopReason));
    if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const activityKind = replayMessageKind(kind);
      const meta = update._meta as Record<string, unknown> | undefined;
      const nativeId = stringField(update, "messageId") ?? stringField(meta ?? {}, "codebuddy.ai/messageId");
      const text = visibleText(update.content);
      if (!activityKind || !nativeId || !text) return [];
      const activity = this.upsert(
        `${activityKind}:${nativeId}`,
        activityKind,
        nativeId,
        text,
        activityKind === "user" ? "complete" : "streaming",
        true,
        activityKind === "user" ? this.userData() : undefined,
      );
      if (activityKind === "user" && this.submittedUserId && activity.id !== this.submittedUserId) {
        const aliased = { ...activity, aliases: [this.submittedUserId] };
        this.activities.set(`${activityKind}:${nativeId}`, aliased);
        return [aliased];
      }
      return [activity];
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const nativeId = stringField(update, "toolCallId", "callId", "id");
      if (!nativeId) return [];
      const status = stringField(update, "status") ?? "running";
      const detail =
        visibleText(update.content) ||
        visibleText(update.toolResult) ||
        stringField(update, "title", "name") ||
        this.activities.get(`tool:${nativeId}`)?.text ||
        "WorkBuddy tool activity";
      return [
        this.upsert(`tool:${nativeId}`, "tool", nativeId, detail, toolState(status), false, {
          title: stringField(update, "title", "name") ?? detail.split("\n", 1)[0],
          status,
        }),
      ];
    }
    if (kind === "plan") {
      const nativeId = stringField(update, "planId", "id") ?? "current";
      return [this.upsert(`plan:${nativeId}`, "plan", nativeId, planText(update.entries), "streaming", false)];
    }
    if (kind === "session_info_update") {
      const meta = update._meta as Record<string, unknown> | undefined;
      const phase = meta?.["codebuddy.ai/agentPhase"] as Record<string, unknown> | undefined;
      const phaseName = stringField(phase ?? {}, "phase");
      if (!phaseName) return [];
      const requestId = stringField(meta ?? {}, "codebuddy.ai/requestId") ?? this.input.turnId ?? "current";
      const toolName = stringField(phase ?? {}, "toolName", "streamingToolName");
      const text = toolName ? `WorkBuddy ${phaseName}: ${toolName}` : `WorkBuddy ${phaseName}`;
      return [
        this.upsert(
          `progress:${requestId}`,
          "progress",
          requestId,
          text,
          phaseName === "idle" ? "complete" : "streaming",
          false,
          { phase: phaseName },
        ),
      ];
    }
    return [];
  }

  complete(result: unknown): RuntimeActivity[] {
    if (this.terminal) return [];
    const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    return this.terminalize(terminalState(record.stopReason));
  }

  private upsert(
    key: string,
    kind: RuntimeActivity["kind"],
    nativeId: string,
    text: string,
    state: RuntimeActivity["state"],
    append: boolean,
    data?: Record<string, unknown>,
  ): RuntimeActivity {
    const existing = this.activities.get(key);
    const activity: RuntimeActivity = {
      id: existing?.id ?? `workbuddy:${kind}:${nativeId}`,
      position: existing?.position ?? `${this.turn}.${this.nextItem++}`,
      parentId: null,
      kind,
      text: append ? (existing?.text ?? "") + text : text || existing?.text || "",
      state,
      source: "live",
      ...(data || existing?.data ? { data: { ...existing?.data, ...data } } : {}),
    };
    this.activities.set(key, activity);
    return activity;
  }

  private terminalize(state: RuntimeActivity["state"]): RuntimeActivity[] {
    if (this.terminal) return [];
    this.terminal = true;
    const updates: RuntimeActivity[] = [];
    for (const [key, activity] of this.activities) {
      if (activity.state === "complete" || activity.state === "error" || activity.state === "cancelled") continue;
      const completed = { ...activity, state };
      this.activities.set(key, completed);
      updates.push(completed);
    }
    return updates;
  }

  private userData(): Record<string, unknown> | undefined {
    if (!this.input.turnId) return undefined;
    return this.input.turnOrigin === "clawchat"
      ? { clawchatMessageId: this.input.turnId }
      : { clientMessageId: `turn_${this.input.turnId}_user` };
  }
}

function terminalState(stopReason: unknown): RuntimeActivity["state"] {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "refusal") return "error";
  return "complete";
}

function toolState(status: string): RuntimeActivity["state"] {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  return "streaming";
}

class AsyncActivityQueue implements AsyncIterable<RuntimeActivity> {
  private readonly values: RuntimeActivity[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<RuntimeActivity>) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure: Error | null = null;
  private completed = false;

  push(value: RuntimeActivity): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    this.completed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeActivity> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.failure) throw this.failure;
        if (this.completed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<RuntimeActivity>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function acpHeaders(connectionId: string, sessionToken: string): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "x-codebuddy-request": "1",
    "acp-connection-id": connectionId,
    ...(sessionToken ? { "acp-session-token": sessionToken } : {}),
  };
}

interface HttpResponse {
  statusCode: number;
  headers: Map<string, string>;
  body: Buffer;
}

class PersistentHttpConnection {
  readonly pathname: string;
  private pending:
    | {
        resolve: (response: HttpResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        parser: IncrementalHttpResponseParser;
      }
    | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly hostname: string,
    private readonly port: number,
    pathname: string,
    private readonly timeoutMs: number,
  ) {
    this.pathname = pathname;
    socket.on("data", (chunk) => {
      try {
        this.pending?.parser.push(Buffer.from(chunk));
      } catch (error) {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });
    socket.on("error", (error) => this.rejectPending(error));
    socket.on("close", () => this.rejectPending(new Error("ACP HTTP connection closed unexpectedly")));
  }

  static async open(endpoint: string, timeoutMs: number): Promise<PersistentHttpConnection> {
    const url = new URL(endpoint);
    const port = Number(url.port);
    const hostname = url.hostname === "[::1]" ? "::1" : url.hostname;
    const socket = connect({ host: hostname, port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error("ACP HTTP connection timed out")), timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", reject);
    });
    return new PersistentHttpConnection(socket, hostname, port, url.pathname, timeoutMs);
  }

  identity(): WorkBuddyConnectedSocketIdentity {
    const { localAddress, localPort, remoteAddress, remotePort } = this.socket;
    if (!localAddress || !localPort || !remoteAddress || !remotePort) {
      throw new Error("ACP HTTP socket identity is unavailable");
    }
    return { localAddress, localPort, remoteAddress, remotePort };
  }

  async request(
    method: "POST" | "DELETE",
    pathname: string,
    headers: Record<string, string>,
    body = Buffer.alloc(0),
    onBodyChunk?: (chunk: Buffer) => void,
  ): Promise<HttpResponse> {
    if (this.pending) throw new Error("Concurrent ACP HTTP requests are not supported");
    const requestHeaders = {
      Host: `${this.hostname}:${this.port}`,
      Connection: "keep-alive",
      "Content-Length": String(body.byteLength),
      ...headers,
    };
    const head = `${method} ${pathname} HTTP/1.1\r\n${Object.entries(requestHeaders)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n")}\r\n\r\n`;
    const response = new Promise<HttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("ACP HTTP response timed out"));
        this.socket.destroy();
      }, this.timeoutMs);
      const parser = new IncrementalHttpResponseParser(onBodyChunk, (parsed) => {
        const pending = this.pending;
        if (!pending) return;
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(parsed);
      });
      this.pending = { resolve, reject, timer, parser };
    });
    this.socket.write(Buffer.concat([Buffer.from(head, "utf8"), body]));
    return await response;
  }

  close(): void {
    this.socket.destroy();
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    this.pending = undefined;
    clearTimeout(timer);
    reject(error);
  }
}

class IncrementalHttpResponseParser {
  private buffer = Buffer.alloc(0);
  private statusCode: number | null = null;
  private headers: Map<string, string> | null = null;
  private remainingContentLength: number | null = null;
  private chunkBytesRemaining: number | null = null;
  private awaitingChunkBoundary = false;
  private awaitingFinalChunkBoundary = false;
  private totalBytes = 0;
  private readonly body: Buffer[] = [];
  private completed = false;

  constructor(
    private readonly onBodyChunk: ((chunk: Buffer) => void) | undefined,
    private readonly onComplete: (response: HttpResponse) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.completed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.consume();
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private consume(): void {
    if (!this.headers && !this.consumeHeaders()) return;
    if (this.remainingContentLength !== null) {
      this.consumeContentLength();
      return;
    }
    this.consumeChunked();
  }

  private consumeHeaders(): boolean {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return false;
    const headerLines = this.buffer.subarray(0, headerEnd).toString("latin1").split("\r\n");
    const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/u.exec(headerLines.shift() ?? "");
    if (!statusMatch) throw new Error("ACP HTTP response had an invalid status line");
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("ACP HTTP response had an invalid header");
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const contentLength = headers.get("content-length");
    if (contentLength !== undefined) {
      const length = Number(contentLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HTTP_BODY_BYTES) {
        throw new Error("ACP HTTP response declared an invalid body length");
      }
      this.remainingContentLength = length;
    } else if (!headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
      throw new Error("ACP HTTP response omitted a bounded body framing header");
    }
    this.statusCode = Number(statusMatch[1]);
    this.headers = headers;
    this.buffer = this.buffer.subarray(headerEnd + 4);
    if (this.remainingContentLength === 0) this.finish();
    return true;
  }

  private consumeContentLength(): void {
    if (this.remainingContentLength === null || this.completed) return;
    const length = Math.min(this.buffer.byteLength, this.remainingContentLength);
    if (length > 0) this.emit(this.take(length));
    this.remainingContentLength -= length;
    if (this.remainingContentLength === 0) this.finish();
  }

  private consumeChunked(): void {
    while (!this.completed) {
      if (this.awaitingFinalChunkBoundary) {
        if (this.buffer.byteLength < 2) return;
        if (this.buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
          this.buffer = this.buffer.subarray(2);
          this.finish();
          return;
        }
        const trailersEnd = this.buffer.indexOf("\r\n\r\n");
        if (trailersEnd < 0) return;
        this.buffer = this.buffer.subarray(trailersEnd + 4);
        this.finish();
        return;
      }
      if (this.awaitingChunkBoundary) {
        if (this.buffer.byteLength < 2) return;
        if (!this.buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
          throw new Error("ACP HTTP response had an invalid chunk boundary");
        }
        this.buffer = this.buffer.subarray(2);
        this.awaitingChunkBoundary = false;
        this.chunkBytesRemaining = null;
      }
      if (this.chunkBytesRemaining === null) {
        const lineEnd = this.buffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const sizeText = this.buffer.subarray(0, lineEnd).toString("ascii").split(";", 1)[0] ?? "";
        if (!/^[0-9a-f]+$/iu.test(sizeText)) throw new Error("ACP HTTP response had an invalid chunk size");
        const size = Number.parseInt(sizeText, 16);
        this.buffer = this.buffer.subarray(lineEnd + 2);
        if (size === 0) {
          this.awaitingFinalChunkBoundary = true;
          continue;
        }
        this.chunkBytesRemaining = size;
      }
      const length = Math.min(this.buffer.byteLength, this.chunkBytesRemaining);
      if (length === 0) return;
      this.emit(this.take(length));
      this.chunkBytesRemaining -= length;
      if (this.chunkBytesRemaining === 0) this.awaitingChunkBoundary = true;
    }
  }

  private take(length: number): Buffer {
    const value = Buffer.from(this.buffer.subarray(0, length));
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  private emit(value: Buffer): void {
    this.totalBytes += value.byteLength;
    if (this.totalBytes > MAX_HTTP_BODY_BYTES) throw new Error("ACP HTTP response exceeded its body limit");
    this.body.push(value);
    this.onBodyChunk?.(value);
  }

  private finish(): void {
    if (this.completed || this.statusCode === null || !this.headers) return;
    this.completed = true;
    this.onComplete({ statusCode: this.statusCode, headers: this.headers, body: Buffer.concat(this.body) });
  }
}

function replayFingerprint(messageIds: string[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(messageIds)).digest("hex");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`ACP ${label} was not valid JSON`);
  }
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => (secret ? result.replaceAll(secret, "[REDACTED]") : result), value);
}
