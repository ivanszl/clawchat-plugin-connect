import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { replaceLeadingSkill } from "../agent/skill-invocation";
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
  RuntimeActivity,
  RuntimeInputIdentity,
  RuntimeInteractionPort,
  RuntimeModelOption,
  RuntimeSkillSummary,
  RuntimeThreadSummary,
  RuntimeTranscriptEntry,
} from "./types";
import { runtimeInputIdentity, runtimeInputIdentityContains } from "./types";

interface CodexOutputEvent {
  kind: "final" | "assistant" | "tool" | "progress" | "reasoning" | "control" | "turn";
  text: string;
  requiredControl?: boolean;
  itemId?: string;
  position?: string;
  state?: "pending" | "streaming" | "complete" | "error" | "cancelled";
  data?: Record<string, unknown>;
}

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
  let client: Promise<CodexAppServerClient> | null = null;
  const nativeSkills = new Map<string, Map<string, { name: string; path: string }>>();
  const skillChangeListeners = new Set<() => void>();
  let removeSkillNotification: (() => void) | null = null;
  const invalidateSkillWorkspace = (workspace: RuntimeWorkspace) => {
    if (!nativeSkills.delete(resolve(workspace.workingDirectory))) return;
    for (const listener of skillChangeListeners) listener();
  };

  const clientFor = async (binding: CodexAgentBindingConfig): Promise<CodexAppServerClient> => {
    if (client) return await client;
    const created = createAppServer(binding)
      .then((appServer) => {
        removeSkillNotification = appServer.onNotification((notification) => {
          if (notification.method !== "skills/changed") return;
          nativeSkills.clear();
          for (const listener of skillChangeListeners) listener();
        });
        return appServer;
      })
      .catch((error) => {
        if (client === created) client = null;
        throw error;
      });
    client = created;
    return await created;
  };

  return {
    kind: "codex",
    modes: SANDBOX_MODES,
    lifecycleCapabilities: { archive: true, restore: true, delete: true },
    async prepare(binding) {
      await clientFor(requireCodexBinding(binding));
    },
    async listModels(binding) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexModels(await clientFor(codexBinding));
    },
    async listSkills(binding, workspace, listOptions) {
      const codexBinding = requireCodexBinding(binding);
      const response = await (await clientFor(codexBinding)).listSkills({
        cwds: [workspace.workingDirectory],
        forceReload: listOptions?.forceRefresh === true,
      });
      const entry = response.data.find((candidate) => resolve(candidate.cwd) === resolve(workspace.workingDirectory));
      const workspaceSkills = new Map<string, { name: string; path: string }>();
      const summaries: RuntimeSkillSummary[] = [];
      for (const skill of entry?.skills ?? []) {
        if (!skill.enabled) continue;
        const id = `codex:${createHash("sha256").update(skill.path).digest("base64url").slice(0, 22)}`;
        workspaceSkills.set(id, { name: skill.name, path: skill.path });
        summaries.push({ id, name: skill.name, ...(skill.description ? { description: skill.description } : {}) });
      }
      nativeSkills.set(resolve(workspace.workingDirectory), workspaceSkills);
      return summaries;
    },
    onSkillsChanged(listener) {
      skillChangeListeners.add(listener);
      return () => skillChangeListeners.delete(listener);
    },
    async discoverThreads(binding, workspace) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexThreads(await clientFor(codexBinding), workspace.workingDirectory);
    },
    async discoverAllThreads(binding) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexThreads(await clientFor(codexBinding));
    },
    async discoverArchivedThreads(binding) {
      const codexBinding = requireCodexBinding(binding);
      return await discoverCodexThreads(await clientFor(codexBinding), undefined, true);
    },
    async readActivity(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      const appServerEntries = await readCodexTranscript(await clientFor(codexBinding), runtimeThreadId);
      const snapshot = await backfillCodexRolloutTranscript({
        codexHome: codexHome(codexBinding),
        runtimeThreadId,
        appServerEntries,
      });
      return {
        activities: snapshot.entries.map((entry, index) => codexActivity(entry, entry.position ?? `${index}`)),
        completeness: snapshot.completeness,
        limitations: snapshot.completeness === "complete" ? [] : ["correlation", "ordering"],
      };
    },
    async reconcileInput(binding, runtimeThreadId, candidate) {
      try {
        const codexBinding = requireCodexBinding(binding);
        const snapshot = await readCodexInputIdentities(await clientFor(codexBinding), runtimeThreadId);
        const identity = snapshot.identities.find((value) => runtimeInputIdentityContains(value, candidate));
        return identity
          ? { outcome: "accepted", identity, receipts: snapshot }
          : { outcome: snapshot.complete ? "absent" : "unknown", receipts: snapshot };
      } catch {
        return { outcome: "unknown" };
      }
    },
    async archiveThread(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      await (await clientFor(codexBinding)).archiveThread({ threadId: runtimeThreadId });
    },
    async unarchiveThread(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      await (await clientFor(codexBinding)).unarchiveThread({ threadId: runtimeThreadId });
    },
    async deleteThread(binding, runtimeThreadId) {
      const codexBinding = requireCodexBinding(binding);
      await (await clientFor(codexBinding)).deleteThread({ threadId: runtimeThreadId });
    },
    async start(binding, context) {
      const codexBinding = requireCodexBinding(binding);
      return new CodexRuntimeSession(
        await clientFor(codexBinding),
        codexBinding,
        context,
        cacheMedia,
        nativeSkills,
        invalidateSkillWorkspace,
      );
    },
    async close() {
      const active = client;
      client = null;
      removeSkillNotification?.();
      removeSkillNotification = null;
      skillChangeListeners.clear();
      nativeSkills.clear();
      if (active) await (await active).close();
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

async function readCodexInputIdentities(
  client: CodexAppServerClient,
  runtimeThreadId: string,
): Promise<{ identities: RuntimeInputIdentity[]; complete: boolean }> {
  const response = await client.readThread({ threadId: runtimeThreadId, includeTurns: true });
  const identities: RuntimeInputIdentity[] = [];
  let complete = Array.isArray(response.thread.turns);
  for (const turn of response.thread.turns ?? []) {
    for (const item of turn.items) {
      if (item.type !== "userMessage") continue;
      if (!Array.isArray(item.content)) {
        complete = false;
        continue;
      }
      const text = item.content
        .flatMap((value) => {
          const part = recordField(value);
          return part?.type === "text" ? [stringField(part.text)] : [];
        })
        .join("\n");
      const identity = runtimeInputIdentity(text);
      if (identity) identities.push(identity);
      else if (looksLikeClawChatTurnContext(text)) complete = false;
    }
  }
  return { identities, complete };
}

function looksLikeClawChatTurnContext(text: string): boolean {
  return text.trimStart().startsWith("<clawchat_turn_context>");
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
  for (const [turnIndex, turn] of (response.thread.turns ?? []).entries()) {
    const lifecycle = historicalTurnLifecycle(turn, turnIndex);
    if (lifecycle) entries.push(lifecycle);
    for (const [itemIndex, item] of turn.items.entries()) {
      const position = `${turnIndex}.${itemIndex + 1}`;
      if (item.type === "subAgentActivity") {
        const childThreadId = stringField(item.agentThreadId);
        if (!childThreadId || lineage.has(childThreadId) || seenChildThreads.has(childThreadId)) continue;
        seenChildThreads.add(childThreadId);
        entries.push({
          ...(await subagentTranscriptEntry(client, item, childThreadId, lineage, reads)),
          position,
        });
        continue;
      }
      const entry = transcriptEntry(item, turn.status);
      if (entry) entries.push({ ...entry, position });
    }
  }
  return { thread: response.thread, entries };
}

function historicalTurnLifecycle(
  turn: NonNullable<CodexAppServerThread["turns"]>[number],
  turnIndex: number,
): RuntimeTranscriptEntry | null {
  if (turn.status !== "interrupted" && turn.status !== "failed") return null;
  return {
    id: `turn:${turn.id}`,
    position: `${turnIndex}.0`,
    kind: "turn",
    text: turn.status === "interrupted" ? "Codex turn interrupted." : "Codex turn failed.",
    state: turn.status === "interrupted" ? "cancelled" : "error",
    source: "history",
  };
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
    const text = content.join("\n");
    const context = clawChatTurnContext(text);
    return {
      id: item.id,
      kind: "user",
      text,
      state,
      source: "history",
      ...(context?.messageId ? { data: { clawchatMessageId: context.messageId } } : {}),
    };
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

function clawChatTurnContext(text: string): { messageId: string } | null {
  const match = /^<clawchat_turn_context>\n([^\n]+)\n<\/clawchat_turn_context>/u.exec(text);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    return value.origin === "clawchat" && typeof value.message_id === "string" && value.message_id
      ? { messageId: value.message_id }
      : null;
  } catch {
    return null;
  }
}

function codexActivity(
  entry: RuntimeTranscriptEntry,
  position: string,
  parentId: string | null = null,
): RuntimeActivity {
  const inputIdentity = entry.kind === "user" ? runtimeInputIdentity(entry.text) : null;
  return {
    ...entry,
    position: entry.position ?? position,
    parentId,
    ...(inputIdentity ? { inputIdentity } : {}),
    children: entry.children?.map((child, index) =>
      codexActivity(child, child.position ?? `${entry.position ?? position}.${index}`, entry.id),
    ),
  };
}

function requireCodexBinding(binding: { kind: string }): CodexAgentBindingConfig {
  if (binding.kind !== "codex") throw new Error("Codex Runtime Adapter requires a Codex Agent Binding");
  return binding as CodexAgentBindingConfig;
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
        .map((thread) => {
          const workspaceKind = isTransientWorkspace(thread) ? ("transient" as const) : ("persistent" as const);
          return {
            workspaceIdentity: {
              key: resolve(thread.cwd),
              kind: workspaceKind,
              localRoot: thread.cwd || null,
            },
            runtimeThreadId: thread.id,
            ...(archived ? { isArchived: true } : {}),
            name: normalizeThreadName(thread.name || thread.preview),
            updatedAt: thread.updatedAt * 1_000,
            workingDirectory: thread.cwd,
            ...(workspaceKind === "transient" ? { workspaceKind } : {}),
          };
        }),
    );
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("Codex app-server returned a repeated thread/list cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
}

function isTransientWorkspace(thread: CodexAppServerThread): boolean {
  return isCodexAppScratchWorkspace(thread) || isConnectManagedScratchWorkspace(thread.cwd);
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

function isConnectManagedScratchWorkspace(workingDirectory: string): boolean {
  const parts = resolve(workingDirectory).split(/[\\/]/u);
  if (parts.length < 5 || parts.at(-4) !== "workspaces") return false;
  const owner = parts.at(-5) ?? "";
  if (owner !== ".clawchat-connect" && !owner.startsWith("clawchat-connect-live.")) return false;
  return parts.slice(-3).every((part) => /^[a-f0-9]{24}$/iu.test(part));
}

function normalizeThreadName(value: string): string | null {
  const normalized = value
    .replace(/^<clawchat_turn_context>\n[\s\S]*?\n<\/clawchat_turn_context>\n*/u, "")
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
  streamingAgentMessages: Map<string, string>;
  seenErrors: Set<string>;
  interactionPort: RuntimeInteractionPort | null;
  connectTurnId: string;
  turnOrigin: "client" | "clawchat";
  sessionRef: string;
  interactionControllers: Set<AbortController>;
  interactionControllersByRequestId: Map<string, AbortController>;
  activityPositions: Map<string, string>;
  turnPositionPrefix: string;
  nextActivityPosition: number;
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
    private readonly nativeSkills: ReadonlyMap<string, ReadonlyMap<string, { name: string; path: string }>>,
    private readonly invalidateSkillWorkspace: (workspace: RuntimeWorkspace) => void,
  ) {
    this.runtimeSessionId = context.runtimeSessionId;
  }

  async *prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeActivity> {
    if (this.closed) throw new Error("Codex runtime session is closed");
    if (this.activeTurn) throw new Error("Codex already has an active turn for this session");
    const sandboxMode = resolveSandboxMode(input.mode, this.binding.sandboxMode);
    const resumesMaterializedThread = Boolean(this.runtimeSessionId);
    const threadId = await this.ensureThread(input.workspace, sandboxMode, input.model, input.reasoningEffort);
    const turnPositionPrefix = resumesMaterializedThread
      ? `${(await this.client.readThread({ threadId, includeTurns: true })).thread.turns?.length ?? 0}`
      : "0";
    const active: ActiveTurn = {
      threadId,
      turnId: null,
      cancelled: false,
      bufferedNotifications: [],
      queue: new RuntimeEventQueue(),
      pendingAgentMessage: null,
      streamingAgentMessages: new Map(),
      seenErrors: new Set(),
      interactionPort: input.interactionPort ?? null,
      connectTurnId: input.turnId ?? `turn-${Date.now()}`,
      turnOrigin: input.turnOrigin ?? "client",
      sessionRef: input.metadata?.sessionRef ?? "",
      interactionControllers: new Set(),
      interactionControllersByRequestId: new Map(),
      activityPositions: new Map(),
      turnPositionPrefix,
      nextActivityPosition: 2,
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
      for await (const event of active.queue) yield codexLiveActivity(active, event);
    } catch (error) {
      if (input.skill) this.invalidateSkillWorkspace(input.workspace);
      if (!active.turnId) throw error;
      if (!active.cancelled) {
        yield codexLiveActivity(active, {
          kind: "final",
          text: `Codex execution failed: ${error instanceof Error ? error.message : String(error)}`,
        });
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
    if (input.command) throw new Error(`Codex Runtime Commands are not supported: ${input.command.name}`);
    let prompt = input.prompt;
    const selectedSkill = input.skill ? this.resolveSkill(input.skill, input.workspace) : null;
    if (selectedSkill) prompt = replaceLeadingSkill(prompt, selectedSkill.name, "$");
    const turnInput: CodexUserInput[] = prompt ? [{ type: "text", text: prompt, text_elements: [] }] : [];
    if (selectedSkill) turnInput.push({ type: "skill", name: selectedSkill.name, path: selectedSkill.path });
    for (const media of input.media ?? []) {
      let path: string;
      if (this.context.cacheMedia) {
        path = await this.context.cacheMedia(media, input.trustedMediaOrigins);
      } else {
        if (!this.context.stateDbPath) throw new Error("Codex Runtime media caching is unavailable");
        path = input.trustedMediaOrigins
          ? await this.cacheMedia(media, this.context.stateDbPath, input.trustedMediaOrigins)
          : await this.cacheMedia(media, this.context.stateDbPath);
      }
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

  private resolveSkill(skill: RuntimeSkillSummary, workspace: RuntimeWorkspace): { name: string; path: string } {
    const selected = this.nativeSkills.get(resolve(workspace.workingDirectory))?.get(skill.id);
    if (!selected || selected.name !== skill.name) throw new Error(`Codex Skill is no longer available: ${skill.name}`);
    return selected;
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
    const additionalDirectories = [...new Set(this.binding.additionalDirectories ?? [])];
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
        position: `${active.turnPositionPrefix}.0`,
        state: "streaming",
      });
      return;
    }
    if (notification.method === "item/started") {
      const item = threadItem(notification.params.item);
      const event = item ? formatStartedItem(item) : null;
      if (item) reserveActivityPosition(active, item.id);
      if (item && event) active.queue.push({ ...event, position: reserveActivityPosition(active, item.id) });
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const itemId = stringField(notification.params.itemId);
      const delta = typeof notification.params.delta === "string" ? notification.params.delta : "";
      if (!itemId || !delta) return;
      const text = `${active.streamingAgentMessages.get(itemId) ?? ""}${delta}`;
      active.streamingAgentMessages.set(itemId, text);
      active.queue.push({
        kind: "assistant",
        text,
        itemId,
        position: reserveActivityPosition(active, itemId),
        state: "streaming",
        data: { itemType: "agentMessage" },
      });
      return;
    }
    if (notification.method === "item/completed") {
      const item = threadItem(notification.params.item);
      if (!item) return;
      const position = reserveActivityPosition(active, item.id);
      if (item.type === "agentMessage") {
        const text = stringField(item.text);
        if (!text) return;
        active.streamingAgentMessages.delete(item.id);
        if (active.pendingAgentMessage !== null) {
          active.queue.push({
            kind: "assistant",
            text: active.pendingAgentMessage.text,
            itemId: active.pendingAgentMessage.itemId,
            position: reserveActivityPosition(active, active.pendingAgentMessage.itemId),
            state: "complete",
            data: { itemType: "agentMessage" },
          });
        }
        active.pendingAgentMessage = { itemId: item.id, text };
        return;
      }
      const event = formatCompletedItem(item);
      if (event) active.queue.push({ ...event, position });
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
        position: reserveActivityPosition(active, active.pendingAgentMessage.itemId),
        state: turn?.status === "completed" ? "complete" : turn?.status === "interrupted" ? "cancelled" : "error",
        data: { itemType: "agentMessage" },
      });
      active.pendingAgentMessage = null;
    }
    if (active.turnId) {
      active.queue.push({
        kind: "turn",
        text: turn?.status === "interrupted" ? "Codex turn interrupted." : "Codex turn completed.",
        itemId: `turn:${active.turnId}`,
        position: `${active.turnPositionPrefix}.0`,
        state: turn?.status === "interrupted" ? "cancelled" : turn?.status === "failed" ? "error" : "complete",
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
      const delivery = await this.requestInteraction(active, request.id, {
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
        result: {
          decision: approvalDecision(delivery.response.kind === "approval" ? delivery.response.optionId : "cancel"),
        },
        onDelivered: delivery.confirm,
        onDeliveryFailed: delivery.fail,
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
      const delivery = await this.requestInteraction(active, request.id, {
        kind: "approval",
        action: "file-change",
        title: "允许 Codex 修改文件？",
        description: stringField(request.params.reason) || "Codex 请求修改工作区文件。",
        files: grantRoot ? [{ path: grantRoot }] : [],
        options: approvalOptions(),
      });
      return {
        handled: true,
        result: {
          decision: approvalDecision(delivery.response.kind === "approval" ? delivery.response.optionId : "cancel"),
        },
        onDelivered: delivery.confirm,
        onDeliveryFailed: delivery.fail,
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
      const delivery = await this.requestInteraction(active, request.id, {
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
        result: {
          answers: delivery.response.kind === "user-input" ? mapAnswers(delivery.response.answers) : {},
        },
        onDelivered: delivery.confirm,
        onDeliveryFailed: delivery.fail,
      } as const;
    }
    return { handled: false } as const;
  }

  private async requestInteraction(
    active: ActiveTurn,
    nativeRequestId: unknown,
    request: import("./types").RuntimeInteractionRequest,
  ): Promise<{
    response: import("./types").RuntimeInteractionResponse;
    confirm(): void;
    fail(error: Error): void;
  }> {
    const interactionPort = active.interactionPort;
    if (!interactionPort) throw new Error("Runtime Interaction port is unavailable");
    const controller = new AbortController();
    let confirm: () => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const deliveryConfirmation = new Promise<void>((resolve, reject) => {
      confirm = resolve;
      fail = reject;
    });
    void deliveryConfirmation.catch(() => undefined);
    active.interactionControllers.add(controller);
    const requestId = requestIdKey(nativeRequestId);
    if (requestId) active.interactionControllersByRequestId.set(requestId, controller);
    try {
      return {
        response: await interactionPort.request(request, {
          sessionRef: active.sessionRef,
          turnId: active.connectTurnId,
          origin: active.turnOrigin,
          signal: controller.signal,
          deliveryConfirmation,
        }),
        confirm,
        fail,
      };
    } catch {
      return {
        response:
          request.kind === "approval" ? { kind: "approval", optionId: "cancel" } : { kind: "user-input", answers: {} },
        confirm,
        fail,
      };
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

function codexLiveActivity(active: ActiveTurn, event: CodexOutputEvent): RuntimeActivity {
  const text = event.text.trim();
  const state =
    event.state ??
    (event.kind === "final" && /(?:failed|error|exited)/iu.test(text) ? ("error" as const) : ("complete" as const));
  const itemType = stringField(event.data?.itemType);
  const kind: RuntimeActivity["kind"] =
    itemType === "commandExecution"
      ? "command"
      : itemType === "fileChange"
        ? "file-change"
        : itemType === "plan"
          ? "plan"
          : event.kind === "turn"
            ? "turn"
            : isCodexToolItemType(itemType) || event.kind === "tool"
              ? "tool"
              : event.kind === "assistant" || (event.kind === "final" && state !== "error")
                ? "assistant"
                : event.kind === "reasoning"
                  ? "reasoning"
                  : event.kind === "control" || state === "error"
                    ? "error"
                    : "progress";
  const nextPosition = event.position ?? `${active.turnPositionPrefix}.${active.nextActivityPosition}`;
  const id = event.itemId ?? `turn:${active.connectTurnId}:activity:${nextPosition}`;
  let position = active.activityPositions.get(id);
  if (!position) {
    position = nextPosition;
    if (!event.position) active.nextActivityPosition += 1;
    active.activityPositions.set(id, position);
  }
  return {
    id,
    position,
    parentId: null,
    kind,
    text,
    state,
    source: "live",
    data: {
      ...event.data,
      outputKind: event.kind,
      ...(event.requiredControl ? { requiredControl: true } : {}),
      ...(kind === "tool" ? { title: codexToolTitle(event, text) } : {}),
      ...(event.kind === "control" ? { code: "runtime-interaction-unavailable" } : {}),
    },
  };
}

function reserveActivityPosition(active: ActiveTurn, id: string): string {
  const existing = active.activityPositions.get(id);
  if (existing) return existing;
  const position = `${active.turnPositionPrefix}.${active.nextActivityPosition}`;
  active.nextActivityPosition += 1;
  active.activityPositions.set(id, position);
  return position;
}

function codexToolTitle(event: CodexOutputEvent, text: string): string {
  const itemType = stringField(event.data?.itemType);
  if (itemType === "mcpToolCall") {
    const target = [stringField(event.data?.server), stringField(event.data?.tool)].filter(Boolean).join("/");
    return target ? `MCP · ${target}` : "MCP tool";
  }
  if (itemType === "webSearch") return `Web search · ${stringField(event.data?.query) || firstLine(text)}`;
  if (itemType === "dynamicToolCall") {
    const target = [stringField(event.data?.namespace), stringField(event.data?.tool)].filter(Boolean).join("/");
    return target || "Tool call";
  }
  return firstLine(text);
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0]?.trim() || "Runtime activity";
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

function isCodexToolItemType(itemType: string): boolean {
  return itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "webSearch";
}

class RuntimeEventQueue implements AsyncIterable<CodexOutputEvent> {
  private readonly values: CodexOutputEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<CodexOutputEvent>) => void> = [];
  private closed = false;

  push(value: CodexOutputEvent): void {
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

  [Symbol.asyncIterator](): AsyncIterator<CodexOutputEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<CodexOutputEvent>>((resolve) => this.waiters.push(resolve));
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
  return policy ?? "on-request";
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
    writableRoots: [...new Set([workspace.workingDirectory, ...bindingDirectories])],
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

function formatStartedItem(item: CodexAppServerThreadItem): CodexOutputEvent | null {
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

function formatCompletedItem(item: CodexAppServerThreadItem): CodexOutputEvent | null {
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
