import { connect, type Socket } from "node:net";
import type {
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  RuntimeActivity,
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
  RuntimeModelOption,
  RuntimeSessionOption,
} from "./types";
import { workBuddySubmittedUserLiveNativeId, workBuddySubmittedUserMessageId } from "./workbuddy-activity-identity";
import {
  WorkBuddyDiscoveryError,
  type WorkBuddyEndpointVerification,
  type WorkBuddyProcessIdentity,
  type WorkBuddyProfile,
  workBuddyProfileCompatibility,
} from "./workbuddy-task-discovery";

const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;

export interface WorkBuddyConnectedSocketIdentity {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

export interface WorkBuddyAcpTaskAttachment extends ConnectRuntimeSession {
  readonly verification: WorkBuddyEndpointVerification;
  readonly catalog?: WorkBuddyTaskCatalog;
  onCatalogChanged?(listener: () => void): () => void;
}

export interface WorkBuddySlashCatalogEntry {
  id: string;
  kind: "command" | "skill";
  name: string;
  description?: string;
  nativeName: string;
}

export interface WorkBuddyModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface WorkBuddyTaskCatalog {
  models: RuntimeModelOption[];
  currentModelId: string | null;
  modes: WorkBuddyModeOption[];
  currentModeId: string | null;
  configOptions: RuntimeSessionOption[];
  currentConfig: Record<string, string>;
  commands: WorkBuddySlashCatalogEntry[];
  skills: WorkBuddySlashCatalogEntry[];
}

export class WorkBuddyPromptTransportError extends Error {
  readonly name = "WorkBuddyPromptTransportError";
  readonly nativeAcceptance = "uncertain" as const;

  constructor(options?: ErrorOptions) {
    super("WorkBuddy prompt transport failed after transmission; native acceptance is uncertain.", options);
  }
}

export class WorkBuddyTaskBusyError extends Error {
  readonly name = "WorkBuddyTaskBusyError";
  readonly code = "task-busy" as const;

  constructor() {
    super("WorkBuddy Task is busy in another UI; wait for it to become idle and retry");
  }
}

class WorkBuddyRpcRejectionError extends Error {
  readonly name = "WorkBuddyRpcRejectionError";
}

export async function verifyWorkBuddyEndpoint(
  input: WorkBuddyAcpEndpointInput,
  timeoutMs: number,
  readConnectedOwner: (identity: WorkBuddyConnectedSocketIdentity) => Promise<WorkBuddyProcessIdentity | null>,
): Promise<WorkBuddyEndpointVerification> {
  const attachment = await openWorkBuddyTaskEndpoint(input, timeoutMs, readConnectedOwner);
  try {
    return { ...attachment.verification, ...(attachment.catalog ? { catalog: attachment.catalog } : {}) };
  } finally {
    await attachment.close();
  }
}

export async function openWorkBuddyTaskEndpoint(
  input: WorkBuddyAcpEndpointInput,
  timeoutMs: number,
  readConnectedOwner: (identity: WorkBuddyConnectedSocketIdentity) => Promise<WorkBuddyProcessIdentity | null>,
): Promise<WorkBuddyAcpTaskAttachment> {
  let connectionId = "";
  let sessionToken = "";
  const connection = await PersistentHttpConnection.open(input.endpoint, timeoutMs);
  const teardown = async (): Promise<void> => {
    if (connectionId) {
      await connection
        .request("DELETE", connection.pathname, acpHeaders(connectionId, sessionToken))
        .catch(() => undefined);
    }
    connection.close();
  };
  try {
    const bootstrap = await connection.request("POST", `${connection.pathname}/connect`, {
      "x-codebuddy-request": "1",
    });
    if (bootstrap.statusCode === 401 || bootstrap.statusCode === 403) {
      throw new WorkBuddyDiscoveryError(
        "authentication-failed",
        "WorkBuddy AI rejected the reacquired ACP authorization for this Task Attachment.",
      );
    }
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
    const catalogState = new WorkBuddyTaskCatalogState();
    const initialized = await postRpc(
      connection,
      headers,
      1,
      "initialize",
      {
        protocolVersion: input.acpVersion,
        clientInfo: { name: "clawchat-connect-discovery", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      undefined,
      catalogState,
    );
    const initializedProtocol = (initialized.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (initializedProtocol !== input.acpVersion) {
      const profile = input.profile ?? "workbuddy-ai";
      const compatibility = workBuddyProfileCompatibility(profile);
      throw new WorkBuddyDiscoveryError(
        "protocol-incompatible",
        `The ${compatibility.displayName} ACP protocol version is unsupported for profile ${profile}.`,
        {
          selectedProfile: profile,
          detectedAcpVersion: initializedProtocol ?? "[missing]",
          supportedAcpVersion: input.acpVersion,
        },
      );
    }
    const loaded = await postRpc(
      connection,
      headers,
      2,
      "session/load",
      {
        sessionId: input.taskId,
        cwd: input.workspace,
        mcpServers: [],
      },
      undefined,
      catalogState,
    );
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
    let nextLiveTurnOrdinal = nextTurnOrdinal(verification.activities);
    let nextRequestId = 3;
    let closed = false;
    let activePrompt: WorkBuddyPromptOperation | null = null;
    let nativeBusy = false;
    let externalProjector: OutOfBandTurnProjector | null = null;
    const bufferedExternalActivities: RuntimeActivity[] = [];
    const broadcastAbort = new AbortController();
    const broadcastTask = consumeWorkBuddyBroadcast(input.endpoint, headers, broadcastAbort.signal, (payload) => {
      if (!isTaskUpdate(payload, input.taskId)) return;
      catalogState.observe(payload);
      if (activePrompt) {
        activePrompt.observeBroadcast(payload);
        return;
      }
      const update = taskUpdate(payload);
      const phase = nativeAgentPhase(update);
      if (phase && phase !== "idle") nativeBusy = true;
      if (update && isTranscriptUpdate(update)) {
        nativeBusy = true;
        if (!externalProjector) externalProjector = new OutOfBandTurnProjector(nextLiveTurnOrdinal++);
        bufferedExternalActivities.push(...externalProjector.observe(update));
      }
      if (update?.sessionUpdate === "session_end" || phase === "idle") {
        if (externalProjector) bufferedExternalActivities.push(...externalProjector.complete(update?.stopReason));
        externalProjector = null;
        nativeBusy = false;
      }
    }).catch(() => undefined);
    const postSidebandRpc = async (method: string, params: unknown): Promise<RpcObservation> => {
      const sideband = await PersistentHttpConnection.open(input.endpoint, timeoutMs);
      try {
        return await postRpc(sideband, headers, nextRequestId++, method, params, undefined, catalogState);
      } finally {
        sideband.close();
      }
    };
    const postSidebandEnvelope = async (envelope: Record<string, unknown>): Promise<void> => {
      const sideband = await PersistentHttpConnection.open(input.endpoint, timeoutMs);
      try {
        await postRpcEnvelope(sideband, headers, envelope);
      } finally {
        sideband.close();
      }
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      broadcastAbort.abort();
      activePrompt?.expire("WorkBuddy Task Attachment was closed");
      activePrompt = null;
      await broadcastTask;
      await teardown();
    };
    return {
      verification,
      get catalog() {
        return catalogState.snapshot();
      },
      onCatalogChanged: (listener) => catalogState.onChanged(listener),
      prompt: (promptInput) => {
        if (closed) throw new Error("WorkBuddy Task Attachment is closed");
        if (activePrompt) throw new Error("WorkBuddy Task already has an active Connect prompt");
        if (nativeBusy) throw new WorkBuddyTaskBusyError();
        const operation = new WorkBuddyPromptOperation(
          connection,
          headers,
          input.taskId,
          nextLiveTurnOrdinal++,
          promptInput,
          catalogState,
          nextRequestId++,
          timeoutMs,
          postSidebandRpc,
          postSidebandEnvelope,
          bufferedExternalActivities.splice(0),
          () => {
            if (activePrompt === operation) activePrompt = null;
          },
        );
        activePrompt = operation;
        operation.start();
        return operation;
      },
      cancel: async () => (await activePrompt?.cancel()) ?? false,
      close,
    };
  } catch (error) {
    await teardown();
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    throw new Error(redact(error instanceof Error ? error.message : String(error), [connectionId, sessionToken]));
  }
}

interface WorkBuddyAcpEndpointInput {
  profile?: WorkBuddyProfile;
  endpoint: string;
  taskId: string;
  workspace: string;
  acpVersion: number;
}

export const verifyWorkBuddyAiEndpoint = verifyWorkBuddyEndpoint;
export const openWorkBuddyAiTaskEndpoint = openWorkBuddyTaskEndpoint;

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
  catalog?: WorkBuddyTaskCatalogState,
): Promise<RpcObservation> {
  const decoder = new SseDecoder((payload) => {
    observeRpcPayload(payload, id, observation);
    catalog?.observe(payload);
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
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new WorkBuddyDiscoveryError(
      "authentication-failed",
      "WorkBuddy AI rejected the reacquired ACP authorization for this Task Attachment.",
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new WorkBuddyRpcRejectionError(`ACP ${method} failed with HTTP ${response.statusCode}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    decoder.finish();
  } else {
    const payload = parseJson(response.body.toString("utf8"), `${method} response`);
    observeRpcPayload(payload, id, observation);
    catalog?.observe(payload);
    onPayload?.(payload);
  }
  if (observation.result === undefined) throw new Error(`ACP ${method} returned no JSON-RPC result`);
  return observation;
}

class WorkBuddyTaskCatalogState {
  private value: WorkBuddyTaskCatalog = emptyWorkBuddyTaskCatalog();
  private readonly listeners = new Set<() => void>();

  snapshot(): WorkBuddyTaskCatalog {
    return structuredClone(this.value);
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(payload: unknown): void {
    const message = record(payload);
    if (!message) return;
    const before = JSON.stringify(this.value);
    const result = record(message.result);
    if (result) this.observeResult(result);
    if (message.method === "session/update") {
      const update = record(record(message.params)?.update);
      if (update) this.observeUpdate(update);
    }
    if (JSON.stringify(this.value) !== before) for (const listener of this.listeners) listener();
  }

  private observeResult(result: Record<string, unknown>): void {
    const models = record(result.models);
    if (models) this.replaceModels(models);
    const modes = record(result.modes);
    if (modes) this.replaceModes(modes);
    if (Array.isArray(result.configOptions)) this.replaceConfigOptions(result.configOptions);
    if (typeof result.modelId === "string" && result.modelId.trim()) {
      this.value.currentModelId = result.modelId.trim();
      this.markCurrentModelDefault();
    }
  }

  private observeUpdate(update: Record<string, unknown>): void {
    const kind = update.sessionUpdate;
    if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
      const entries = update.availableCommands.flatMap(workBuddySlashEntry);
      this.value.commands = entries.filter((entry) => entry.kind === "command");
      this.value.skills = entries.filter((entry) => entry.kind === "skill");
      return;
    }
    if (kind === "current_mode_update" && typeof update.currentModeId === "string") {
      this.value.currentModeId = update.currentModeId;
      return;
    }
    if (kind === "mode_update") {
      this.replaceModes(update);
      return;
    }
    if ((kind === "config_option_update" || kind === "config_options_update") && Array.isArray(update.configOptions)) {
      this.replaceConfigOptions(update.configOptions);
    }
  }

  private replaceModels(models: Record<string, unknown>): void {
    const currentModelId = stringValue(models.currentModelId);
    const parsed = Array.isArray(models.availableModels)
      ? models.availableModels.flatMap((candidate): RuntimeModelOption[] => {
          const native = record(candidate);
          const id = native ? stringValue(native.modelId) : null;
          if (!native || !id) return [];
          return [workBuddyModelOption(native, id, id === currentModelId)];
        })
      : [];
    if (currentModelId && !parsed.some((model) => model.id === currentModelId)) {
      parsed.unshift(workBuddyModelOption({ name: currentModelId }, currentModelId, true));
    }
    this.value.models = parsed;
    this.value.currentModelId = currentModelId;
    this.markCurrentModelDefault();
  }

  private replaceModes(modes: Record<string, unknown>): void {
    if (Array.isArray(modes.availableModes)) {
      this.value.modes = modes.availableModes.flatMap((candidate): WorkBuddyModeOption[] => {
        const native = record(candidate);
        const id = native ? stringValue(native.id) : null;
        if (!native || !id) return [];
        return [{ id, name: stringValue(native.name) ?? id, ...optionalDescription(native.description) }];
      });
    }
    const currentModeId = stringValue(modes.currentModeId);
    if (currentModeId) this.value.currentModeId = currentModeId;
  }

  private replaceConfigOptions(options: unknown[]): void {
    const parsed = options.flatMap(workBuddySessionOption);
    this.value.configOptions = parsed.map((entry) => entry.option);
    this.value.currentConfig = Object.fromEntries(
      parsed.flatMap((entry) => (entry.currentValue ? [[entry.option.id, entry.currentValue] as const] : [])),
    );
    const model = this.value.currentConfig.model;
    if (model) {
      this.value.currentModelId = model;
      this.markCurrentModelDefault();
    }
    const mode = this.value.currentConfig.mode;
    if (mode) this.value.currentModeId = mode;
  }

  private markCurrentModelDefault(): void {
    const current = this.value.currentModelId;
    if (!current) return;
    if (!this.value.models.some((model) => model.id === current)) {
      this.value.models.unshift(workBuddyModelOption({ name: current }, current, true));
    }
    this.value.models = this.value.models.map((model) => ({ ...model, isDefault: model.id === current }));
  }
}

function emptyWorkBuddyTaskCatalog(): WorkBuddyTaskCatalog {
  return {
    models: [],
    currentModelId: null,
    modes: [],
    currentModeId: null,
    configOptions: [],
    currentConfig: {},
    commands: [],
    skills: [],
  };
}

function workBuddyModelOption(native: Record<string, unknown>, id: string, isDefault: boolean): RuntimeModelOption {
  return {
    id,
    displayName: stringValue(native.name) ?? id,
    description: stringValue(native.description) ?? "WorkBuddy Task model",
    isDefault,
    defaultReasoningEffort: "default",
    supportedReasoningEfforts: ["default"],
    inputModalities: ["text"],
    turnSubmissionCapability: {
      prompt: { allowed: true, required: true, maxCharacters: 64_000 },
      attachments: { allowedKinds: [], allowedMediaTypes: [], maxCount: 0 },
    },
  };
}

function workBuddySlashEntry(candidate: unknown): WorkBuddySlashCatalogEntry[] {
  const native = record(candidate);
  const nativeName = native ? stringValue(native.name)?.replace(/^\/+/, "") : null;
  if (!native || !nativeName) return [];
  const meta = record(native._meta);
  const kind = meta?.type === "skill" ? "skill" : "command";
  return [
    {
      id: `workbuddy-${kind}:${nativeName}`,
      kind,
      name: nativeName,
      nativeName,
      ...optionalDescription(native.description),
    },
  ];
}

function workBuddySessionOption(
  candidate: unknown,
): Array<{ option: RuntimeSessionOption; currentValue: string | null }> {
  const native = record(candidate);
  const id = native ? stringValue(native.id) : null;
  if (!native || !id || id === "model") return [];
  const values = Array.isArray(native.options)
    ? native.options.flatMap((candidate): RuntimeSessionOption["values"] => {
        const value = record(candidate);
        const valueId = value ? stringValue(value.value) : null;
        if (!value || !valueId) return [];
        return [
          { id: valueId, displayName: stringValue(value.name) ?? valueId, ...optionalDescription(value.description) },
        ];
      })
    : [];
  return [
    {
      option: {
        id,
        displayName: stringValue(native.name) ?? id,
        description: stringValue(native.description) ?? "WorkBuddy Task configuration",
        category: id === "mode" || id === "sandbox" || id === "thought_level" ? "execution" : "other",
        changePolicy: "in-place",
        values,
      },
      currentValue: stringValue(native.currentValue),
    },
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalDescription(value: unknown): { description?: string } {
  const description = stringValue(value);
  return description ? { description } : {};
}

async function postRpcEnvelope(
  connection: PersistentHttpConnection,
  headers: Record<string, string>,
  envelope: Record<string, unknown>,
): Promise<void> {
  const response = await connection.request(
    "POST",
    connection.pathname,
    headers,
    Buffer.from(JSON.stringify(envelope)),
  );
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new WorkBuddyDiscoveryError(
      "authentication-failed",
      "WorkBuddy AI rejected the reacquired ACP authorization for this Task Attachment.",
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new WorkBuddyRpcRejectionError(
      `ACP ${String(envelope.method ?? "response")} failed with HTTP ${response.statusCode}`,
    );
  }
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
    if (message.error) throw new WorkBuddyRpcRejectionError("ACP JSON-RPC request failed");
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
  "config_option_update",
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

function resolveWorkBuddySlashSelection(
  catalog: WorkBuddyTaskCatalog,
  input: ConnectRuntimePrompt,
): WorkBuddySlashCatalogEntry | null {
  const selected = input.command ?? input.skill;
  if (!selected) return null;
  const kind = input.command ? "command" : "skill";
  const entries = kind === "command" ? catalog.commands : catalog.skills;
  const native = entries.find((entry) => entry.id === selected.id && entry.name === selected.name);
  if (!native) {
    const label = kind === "command" ? "Command" : "Skill";
    throw new Error(`WorkBuddy ${label} is no longer available: ${selected.name}`);
  }
  return native;
}

function validateWorkBuddyConfig(catalog: WorkBuddyTaskCatalog, input: ConnectRuntimePrompt): Array<[string, string]> {
  const selected = { ...(input.sessionOptions ?? {}) };
  if (input.reasoningEffort && input.reasoningEffort !== "default" && !selected.thought_level) {
    selected.thought_level = input.reasoningEffort;
  }
  const definitions = new Map(catalog.configOptions.map((option) => [option.id, option]));
  for (const [id, value] of Object.entries(selected)) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`WorkBuddy configuration is no longer available: ${id}`);
    if (!definition.values.some((candidate) => candidate.id === value)) {
      throw new Error(`WorkBuddy configuration value is no longer available: ${id}=${value}`);
    }
  }
  return Object.entries(selected);
}

function nativeSlashPrompt(prompt: string, nativeName: string): string {
  const match = /^\/?\S+\s*([\s\S]*)$/u.exec(prompt);
  const argumentsText = match?.[1]?.trim() ?? "";
  return `/${nativeName}${argumentsText ? ` ${argumentsText}` : ""}`;
}

interface WorkBuddyPromptSelection {
  input: ConnectRuntimePrompt;
  previous: WorkBuddyTaskCatalog;
  modelId: string | null;
  modeId: string | null;
  config: Array<[string, string]>;
}

function selectWorkBuddyPrompt(
  catalog: WorkBuddyTaskCatalogState,
  input: ConnectRuntimePrompt,
): WorkBuddyPromptSelection {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("WorkBuddy text prompt is required");
  if (prompt.length > 64_000) throw new Error("WorkBuddy text prompt exceeds the 64000-character limit");
  if (input.media?.length) throw new Error("WorkBuddy Task Attachments currently support text turns only");
  const previous = catalog.snapshot();
  const selectedSlash = resolveWorkBuddySlashSelection(previous, input);
  const selectedMode = input.mode ? previous.modes.find((mode) => mode.id === input.mode) : undefined;
  if (input.mode && !selectedMode) throw new Error(`WorkBuddy mode is no longer available: ${input.mode}`);
  const selectedModel = input.model
    ? previous.models.find((model) => model.id.toLowerCase() === input.model?.trim().toLowerCase())
    : undefined;
  if (input.model && !selectedModel) throw new Error(`WorkBuddy model is no longer available: ${input.model}`);
  return {
    input: selectedSlash ? { ...input, prompt: nativeSlashPrompt(prompt, selectedSlash.nativeName) } : input,
    previous,
    modelId: selectedModel?.id ?? null,
    modeId: selectedMode?.id ?? null,
    config: validateWorkBuddyConfig(previous, input),
  };
}

async function applyWorkBuddyPromptSelection(
  taskId: string,
  selection: WorkBuddyPromptSelection,
  postRpc: (method: string, params: unknown) => Promise<RpcObservation>,
): Promise<void> {
  if (selection.modelId && selection.modelId !== selection.previous.currentModelId) {
    await postRpc("session/set_model", { sessionId: taskId, modelId: selection.modelId });
  }
  if (selection.modeId && selection.modeId !== selection.previous.currentModeId) {
    await postRpc("session/set_mode", { sessionId: taskId, modeId: selection.modeId });
  }
  for (const [configId, value] of selection.config) {
    if (selection.previous.currentConfig[configId] === value) continue;
    await postRpc("session/set_config_option", { sessionId: taskId, configId, value });
  }
}

async function consumeWorkBuddyBroadcast(
  endpoint: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onPayload: (payload: unknown) => void,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "acp-connection-id": headers["acp-connection-id"] ?? "",
      ...(headers["acp-session-token"] ? { "acp-session-token": headers["acp-session-token"] } : {}),
    },
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new WorkBuddyDiscoveryError(
      "authentication-failed",
      "WorkBuddy AI rejected the reacquired ACP authorization for this Task Attachment.",
    );
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) return;
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  const sse = new SseDecoder(onPayload);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sse.push(decoder.decode(value, { stream: true }));
    }
    sse.push(decoder.decode());
    sse.finish();
  } finally {
    reader.releaseLock();
  }
}

function nativeAgentPhase(update: Record<string, unknown> | null): string | null {
  if (update?.sessionUpdate !== "session_info_update") return null;
  const meta = update._meta as Record<string, unknown> | undefined;
  const phase = meta?.["codebuddy.ai/agentPhase"];
  return phase && typeof phase === "object" ? stringField(phase as Record<string, unknown>, "phase") : null;
}

function isTranscriptUpdate(update: Record<string, unknown> | null): boolean {
  return (
    update?.sessionUpdate === "user_message_chunk" ||
    update?.sessionUpdate === "agent_message_chunk" ||
    update?.sessionUpdate === "agent_thought_chunk" ||
    update?.sessionUpdate === "tool_call" ||
    update?.sessionUpdate === "tool_call_update" ||
    update?.sessionUpdate === "plan"
  );
}

class OutOfBandTurnProjector {
  private readonly activities = new Map<string, RuntimeActivity>();
  private nextItem = 1;
  private terminal = false;

  constructor(private readonly turn: number) {}

  observe(update: Record<string, unknown>): RuntimeActivity[] {
    if (this.terminal) return [];
    const updateKind = stringField(update, "sessionUpdate") ?? "";
    const messageKind = replayMessageKind(updateKind);
    if (messageKind) {
      const nativeId = stringField(update, "messageId");
      const text = visibleText(update.content);
      if (!nativeId || !text) return [];
      return [
        this.upsert(
          `${messageKind}:${nativeId}`,
          messageKind,
          nativeId,
          text,
          messageKind === "user" ? "complete" : "streaming",
          true,
        ),
      ];
    }
    if (updateKind === "tool_call" || updateKind === "tool_call_update") {
      const nativeId = stringField(update, "toolCallId", "callId", "id");
      if (!nativeId) return [];
      const status = stringField(update, "status") ?? "running";
      const text = visibleText(update.content) || stringField(update, "title", "name") || "WorkBuddy tool activity";
      return [this.upsert(`tool:${nativeId}`, "tool", nativeId, text, toolState(status), false)];
    }
    if (updateKind === "plan") {
      const nativeId = stringField(update, "planId", "id") ?? "current";
      return [this.upsert(`plan:${nativeId}`, "plan", nativeId, planText(update.entries), "streaming", false)];
    }
    return [];
  }

  complete(stopReason: unknown): RuntimeActivity[] {
    if (this.terminal) return [];
    this.terminal = true;
    const state = terminalState(stopReason);
    const updates: RuntimeActivity[] = [];
    for (const [key, activity] of this.activities) {
      if (activity.state === "complete" || activity.state === "error" || activity.state === "cancelled") continue;
      const completed = { ...activity, state };
      this.activities.set(key, completed);
      updates.push(completed);
    }
    return updates;
  }

  private upsert(
    key: string,
    kind: RuntimeActivity["kind"],
    nativeId: string,
    text: string,
    state: RuntimeActivity["state"],
    append: boolean,
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
      data: { ...existing?.data, deliveryDisposition: "projection-only" },
    };
    this.activities.set(key, activity);
    return activity;
  }
}

class WorkBuddyPromptOperation implements AsyncIterable<RuntimeActivity> {
  private readonly queue = new AsyncActivityQueue();
  private projector: LiveTurnProjector;
  private input: ConnectRuntimePrompt;
  private readonly interactions = new Map<string, NativeInteraction>();
  private readonly interactionTasks = new Set<Promise<void>>();
  private accepted: Promise<void> | null = null;
  private settled = false;
  private cancelled = false;

  constructor(
    private readonly connection: PersistentHttpConnection,
    private readonly headers: Record<string, string>,
    private readonly taskId: string,
    private readonly turnOrdinal: number,
    input: ConnectRuntimePrompt,
    private readonly catalog: WorkBuddyTaskCatalogState,
    private readonly requestId: number,
    private readonly timeoutMs: number,
    private readonly postSidebandRpc: (method: string, params: unknown) => Promise<RpcObservation>,
    private readonly postSidebandEnvelope: (envelope: Record<string, unknown>) => Promise<void>,
    private readonly preface: RuntimeActivity[],
    private readonly onSettled: () => void,
  ) {
    this.input = input;
    this.projector = new LiveTurnProjector(turnOrdinal, input);
  }

  start(): void {
    for (const activity of this.preface) this.queue.push(activity);
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const selection = selectWorkBuddyPrompt(this.catalog, this.input);
      this.input = selection.input;
      this.projector = new LiveTurnProjector(this.turnOrdinal, this.input);
      await applyWorkBuddyPromptSelection(this.taskId, selection, this.postSidebandRpc);
    } catch (error) {
      this.failBeforePrompt(error);
      return;
    }
    if (this.settled) return;
    try {
      const userMessageId = workBuddySubmittedUserMessageId(this.input, this.requestId);
      const observation = await postRpc(
        this.connection,
        this.headers,
        this.requestId,
        "session/prompt",
        {
          sessionId: this.taskId,
          prompt: [{ type: "text", text: this.input.prompt }],
          _meta: {
            messageId: userMessageId,
            "codebuddy.ai": { userMessageId, messageRequestId: userMessageId },
          },
        },
        (payload) => this.observe(payload),
        this.catalog,
      );
      await this.accepted;
      await Promise.allSettled([...this.interactionTasks]);
      if (this.settled) return;
      for (const activity of this.projector.complete(observation.result)) this.queue.push(activity);
      this.finish();
    } catch (error) {
      this.fail(error);
    }
  }

  private failBeforePrompt(error: unknown): void {
    if (this.settled) return;
    this.expireInteractions("WorkBuddy prompt validation or configuration failed");
    this.settled = true;
    this.onSettled();
    this.queue.fail(error instanceof Error ? error : new Error(String(error)));
  }

  async cancel(): Promise<boolean> {
    if (this.settled || this.cancelled) return false;
    this.cancelled = true;
    this.expireInteractions("WorkBuddy prompt was cancelled");
    await this.postSidebandEnvelope({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.taskId },
    });
    return true;
  }

  expire(reason: string): void {
    if (this.settled) return;
    this.expireInteractions(reason);
    this.settled = true;
    this.onSettled();
    this.queue.fail(new Error(reason));
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeActivity> {
    return this.queue[Symbol.asyncIterator]();
  }

  observeBroadcast(payload: unknown): void {
    if (!isTaskUpdate(payload, this.taskId) || this.settled) return;
    this.observeNativeInteraction(payload);
  }

  private observe(payload: unknown): void {
    if (!isTaskUpdate(payload, this.taskId) || this.settled) return;
    if (!this.accepted) {
      this.accepted = this.input.onAccepted?.() ?? Promise.resolve();
      for (const activity of this.projector.accepted()) this.queue.push(activity);
    }
    this.observeNativeInteraction(payload);
    for (const activity of this.projector.observe(payload)) this.queue.push(activity);
  }

  private observeNativeInteraction(payload: unknown): void {
    const update = taskUpdate(payload);
    const meta = update?._meta as Record<string, unknown> | undefined;
    const interruption = meta?.["codebuddy.ai/interruptionRequest"];
    if (interruption && typeof interruption === "object") {
      this.routeInterruption(interruption as Record<string, unknown>);
    }
    const resolvedValue = meta?.["codebuddy.ai/permissionResolved"];
    if (!resolvedValue) return;
    const resolved = typeof resolvedValue === "object" ? (resolvedValue as Record<string, unknown>) : meta;
    const toolCallId = stringField(resolved ?? {}, "toolCallId", "codebuddy.ai/toolCallId", "interruptionId");
    const decision = stringField(resolved ?? {}, "decision", "codebuddy.ai/decision");
    if (toolCallId) this.resolveFromNativeUi(toolCallId, decision);
  }

  private routeInterruption(interruption: Record<string, unknown>): void {
    const toolCallId = stringField(interruption, "toolCallId", "interruptionId");
    if (!toolCallId || this.interactions.has(toolCallId)) return;
    const mapped = mapInterruption(interruption, this.input.workspace.workingDirectory);
    if (!mapped) return;
    const delivery = deferred<void>();
    void delivery.promise.catch(() => undefined);
    const interaction: NativeInteraction = {
      toolCallId,
      request: mapped,
      controller: new AbortController(),
      delivery,
      confirmation: deferred<void>(),
      expectedDecision: null,
      responseClaimed: false,
      settled: false,
    };
    void interaction.confirmation.promise.catch(() => undefined);
    this.interactions.set(toolCallId, interaction);
    const task = this.deliverInteraction(interaction).finally(() => this.interactionTasks.delete(task));
    this.interactionTasks.add(task);
  }

  private async deliverInteraction(interaction: NativeInteraction): Promise<void> {
    try {
      let response: RuntimeInteractionResponse;
      try {
        const sessionRef = this.input.metadata?.sessionRef;
        response =
          this.input.interactionPort && sessionRef && this.input.turnId && this.input.turnOrigin
            ? await this.input.interactionPort.request(interaction.request, {
                sessionRef,
                turnId: this.input.turnId,
                origin: this.input.turnOrigin,
                deliveryConfirmation: interaction.delivery.promise,
                signal: interaction.controller.signal,
              })
            : safeInteractionResponse(interaction.request);
      } catch {
        if (interaction.settled) return;
        response = safeInteractionResponse(interaction.request);
      }
      if (interaction.settled) return;
      interaction.responseClaimed = true;
      const resolution = interruptionResolution(this.taskId, interaction.toolCallId, interaction.request, response);
      interaction.expectedDecision = stringField(resolution, "decision");
      await this.postSidebandRpc("_codebuddy.ai/resolveInterruption", resolution);
      await withTimeout(
        interaction.confirmation.promise,
        this.timeoutMs,
        "WorkBuddy did not confirm the interaction response",
      );
      if (interaction.settled) return;
      interaction.settled = true;
      interaction.delivery.resolve();
      this.interactions.delete(interaction.toolCallId);
    } catch (error) {
      if (interaction.settled) return;
      interaction.settled = true;
      interaction.controller.abort(error);
      interaction.delivery.reject(error instanceof Error ? error : new Error(String(error)));
      interaction.confirmation.reject(error instanceof Error ? error : new Error(String(error)));
      this.interactions.delete(interaction.toolCallId);
    }
  }

  private resolveFromNativeUi(toolCallId: string, decision: string | null): void {
    const interaction = this.interactions.get(toolCallId);
    if (!interaction || interaction.settled) return;
    if (interaction.responseClaimed) {
      if (interaction.expectedDecision && decision && interaction.expectedDecision !== decision) {
        const error = new Error("WorkBuddy confirmed a different interaction response");
        interaction.settled = true;
        interaction.controller.abort(error);
        interaction.delivery.reject(error);
        interaction.confirmation.reject(error);
        this.interactions.delete(toolCallId);
        return;
      }
      interaction.confirmation.resolve();
      return;
    }
    const error = new Error("WorkBuddy interaction was resolved in another UI");
    interaction.settled = true;
    interaction.controller.abort(error);
    interaction.delivery.reject(error);
    interaction.confirmation.reject(error);
    this.interactions.delete(toolCallId);
  }

  private expireInteractions(reason: string): void {
    const error = new Error(reason);
    for (const interaction of this.interactions.values()) {
      if (interaction.settled) continue;
      interaction.settled = true;
      interaction.controller.abort(error);
      interaction.delivery.reject(error);
      interaction.confirmation.reject(error);
    }
    this.interactions.clear();
  }

  private finish(): void {
    if (this.settled) return;
    this.expireInteractions("WorkBuddy prompt completed");
    this.settled = true;
    this.onSettled();
    this.queue.end();
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.expireInteractions("WorkBuddy prompt transport settled before the interaction was confirmed");
    this.settled = true;
    this.onSettled();
    this.queue.fail(
      error instanceof WorkBuddyRpcRejectionError || error instanceof WorkBuddyDiscoveryError
        ? error
        : new WorkBuddyPromptTransportError({ cause: error instanceof Error ? error : new Error(String(error)) }),
    );
  }
}

interface NativeInteraction {
  toolCallId: string;
  request: RuntimeInteractionRequest;
  controller: AbortController;
  delivery: Deferred<void>;
  confirmation: Deferred<void>;
  expectedDecision: string | null;
  responseClaimed: boolean;
  settled: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function taskUpdate(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const params = (payload as Record<string, unknown>).params;
  if (!params || typeof params !== "object") return null;
  const update = (params as Record<string, unknown>).update;
  return update && typeof update === "object" ? (update as Record<string, unknown>) : null;
}

function mapInterruption(
  interruption: Record<string, unknown>,
  workingDirectory: string,
): RuntimeInteractionRequest | null {
  const toolName = stringField(interruption, "toolName", "name") ?? "a WorkBuddy tool";
  const title = stringField(interruption, "toolTitle", "title") ?? `Allow WorkBuddy to use ${toolName}?`;
  const input =
    interruption.toolInput && typeof interruption.toolInput === "object"
      ? (interruption.toolInput as Record<string, unknown>)
      : {};
  if (toolName === "AskUserQuestion") return mapQuestionInterruption(title, input);
  const options = Array.isArray(interruption.options) ? interruption.options : [];
  const mappedOptions: Extract<RuntimeInteractionRequest, { kind: "approval" }>["options"] = [];
  if (options.includes("allow")) mappedOptions.push({ id: "approve-once", label: "Allow" });
  if (options.includes("allowAll")) mappedOptions.push({ id: "approve-session", label: "Always allow" });
  if (options.includes("deny") || mappedOptions.length === 0) mappedOptions.push({ id: "deny", label: "Deny" });
  const command = stringField(input, "command");
  const cwd = stringField(input, "cwd") ?? workingDirectory;
  const action = isFileChangeTool(toolName) ? "file-change" : "command";
  const files = action === "file-change" ? fileChangeDetails(input) : [];
  return {
    kind: "approval",
    action,
    title,
    description:
      stringField(interruption, "description", "reason", "intention") ??
      `WorkBuddy requests permission to run ${toolName}.`,
    ...(action === "command" && command ? { command } : {}),
    ...(action === "command" && cwd ? { cwd } : {}),
    ...(action === "file-change" && files.length ? { files } : {}),
    options: mappedOptions,
  };
}

function mapQuestionInterruption(
  title: string,
  input: Record<string, unknown>,
): Extract<RuntimeInteractionRequest, { kind: "user-input" }> {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions = rawQuestions.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const question = value as Record<string, unknown>;
    const prompt = stringField(question, "question", "prompt");
    if (!prompt) return [];
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const record = option as Record<string, unknown>;
      const label = stringField(record, "label");
      if (!label) return [];
      const description = stringField(record, "description");
      return [
        {
          id: stringField(record, "id", "value") ?? label,
          label,
          ...(description ? { description } : {}),
        },
      ];
    });
    return [
      {
        id: stringField(question, "id") ?? `q_${index}`,
        header: stringField(question, "header") ?? `Question ${index + 1}`,
        prompt,
        secret: question.secret === true || question.isSecret === true || question.sensitive === true,
        allowOther: question.allowOther !== false && question.custom !== false,
        options: options.length ? options : null,
      },
    ];
  });
  return {
    kind: "user-input",
    title: title || "WorkBuddy needs your input",
    description: questions.length === 1 ? (questions[0]?.prompt ?? "") : `WorkBuddy has ${questions.length} questions.`,
    questions,
    autoResolutionMs: null,
  };
}

function isFileChangeTool(toolName: string): boolean {
  return /(?:edit|write|patch|delete|move|rename|file)/iu.test(toolName);
}

function fileChangeDetails(input: Record<string, unknown>): Array<{ path: string; diff?: string }> {
  const result = new Map<string, { path: string; diff?: string }>();
  const add = (path: string | null, diff?: string | null) => {
    if (!path) return;
    result.set(path, { path, ...(diff ? { diff } : {}) });
  };
  const directDiff = stringField(input, "diff", "patch");
  add(stringField(input, "file_path", "filePath", "path", "target"), directDiff ?? editDiff(input));
  const files = input.files;
  if (Array.isArray(files)) {
    for (const value of files) {
      if (typeof value === "string") {
        add(value);
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const file = value as Record<string, unknown>;
      add(stringField(file, "path", "file_path", "filePath"), stringField(file, "diff", "patch"));
    }
  }
  return [...result.values()];
}

function editDiff(input: Record<string, unknown>): string | null {
  const before = stringField(input, "old_string", "oldString", "before");
  const after = stringField(input, "new_string", "newString", "after");
  if (!before && !after) return null;
  return `${before ? `-${before}` : ""}${before && after ? "\n" : ""}${after ? `+${after}` : ""}`;
}

function safeInteractionResponse(request: RuntimeInteractionRequest): RuntimeInteractionResponse {
  return request.kind === "approval" ? { kind: "approval", optionId: "deny" } : { kind: "user-input", answers: {} };
}

function interruptionResolution(
  taskId: string,
  toolCallId: string,
  request: RuntimeInteractionRequest,
  response: RuntimeInteractionResponse,
): Record<string, unknown> {
  if (request.kind === "approval") {
    const optionId = response.kind === "approval" ? response.optionId : "deny";
    return {
      sessionId: taskId,
      toolCallId,
      decision: optionId === "approve-session" ? "allowAll" : optionId === "approve-once" ? "allow" : "deny",
    };
  }
  return {
    sessionId: taskId,
    toolCallId,
    decision: response.kind === "user-input" ? "allow" : "deny",
    ...(response.kind === "user-input" ? { answers: response.answers } : {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    const nativeId = workBuddySubmittedUserLiveNativeId(this.input, this.turn);
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
    const selection = this.input.command
      ? { kind: "command", id: this.input.command.id, name: this.input.command.name }
      : this.input.skill
        ? { kind: "skill", id: this.input.skill.id, name: this.input.skill.name }
        : null;
    const turn = this.input.turnId
      ? this.input.turnOrigin === "clawchat"
        ? { clawchatMessageId: this.input.turnId }
        : { clientMessageId: `turn_${this.input.turnId}_user` }
      : {};
    return selection ? { ...turn, runtimeSlashSelection: selection } : Object.keys(turn).length > 0 ? turn : undefined;
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
  private closed = false;
  private pending:
    | {
        resolve: (response: HttpResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | undefined;
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
        const pending = this.pending;
        if (!pending) return;
        this.refreshResponseTimeout();
        pending.parser.push(Buffer.from(chunk));
      } catch (error) {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });
    socket.on("error", (error) => this.rejectPending(error));
    socket.on("close", () => {
      this.closed = true;
      this.rejectPending(new Error("ACP HTTP connection closed unexpectedly"));
    });
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
    if (this.closed || this.socket.destroyed) throw new Error("ACP HTTP connection is closed");
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
      const parser = new IncrementalHttpResponseParser(onBodyChunk, (parsed) => {
        const pending = this.pending;
        if (!pending) return;
        this.pending = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(parsed);
      });
      this.pending = { resolve, reject, timer: undefined, parser };
      this.refreshResponseTimeout();
    });
    this.socket.write(Buffer.concat([Buffer.from(head, "utf8"), body]));
    return await response;
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    this.pending = undefined;
    if (timer) clearTimeout(timer);
    reject(error);
  }

  private refreshResponseTimeout(): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      pending.reject(new Error("ACP HTTP response timed out"));
      this.socket.destroy();
    }, this.timeoutMs);
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
