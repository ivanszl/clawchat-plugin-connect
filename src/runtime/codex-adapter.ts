import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_CODEX_APPROVAL_POLICY } from "../config";
import type { RuntimeOutputEvent } from "../output-visibility";
import type { CodexAgentBindingConfig, CodexApprovalPolicy, CodexSandboxMode, RuntimeWorkspace } from "../types";
import {
  type CodexAppServerClient,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
  type CodexAppServerThread,
  type CodexAppServerThreadItem,
  type CodexAppServerTurn,
  type CodexSandboxPolicy,
  type CodexUserInput,
  createCodexAppServerClient,
} from "./codex-app-server";
import { backfillCodexRolloutTranscript } from "./codex-rollout";
import { cacheRuntimeMedia } from "./media-cache";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimeMedia,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
  RuntimeInteractionPort,
  RuntimeModelOption,
  RuntimeThreadSummary,
  RuntimeTranscriptEntry,
} from "./types";

export interface CreateCodexRuntimeAdapterOptions {
  createAppServer?: (binding: CodexAgentBindingConfig) => Promise<CodexAppServerClient>;
  cacheMedia?: (media: ConnectRuntimeMedia, stateDbPath: string, trustedOrigins?: readonly string[]) => Promise<string>;
}

const SANDBOX_MODES: readonly CodexSandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export function createCodexRuntimeAdapter(options: CreateCodexRuntimeAdapterOptions = {}): ConnectRuntimeAdapter {
  const createAppServer = options.createAppServer ?? createCodexAppServerClient;
  const cacheMedia =
    options.cacheMedia ??
    (async (media: ConnectRuntimeMedia, stateDbPath: string, trustedOrigins?: readonly string[]) =>
      await cacheRuntimeMedia(media, stateDbPath, { trustedOrigins }));
  let bindingIdentity: string | null = null;
  let runtimeClientPromise: Promise<CodexAppServerClient> | null = null;
  let catalogClientPromise: Promise<CodexAppServerClient> | null = null;

  const clientFor = async (
    binding: CodexAgentBindingConfig,
    purpose: "runtime" | "catalog",
  ): Promise<CodexAppServerClient> => {
    const identity = processIdentity(binding);
    if (bindingIdentity && bindingIdentity !== identity) {
      throw new Error("The shared Codex app-server cannot be reused with a different executable or environment");
    }
    bindingIdentity = identity;
    const current = purpose === "runtime" ? runtimeClientPromise : catalogClientPromise;
    if (current) return await current;
    const created = createAppServer(binding).catch((error) => {
      if (purpose === "runtime") runtimeClientPromise = null;
      else catalogClientPromise = null;
      if (!runtimeClientPromise && !catalogClientPromise) {
        bindingIdentity = null;
      }
      throw error;
    });
    if (purpose === "runtime") runtimeClientPromise = created;
    else catalogClientPromise = created;
    return await created;
  };

  return {
    kind: "codex",
    modes: SANDBOX_MODES,
    async prepare(binding) {
      await clientFor(requireCodexBinding(binding), "runtime");
    },
    async listModels(binding) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexModels(await clientFor(codexBinding, "runtime"));
    },
    async discoverThreads(binding, workspace) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexThreads(await clientFor(codexBinding, "catalog"), workspace.workingDirectory);
    },
    async discoverAllThreads(binding) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexThreads(await clientFor(codexBinding, "catalog"));
    },
    async discoverArchivedThreads(binding) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexThreads(await clientFor(codexBinding, "catalog"), undefined, true);
    },
    async readTranscript(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      const appServerEntries = await readCodexTranscript(await clientFor(codexBinding, "catalog"), runtimeThreadId);
      return await backfillCodexRolloutTranscript({
        codexHome: codexHome(codexBinding),
        runtimeThreadId,
        appServerEntries,
      });
    },
    async archiveThread(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      await (await clientFor(codexBinding, "catalog")).archiveThread({ threadId: runtimeThreadId });
    },
    async unarchiveThread(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      await (await clientFor(codexBinding, "catalog")).unarchiveThread({ threadId: runtimeThreadId });
    },
    async deleteThread(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      await (await clientFor(codexBinding, "catalog")).deleteThread({ threadId: runtimeThreadId });
    },
    async start(binding, context) {
      const codexBinding = requireCodexBinding(binding);
      return new CodexRuntimeSession(await clientFor(codexBinding, "runtime"), codexBinding, context, cacheMedia);
    },
    async close() {
      const clients = [runtimeClientPromise, catalogClientPromise].filter(
        (client): client is Promise<CodexAppServerClient> => Boolean(client),
      );
      runtimeClientPromise = null;
      catalogClientPromise = null;
      bindingIdentity = null;
      await Promise.all(clients.map(async (client) => await (await client).close()));
    },
  };
}

async function discoverCodexModels(client: CodexAppServerClient): Promise<RuntimeModelOption[]> {
  const models: RuntimeModelOption[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await client.listModels({ cursor, limit: 100, includeHidden: false });
    models.push(
      ...page.data
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
          inputModalities: model.inputModalities ?? ["text", "image"],
        })),
    );
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("Codex app-server returned a repeated model/list cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return models;
}

async function readCodexTranscript(
  client: CodexAppServerClient,
  runtimeThreadId: string,
): Promise<RuntimeTranscriptEntry[]> {
  return (await readCodexThreadTranscript(client, runtimeThreadId, new Set(), new Map())).entries;
}

async function readCodexThreadTranscript(
  client: CodexAppServerClient,
  runtimeThreadId: string,
  ancestors: ReadonlySet<string>,
  reads: Map<string, Promise<{ thread: CodexAppServerThread }>>,
): Promise<{
  thread: CodexAppServerThread;
  entries: RuntimeTranscriptEntry[];
}> {
  const response = await readCodexThread(client, runtimeThreadId, reads);
  const entries: RuntimeTranscriptEntry[] = [];
  const lineage = new Set(ancestors).add(runtimeThreadId);
  const seenChildThreads = new Set<string>();
  for (const turn of response.thread.turns ?? []) {
    for (const item of turn.items) {
      if (item.type === "subAgentActivity") {
        const childThreadId = stringField(item.agentThreadId);
        if (!childThreadId || lineage.has(childThreadId) || seenChildThreads.has(childThreadId)) continue;
        seenChildThreads.add(childThreadId);
        entries.push(await subagentTranscriptEntry(client, item, childThreadId, lineage, reads));
        continue;
      }
      const entry = transcriptEntry(item, turn.status);
      if (entry) entries.push(entry);
    }
  }
  return { thread: response.thread, entries };
}

async function readCodexThread(
  client: CodexAppServerClient,
  runtimeThreadId: string,
  reads: Map<string, Promise<{ thread: CodexAppServerThread }>>,
) {
  const active = reads.get(runtimeThreadId);
  if (active) return await active;
  const read = client.readThread({ threadId: runtimeThreadId, includeTurns: true });
  reads.set(runtimeThreadId, read);
  return await read;
}

async function subagentTranscriptEntry(
  client: CodexAppServerClient,
  item: CodexAppServerThreadItem,
  childThreadId: string,
  lineage: ReadonlySet<string>,
  reads: Map<string, Promise<{ thread: CodexAppServerThread }>>,
): Promise<RuntimeTranscriptEntry> {
  const activityKind = stringField(item.kind) || "unknown";
  try {
    const child = await readCodexThreadTranscript(client, childThreadId, lineage, reads);
    const role = stringField(child.thread.agentRole) || null;
    const title =
      stringField(child.thread.agentNickname) ||
      normalizeThreadName(child.thread.name || child.thread.preview) ||
      childAgentPath(item) ||
      "Sub-agent";
    return {
      id: item.id,
      kind: "subagent",
      text: role && role !== title ? `${title} · ${role}` : title,
      state: childTranscriptState(child.thread.turns, activityKind),
      source: "history",
      data: { title, role, activityKind },
      children: child.entries,
    };
  } catch {
    const title = childAgentPath(item) || "Sub-agent";
    return {
      id: item.id,
      kind: "subagent",
      text: title,
      state: "error",
      source: "history",
      data: { title, role: null, activityKind },
      children: [
        {
          id: `${item.id}:unavailable`,
          kind: "unknown",
          text: "Sub-agent transcript is unavailable.",
          state: "error",
          source: "history",
        },
      ],
    };
  }
}

function childTranscriptState(
  turns: CodexAppServerThread["turns"],
  activityKind: string,
): RuntimeTranscriptEntry["state"] {
  if (activityKind === "interrupted") return "cancelled";
  const status = turns?.at(-1)?.status;
  if (status === "failed") return "error";
  if (status === "interrupted") return "cancelled";
  if (status === "inProgress") return "streaming";
  return "complete";
}

function childAgentPath(item: CodexAppServerThreadItem): string | null {
  const path = stringField(item.agentPath);
  return path ? (path.split(/[\\/]/u).filter(Boolean).at(-1) ?? null) : null;
}

function transcriptEntry(
  item: CodexAppServerThreadItem,
  turnStatus: CodexAppServerTurn["status"],
): RuntimeTranscriptEntry | null {
  const state =
    turnStatus === "failed"
      ? "error"
      : turnStatus === "interrupted"
        ? "cancelled"
        : turnStatus === "completed"
          ? "complete"
          : "streaming";
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content)
      ? item.content.flatMap((value) => {
          const part = recordField(value);
          return part?.type === "text" ? [stringField(part.text)] : [];
        })
      : [];
    return { id: item.id, kind: "user", text: content.join("\n"), state, source: "history" };
  }
  if (item.type === "agentMessage")
    return { id: item.id, kind: "assistant", text: stringField(item.text), state, source: "history" };
  if (item.type === "reasoning") {
    return {
      id: item.id,
      kind: "reasoning",
      text: [...stringArray(item.summary), ...stringArray(item.content)].join("\n"),
      state,
      source: "history",
    };
  }
  if (item.type === "plan")
    return { id: item.id, kind: "plan", text: stringField(item.text), state, source: "history" };
  if (item.type === "commandExecution") {
    return {
      id: item.id,
      kind: "command",
      text: stringField(item.aggregatedOutput),
      state,
      source: "history",
      data: {
        command: stringField(item.command),
        status: stringField(item.status),
        exitCode: numberField(item.exitCode),
      },
    };
  }
  if (item.type === "fileChange") {
    return {
      id: item.id,
      kind: "file-change",
      text: formatCompletedItem(item)?.text ?? "File changes",
      state,
      source: "history",
      data: { status: stringField(item.status), changes: item.changes },
    };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "webSearch") {
    return {
      id: item.id,
      kind: "tool",
      text: formatCompletedItem(item)?.text ?? item.type,
      state,
      source: "history",
      data: { itemType: item.type },
    };
  }
  return {
    id: item.id,
    kind: "unknown",
    text: item.type,
    state,
    source: "history",
    data: { itemType: item.type },
  };
}

function requireCodexBinding(binding: { kind: string }): CodexAgentBindingConfig {
  if (binding.kind !== "codex") throw new Error("Codex Runtime Adapter requires a Codex Agent Binding");
  return binding as CodexAgentBindingConfig;
}

function processIdentity(binding: CodexAgentBindingConfig): string {
  return JSON.stringify({ codexPathOverride: binding.codexPathOverride ?? null, env: binding.env ?? null });
}

function codexHome(binding: CodexAgentBindingConfig): string {
  return resolve(binding.env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
}

async function discoverCodexThreads(
  client: CodexAppServerClient,
  workingDirectory?: string,
  archived = false,
): Promise<RuntimeThreadSummary[]> {
  const summaries: RuntimeThreadSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await client.listThreads({
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [...THREAD_SOURCE_KINDS],
      archived,
      ...(workingDirectory ? { cwd: workingDirectory } : {}),
    });
    summaries.push(
      ...page.data
        .filter((thread) => !thread.parentThreadId)
        .map((thread) => ({
          runtimeThreadId: thread.id,
          ...(archived ? { isArchived: true } : {}),
          name: normalizeThreadName(thread.name || thread.preview),
          updatedAt: thread.updatedAt * 1_000,
          workingDirectory: thread.cwd,
          ...(isCodexAppScratchWorkspace(thread) ? { workspaceKind: "transient" as const } : {}),
        })),
    );
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("Codex app-server returned a repeated thread/list cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
}

function isCodexAppScratchWorkspace(thread: CodexAppServerThread): boolean {
  if (thread.source !== "vscode" || thread.gitInfo !== null) return false;
  const workspace = resolve(thread.cwd);
  const dateDirectory = dirname(workspace);
  const codexDirectory = dirname(dateDirectory);
  return (
    basename(dirname(codexDirectory)) === "Documents" &&
    basename(codexDirectory) === "Codex" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(basename(dateDirectory))
  );
}

function normalizeThreadName(value: string): string | null {
  const normalized = value
    .replace(/^ClawChat (?:direct|group) message from [^:]+:\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  return normalized.length <= 100 ? normalized : `${normalized.slice(0, 99).trimEnd()}…`;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  cancelled: boolean;
  bufferedNotifications: CodexAppServerNotification[];
  queue: RuntimeEventQueue;
  pendingAgentMessage: { itemId: string; text: string } | null;
  seenErrors: Set<string>;
  interactionPort: RuntimeInteractionPort | null;
  connectTurnId: string;
  turnOrigin: "client" | "clawchat";
  sessionRef: string;
  interactionControllers: Set<AbortController>;
  interactionControllersByRequestId: Map<string, AbortController>;
}

class CodexRuntimeSession implements ConnectRuntimeSession {
  private activeTurn: ActiveTurn | null = null;
  private runtimeSessionId: string | null;
  private threadWorkspaceKey: string | null = null;
  private closed = false;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly binding: CodexAgentBindingConfig,
    private readonly context: ConnectRuntimeStartContext,
    private readonly cacheMedia: (
      media: ConnectRuntimeMedia,
      stateDbPath: string,
      trustedOrigins?: readonly string[],
    ) => Promise<string>,
  ) {
    this.runtimeSessionId = context.runtimeSessionId;
  }

  async *prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeOutputEvent> {
    if (this.closed) throw new Error("Codex runtime session is closed");
    if (this.activeTurn) throw new Error("Codex already has an active turn for this session");
    const sandboxMode = resolveSandboxMode(input.mode, this.binding.sandboxMode);
    const threadId = await this.ensureThread(input.workspace, sandboxMode, input.model, input.reasoningEffort);
    const active: ActiveTurn = {
      threadId,
      turnId: null,
      cancelled: false,
      bufferedNotifications: [],
      queue: new RuntimeEventQueue(),
      pendingAgentMessage: null,
      seenErrors: new Set(),
      interactionPort: input.interactionPort ?? null,
      connectTurnId: input.turnId ?? `turn-${Date.now()}`,
      turnOrigin: input.turnOrigin ?? "client",
      sessionRef: input.metadata?.sessionRef ?? "",
      interactionControllers: new Set(),
      interactionControllersByRequestId: new Map(),
    };
    this.activeTurn = active;
    const removeNotificationListener = this.client.onNotification((notification) => {
      if (notification.method === "$transport/exited") {
        this.handleNotification(active, notification);
        return;
      }
      if (notificationThreadId(notification) !== active.threadId) return;
      if (!active.turnId) {
        active.bufferedNotifications.push(notification);
        return;
      }
      this.handleNotification(active, notification);
    });
    const removeRequestHandler = this.client.onRequest(
      async (request) => await this.handleServerRequest(active, request),
    );
    try {
      const turnInput = await this.buildTurnInput(input);
      const response = await this.client.startTurn({
        threadId,
        input: turnInput,
        cwd: input.workspace.workingDirectory,
        approvalPolicy: resolveApprovalPolicy(this.binding.approvalPolicy),
        sandboxPolicy: sandboxPolicy(
          input.workspace,
          sandboxMode,
          this.binding.networkAccessEnabled === true,
          this.binding.additionalDirectories ?? [],
        ),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
      });
      await input.onAccepted?.();
      active.turnId = response.turn.id;
      const buffered = active.bufferedNotifications.splice(0);
      for (const notification of buffered) this.handleNotification(active, notification);
      if (active.cancelled) await this.client.interruptTurn({ threadId, turnId: response.turn.id });
      for await (const event of active.queue) yield event;
    } catch (error) {
      if (!active.turnId) throw error;
      if (!active.cancelled) {
        yield {
          kind: "final",
          text: `Codex execution failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } finally {
      for (const controller of active.interactionControllers) controller.abort();
      removeRequestHandler();
      removeNotificationListener();
      active.queue.close();
      if (this.activeTurn === active) this.activeTurn = null;
    }
  }

  private async buildTurnInput(input: ConnectRuntimePrompt): Promise<CodexUserInput[]> {
    const turnInput: CodexUserInput[] = [{ type: "text", text: input.prompt, text_elements: [] }];
    for (const media of input.media ?? []) {
      const path = input.trustedMediaOrigins
        ? await this.cacheMedia(media, this.context.stateDbPath, input.trustedMediaOrigins)
        : await this.cacheMedia(media, this.context.stateDbPath);
      if (media.kind === "image") {
        turnInput.push({ type: "localImage", path });
        continue;
      }
      if (media.kind === "audio") {
        turnInput.push({ type: "localAudio", path });
        continue;
      }
      turnInput.push({ type: "mention", name: media.name || media.kind, path });
    }
    return turnInput;
  }

  async cancel(): Promise<boolean> {
    const active = this.activeTurn;
    if (!active) return false;
    if (active.cancelled) return true;
    active.cancelled = true;
    if (active.turnId) await this.client.interruptTurn({ threadId: active.threadId, turnId: active.turnId });
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cancel().catch(() => undefined);
  }

  private async ensureThread(
    workspace: RuntimeWorkspace,
    sandboxMode: CodexSandboxMode,
    model?: string,
    reasoningEffort?: string,
  ): Promise<string> {
    const additionalDirectories = [
      ...new Set([...(this.binding.additionalDirectories ?? []), ...workspace.additionalDirectories]),
    ];
    const workspaceKey = JSON.stringify({
      workingDirectory: workspace.workingDirectory,
      additionalDirectories,
      sandboxMode,
    });
    if (this.threadWorkspaceKey && this.threadWorkspaceKey !== workspaceKey) {
      throw new Error("Codex thread options changed; invalidate the current runtime session before continuing");
    }
    if (this.threadWorkspaceKey && this.runtimeSessionId) return this.runtimeSessionId;
    const config = threadConfig(this.binding, additionalDirectories, reasoningEffort);
    const common = {
      ...(model ? { model } : {}),
      cwd: workspace.workingDirectory,
      approvalPolicy: resolveApprovalPolicy(this.binding.approvalPolicy),
      sandbox: sandboxMode,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
    const response = this.runtimeSessionId
      ? await this.client.resumeThread({ threadId: this.runtimeSessionId, ...common })
      : await this.client.startThread(common);
    this.threadWorkspaceKey = workspaceKey;
    await this.recordRuntimeSessionId(response.thread.id);
    return response.thread.id;
  }

  private handleNotification(active: ActiveTurn, notification: CodexAppServerNotification): void {
    if (notification.method === "$transport/exited") {
      active.queue.push({
        kind: "final",
        text: stringField(notification.params.message) || "Codex app-server exited unexpectedly.",
      });
      active.queue.close();
      return;
    }
    const turnId = notificationTurnId(notification);
    if (turnId && turnId !== active.turnId) return;
    if (notification.method === "serverRequest/resolved") {
      const requestId = requestIdKey(notification.params.requestId);
      const controller = requestId ? active.interactionControllersByRequestId.get(requestId) : null;
      controller?.abort();
      return;
    }
    if (notification.method === "turn/started") {
      active.queue.push({
        kind: "progress",
        text: "Codex turn started.",
        itemId: active.turnId ? `turn:${active.turnId}` : undefined,
        state: "streaming",
        data: { itemType: "turn" },
      });
      return;
    }
    if (notification.method === "item/started") {
      const item = threadItem(notification.params.item);
      const event = item ? formatStartedItem(item) : null;
      if (event) active.queue.push(event);
      return;
    }
    if (notification.method === "item/completed") {
      const item = threadItem(notification.params.item);
      if (!item) return;
      if (item.type === "agentMessage") {
        const text = stringField(item.text);
        if (!text) return;
        if (active.pendingAgentMessage !== null) {
          active.queue.push({
            kind: "assistant",
            text: active.pendingAgentMessage.text,
            itemId: active.pendingAgentMessage.itemId,
            state: "complete",
            data: { itemType: "agentMessage" },
          });
        }
        active.pendingAgentMessage = { itemId: item.id, text };
        return;
      }
      const event = formatCompletedItem(item);
      if (event) active.queue.push(event);
      return;
    }
    if (notification.method === "error") {
      const error = recordField(notification.params.error);
      const message = stringField(error?.message);
      if (message && !active.seenErrors.has(message)) {
        active.seenErrors.add(message);
        active.queue.push({ kind: "final", text: `Codex stream error: ${message}` });
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = recordField(notification.params.turn) as unknown as CodexAppServerTurn | null;
      this.completeTurn(active, turn);
    }
  }

  private completeTurn(active: ActiveTurn, turn: CodexAppServerTurn | null): void {
    if (active.pendingAgentMessage !== null) {
      active.queue.push({
        kind: turn?.status === "completed" ? "final" : "assistant",
        text: active.pendingAgentMessage.text,
        itemId: active.pendingAgentMessage.itemId,
        state: turn?.status === "completed" ? "complete" : turn?.status === "interrupted" ? "cancelled" : "error",
        data: { itemType: "agentMessage" },
      });
      active.pendingAgentMessage = null;
    }
    if (active.turnId) {
      active.queue.push({
        kind: "progress",
        text: turn?.status === "interrupted" ? "Codex turn interrupted." : "Codex turn completed.",
        itemId: `turn:${active.turnId}`,
        state: turn?.status === "interrupted" ? "cancelled" : turn?.status === "failed" ? "error" : "complete",
        data: { itemType: "turn" },
      });
    }
    const errorMessage = stringField(turn?.error?.message);
    if (turn?.status === "failed" && errorMessage && !active.seenErrors.has(errorMessage)) {
      active.seenErrors.add(errorMessage);
      active.queue.push({ kind: "final", text: `Codex turn failed: ${errorMessage}` });
    }
    active.queue.close();
  }

  private async handleServerRequest(active: ActiveTurn, request: CodexAppServerRequest) {
    if (stringField(request.params.threadId) !== active.threadId) return { handled: false } as const;
    const turnId = stringField(request.params.turnId);
    if (active.turnId && turnId && turnId !== active.turnId) return { handled: false } as const;
    if (request.method === "item/commandExecution/requestApproval") {
      const command = stringField(request.params.command) || "a command";
      if (!active.interactionPort || !active.sessionRef) {
        active.queue.push({
          kind: "control",
          text: `Codex requested approval for ${command}; interactive responses are unavailable, so the request was cancelled.`,
          requiredControl: true,
        });
        return { handled: true, result: { decision: "cancel" } } as const;
      }
      const response = await this.requestInteraction(active, request.id, {
        kind: "approval",
        action: "command",
        title: "允许 Codex 运行命令？",
        description: stringField(request.params.reason) || "Codex 请求运行以下命令。",
        command,
        cwd: stringField(request.params.cwd) || undefined,
        options: approvalOptions(),
      });
      return {
        handled: true,
        result: { decision: approvalDecision(response.kind === "approval" ? response.optionId : "cancel") },
      } as const;
    }
    if (request.method === "item/fileChange/requestApproval") {
      if (!active.interactionPort || !active.sessionRef) {
        active.queue.push({
          kind: "control",
          text: "Codex requested approval for file changes; interactive responses are unavailable, so the request was cancelled.",
          requiredControl: true,
        });
        return { handled: true, result: { decision: "cancel" } } as const;
      }
      const grantRoot = stringField(request.params.grantRoot);
      const response = await this.requestInteraction(active, request.id, {
        kind: "approval",
        action: "file-change",
        title: "允许 Codex 修改文件？",
        description: stringField(request.params.reason) || "Codex 请求修改工作区文件。",
        files: grantRoot ? [{ path: grantRoot }] : [],
        options: approvalOptions(),
      });
      return {
        handled: true,
        result: { decision: approvalDecision(response.kind === "approval" ? response.optionId : "cancel") },
      } as const;
    }
    if (request.method === "item/tool/requestUserInput") {
      if (!active.interactionPort || !active.sessionRef) {
        active.queue.push({
          kind: "control",
          text: "Codex requested user input; interactive responses are unavailable, so no answers were returned.",
          requiredControl: true,
        });
        return { handled: true, result: { answers: {} } } as const;
      }
      const questions = Array.isArray(request.params.questions) ? request.params.questions : [];
      const response = await this.requestInteraction(active, request.id, {
        kind: "user-input",
        title: "Codex 需要你的回答",
        description:
          questions.length === 1 ? stringField(questions[0]?.question) : `请回答 ${questions.length} 个问题。`,
        questions: questions.map((question, index) => ({
          id: stringField(question.id) || `question-${index + 1}`,
          header: stringField(question.header) || `问题 ${index + 1}`,
          prompt: stringField(question.question) || "请输入回答",
          secret: question.isSecret === true,
          allowOther: question.isOther === true,
          options: Array.isArray(question.options)
            ? question.options.map((option: Record<string, unknown>, optionIndex: number) => ({
                id: stringField(option.label) || `option-${optionIndex + 1}`,
                label: stringField(option.label) || `选项 ${optionIndex + 1}`,
                description: stringField(option.description) || undefined,
              }))
            : null,
        })),
        autoResolutionMs: typeof request.params.autoResolutionMs === "number" ? request.params.autoResolutionMs : null,
      });
      return {
        handled: true,
        result: { answers: response.kind === "user-input" ? mapAnswers(response.answers) : {} },
      } as const;
    }
    return { handled: false } as const;
  }

  private async requestInteraction(
    active: ActiveTurn,
    nativeRequestId: unknown,
    request: import("./types").RuntimeInteractionRequest,
  ): Promise<import("./types").RuntimeInteractionResponse> {
    if (!active.interactionPort) return { kind: "approval", optionId: "cancel" };
    const controller = new AbortController();
    active.interactionControllers.add(controller);
    const requestId = requestIdKey(nativeRequestId);
    if (requestId) active.interactionControllersByRequestId.set(requestId, controller);
    try {
      return await active.interactionPort.request(request, {
        sessionRef: active.sessionRef,
        turnId: active.connectTurnId,
        origin: active.turnOrigin,
        signal: controller.signal,
      });
    } catch {
      return request.kind === "approval"
        ? { kind: "approval", optionId: "cancel" }
        : { kind: "user-input", answers: {} };
    } finally {
      active.interactionControllers.delete(controller);
      if (requestId) active.interactionControllersByRequestId.delete(requestId);
    }
  }

  private async recordRuntimeSessionId(runtimeSessionId: string): Promise<void> {
    const id = runtimeSessionId.trim();
    if (!id || id === this.runtimeSessionId) return;
    this.runtimeSessionId = id;
    await this.context.onRuntimeSessionId(id);
  }
}

class RuntimeEventQueue implements AsyncIterable<RuntimeOutputEvent> {
  private readonly values: RuntimeOutputEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<RuntimeOutputEvent>) => void> = [];
  private closed = false;

  push(value: RuntimeOutputEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeOutputEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<RuntimeOutputEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function resolveSandboxMode(mode: string | undefined, configured: CodexSandboxMode | undefined): CodexSandboxMode {
  if (!mode) return configured ?? "workspace-write";
  if (SANDBOX_MODES.includes(mode as CodexSandboxMode)) return mode as CodexSandboxMode;
  throw new Error(`Codex mode must be one of: ${SANDBOX_MODES.join(", ")}`);
}

function resolveApprovalPolicy(policy: CodexApprovalPolicy | undefined): "never" | "on-request" | "untrusted" {
  return policy ?? DEFAULT_CODEX_APPROVAL_POLICY;
}

function approvalOptions() {
  return [
    { id: "approve-once" as const, label: "仅此次允许" },
    { id: "approve-session" as const, label: "本 Session 允许" },
    { id: "deny" as const, label: "拒绝" },
  ];
}

function approvalDecision(optionId: string): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (optionId === "approve-once") return "accept";
  if (optionId === "approve-session") return "acceptForSession";
  if (optionId === "deny") return "decline";
  return "cancel";
}

function mapAnswers(answers: Record<string, string[]>): Record<string, { answers: string[] }> {
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }]));
}

function requestIdKey(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function threadConfig(
  binding: CodexAgentBindingConfig,
  additionalDirectories: string[],
  reasoningEffort?: string,
): Record<string, unknown> {
  return {
    ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
    ...(binding.webSearchMode ? { web_search: binding.webSearchMode } : {}),
    ...(binding.networkAccessEnabled !== undefined || additionalDirectories.length > 0
      ? {
          sandbox_workspace_write: {
            ...(binding.networkAccessEnabled !== undefined ? { network_access: binding.networkAccessEnabled } : {}),
            ...(additionalDirectories.length > 0 ? { writable_roots: additionalDirectories } : {}),
          },
        }
      : {}),
  };
}

function sandboxPolicy(
  workspace: RuntimeWorkspace,
  mode: CodexSandboxMode,
  networkAccess: boolean,
  bindingDirectories: string[],
): CodexSandboxPolicy {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess };
  return {
    type: "workspaceWrite",
    writableRoots: [
      ...new Set([workspace.workingDirectory, ...bindingDirectories, ...(workspace.additionalDirectories ?? [])]),
    ],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function notificationThreadId(notification: CodexAppServerNotification): string {
  return stringField(notification.params.threadId) || stringField(recordField(notification.params.thread)?.id);
}

function notificationTurnId(notification: CodexAppServerNotification): string {
  return stringField(notification.params.turnId) || stringField(recordField(notification.params.turn)?.id);
}

function threadItem(value: unknown): CodexAppServerThreadItem | null {
  const item = recordField(value);
  if (!item || !stringField(item.type) || !stringField(item.id)) return null;
  return item as CodexAppServerThreadItem;
}

function formatStartedItem(item: CodexAppServerThreadItem): RuntimeOutputEvent | null {
  if (item.type === "commandExecution") {
    return {
      kind: "progress",
      text: `Codex running command: ${stringField(item.command)}`,
      itemId: item.id,
      state: "streaming",
      data: { itemType: item.type, command: stringField(item.command), status: "running" },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      kind: "progress",
      text: `Codex calling MCP tool: ${stringField(item.server)}/${stringField(item.tool)}`,
      itemId: item.id,
      state: "streaming",
      data: { itemType: item.type, server: stringField(item.server), tool: stringField(item.tool) },
    };
  }
  if (item.type === "webSearch")
    return {
      kind: "progress",
      text: `Codex searching the web: ${stringField(item.query)}`,
      itemId: item.id,
      state: "streaming",
      data: { itemType: item.type, query: stringField(item.query) },
    };
  if (item.type === "fileChange")
    return {
      kind: "progress",
      text: "Codex preparing file changes.",
      itemId: item.id,
      state: "streaming",
      data: { itemType: item.type, status: "running" },
    };
  return null;
}

function formatCompletedItem(item: CodexAppServerThreadItem): RuntimeOutputEvent | null {
  if (item.type === "reasoning") {
    const summary = stringArray(item.summary);
    const content = stringArray(item.content);
    const text = [...summary, ...content].join("\n").trim();
    return text ? { kind: "reasoning", text, itemId: item.id, state: "complete", data: { itemType: item.type } } : null;
  }
  if (item.type === "commandExecution") {
    const output = stringField(item.aggregatedOutput);
    return {
      kind: "tool",
      text: [
        `Codex command (${stringField(item.status) || "unknown"}, exit ${numberField(item.exitCode) ?? "unknown"}):`,
        `\`${stringField(item.command)}\``,
        ...(output ? ["```text", output, "```"] : []),
      ].join("\n"),
      itemId: item.id,
      state: stringField(item.status) === "failed" ? "error" : "complete",
      data: {
        itemType: item.type,
        command: stringField(item.command),
        output,
        status: stringField(item.status),
        exitCode: numberField(item.exitCode),
      },
    };
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes.flatMap((value) => {
          const change = recordField(value);
          return change ? [`- ${stringField(change.kind) || "update"}: ${stringField(change.path)}`] : [];
        })
      : [];
    return {
      kind: "tool",
      text: [`Codex file changes (${stringField(item.status) || "unknown"}):`, ...changes].join("\n"),
      itemId: item.id,
      state: stringField(item.status) === "failed" ? "error" : "complete",
      data: { itemType: item.type, status: stringField(item.status), changes: item.changes },
    };
  }
  if (item.type === "mcpToolCall") {
    const error = recordField(item.error);
    return {
      kind: "tool",
      text: [
        `Codex MCP tool (${stringField(item.status) || "unknown"}): ${stringField(item.server)}/${stringField(item.tool)}`,
        `arguments: ${safeJson(item.arguments)}`,
        error ? `error: ${stringField(error.message)}` : safeJson(item.result),
      ].join("\n"),
      itemId: item.id,
      state: error ? "error" : "complete",
      data: {
        itemType: item.type,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
      },
    };
  }
  if (item.type === "dynamicToolCall") {
    return {
      kind: "tool",
      text: `Codex tool (${stringField(item.status) || "unknown"}): ${stringField(item.namespace)}/${stringField(item.tool)}\n${safeJson(item.contentItems)}`,
      itemId: item.id,
      state: stringField(item.status) === "failed" ? "error" : "complete",
      data: { itemType: item.type, namespace: item.namespace, tool: item.tool, contentItems: item.contentItems },
    };
  }
  if (item.type === "webSearch")
    return {
      kind: "tool",
      text: `Codex web search: ${stringField(item.query)}`,
      itemId: item.id,
      state: "complete",
      data: { itemType: item.type, query: item.query },
    };
  if (item.type === "plan")
    return {
      kind: "progress",
      text: stringField(item.text),
      itemId: item.id,
      state: "complete",
      data: { itemType: item.type },
    };
  return null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringField).filter(Boolean) : [];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}
