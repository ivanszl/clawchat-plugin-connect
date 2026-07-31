import { randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptProjection } from "../client-interface/transcript-projection";
import { defaultConfigPath, getAgentBinding } from "../config";
import { buildReplyTextMessagePayload } from "../message-mapper";
import {
  allowedRuntimeKinds,
  type MaterializedRuntimeReply,
  materializeRuntimeOutput,
  policyForOutputVisibility,
  resolveOutputVisibility,
} from "../output-visibility";
import { synchronizeRuntimeProjects as synchronizeProjects } from "../project-synchronizer";
import { ProjectCatalog } from "../projects";
import { EVENT, type NormalizedInboundMessage } from "../protocol";
import {
  createSessionContinuity,
  type SessionContinuity,
  SessionLifecycleError,
  type TurnTarget,
} from "../session-continuity";
import type { ConnectStateStore } from "../state";
import type {
  AgentBindingConfig,
  ConnectConfig,
  ProjectRecord,
  RuntimeSessionRecord,
  RuntimeWorkspace,
} from "../types";
import { type RuntimeWorkspaceChoice, workspaceView } from "../workspace-catalog";
import type { ConnectWsClient } from "../ws-client";
import { MAX_RUNTIME_MEDIA_BYTES } from "./media-cache";
import { resolveModelSelection } from "./model-selection";
import type { RuntimeAdapterRegistry } from "./registry";
import { type QueueStats, type SessionActivity, SessionQueue } from "./session-queue";
import { SessionTurnExecutor } from "./session-turn-executor";
import { ClawChatTurnSurface, ClientTurnSurface } from "./turn-surface";
import type { ConnectRuntimeMedia, RuntimeInteractionPort, RuntimeModelOption, SelectableRuntimeThread } from "./types";

export interface ConnectRuntimeOptions {
  agentId: string;
  config: ConnectConfig;
  configPath?: string;
  stateStore: ConnectStateStore;
  wsClient: ConnectWsClient;
  projects?: ProjectCatalog;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection?: TranscriptProjection;
  runtimeInteractions?: RuntimeInteractionPort;
  resolveSenderDisplayName?: (senderId: string) => Promise<string | null>;
}

export class ConnectRuntime {
  private readonly runtimeAdapters: RuntimeAdapterRegistry;
  private readonly projects: ProjectCatalog;
  private readonly sessionContinuity: SessionContinuity;
  private readonly executor: SessionTurnExecutor;
  private readonly activeTurnSessionChats = new Map<string, string>();
  private readonly acceptedClientTurnIds = new Map<string, string>();
  private readonly routingTails = new Map<string, Promise<void>>();
  private readonly hydratedSenderIds = new Set<string>();
  private readonly queue: SessionQueue;

  constructor(private readonly options: ConnectRuntimeOptions) {
    getAgentBinding(options.config, options.agentId);
    this.runtimeAdapters = options.runtimeAdapters;
    this.projects = options.projects ?? new ProjectCatalog(options.stateStore);
    this.sessionContinuity = createSessionContinuity({ stateStore: options.stateStore });
    this.executor = new SessionTurnExecutor({
      configPath: options.configPath ?? defaultConfigPath(),
      stateDbPath: options.config.stateDbPath,
      bindingFor: (bindingId) => getAgentBinding(options.config, bindingId),
      start: async (binding, context) => await this.runtimeAdapters.start(binding, context),
      attachRuntimeThread: async (sessionRef, runtimeThreadId) =>
        await this.sessionContinuity.forSession(sessionRef).attachRuntimeThread(runtimeThreadId),
    });
    this.queue = new SessionQueue({
      maxConcurrentTurns: options.config.maxConcurrentTurns,
      maxPendingPerSession: options.config.maxPendingPerSession,
      onStatsChange: async (stats) => await this.recordRuntimeStatus(stats),
    });
  }

  async handleInboundMessage(
    message: NormalizedInboundMessage,
    beforeTurn?: () => Promise<boolean>,
    orderedControl = false,
    onTurnAccepted?: () => Promise<void>,
  ): Promise<void> {
    message = await this.withResolvedSenderDisplayName(message);
    try {
      if (orderedControl) {
        await this.withRoutingGate(message.chatId, async () => {
          const selected = await this.options.stateStore.getCurrentRuntimeSession(message.chatId, this.options.agentId);
          const controlIdentity = selected
            ? sessionKey(selected.chatId, selected.sessionId)
            : pendingIntentKey(message.chatId, this.options.agentId);
          let handled = false;
          await this.queue.enqueue(
            controlIdentity,
            async () => {
              handled = (await beforeTurn?.()) ?? false;
            },
            selected ? `Session ${selected.sessionRef}` : "pending Session Intent",
          );
          if (!handled) {
            const current = await this.materializeCurrentSession(message.chatId);
            await this.projectClawChatMessage(message, current);
            await this.queue.enqueue(
              sessionKey(current.chatId, current.sessionId),
              async () => {
                await this.runTrackedTurn(message, current, onTurnAccepted);
              },
              `Session ${current.sessionRef}`,
            );
          }
        });
        return;
      }

      let completion: Promise<void> | null = null;
      await this.withRoutingGate(message.chatId, async () => {
        const current = await this.materializeCurrentSession(message.chatId);
        await this.projectClawChatMessage(message, current);
        const key = sessionKey(current.chatId, current.sessionId);
        completion = this.queue.enqueue(
          key,
          async () => {
            if (await beforeTurn?.()) return;
            await this.runTrackedTurn(message, current, onTurnAccepted);
          },
          `Session ${current.sessionRef}`,
        );
      });
      if (!completion) throw new Error("failed to enqueue Session turn");
      await completion;
    } catch (error) {
      await this.sendVisibleFailure(
        message,
        `ClawChat runtime turn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async withResolvedSenderDisplayName(message: NormalizedInboundMessage): Promise<NormalizedInboundMessage> {
    const resolveDisplayName = this.options.resolveSenderDisplayName;
    if (!resolveDisplayName || (message.sender.nick_name && message.sender.nick_name !== message.sender.id)) {
      return message;
    }
    let displayName: string | null;
    try {
      displayName = (await resolveDisplayName(message.sender.id))?.trim() || null;
    } catch {
      return message;
    }
    if (!displayName || displayName === message.sender.id) return message;
    if (!this.hydratedSenderIds.has(message.sender.id)) {
      await this.options.stateStore.updateTranscriptSenderDisplayName(message.sender.id, displayName);
      this.hydratedSenderIds.add(message.sender.id);
    }
    return {
      ...message,
      sender: { ...message.sender, nick_name: displayName },
    };
  }

  async uploadClientMedia(file: Blob, filename: string): Promise<ConnectRuntimeMedia> {
    const fragment = await this.options.wsClient.uploadMedia(file, { filename });
    const record = fragment as Record<string, unknown>;
    if (!["image", "file", "audio", "video"].includes(fragment.kind) || typeof record.url !== "string") {
      throw new Error("ClawChat media upload returned an unsupported Fragment");
    }
    return {
      kind: fragment.kind as ConnectRuntimeMedia["kind"],
      url: record.url,
      name: typeof record.name === "string" ? record.name : filename,
      ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
      ...(typeof record.size === "number" ? { size: record.size } : {}),
      ...(typeof record.width === "number" ? { width: record.width } : {}),
      ...(typeof record.height === "number" ? { height: record.height } : {}),
      ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
    };
  }

  async enqueueClientTurn(
    sessionRef: string,
    prompt: string,
    media: ConnectRuntimeMedia[] = [],
    signal?: AbortSignal,
  ): Promise<{ turnId: string; sessionRef: string }> {
    signal?.throwIfAborted();
    const text = prompt.trim();
    if (!text && media.length === 0) throw new Error("prompt or media is required");
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    signal?.throwIfAborted();
    if (!current || current.agentId !== this.options.agentId) throw new Error(`Unknown Session Ref: ${sessionRef}`);
    const target = await this.sessionContinuity.forSession(current.sessionRef).targetForTurn("client");
    signal?.throwIfAborted();
    const turnId = randomUUID();
    const key = sessionKey(current.chatId, current.sessionId);
    try {
      this.queue.assertAccepting(key, `Session ${current.sessionRef}`);
    } catch {
      throw new SessionLifecycleError(
        "session-state-conflict",
        `Session ${current.sessionRef} lifecycle operation is in progress`,
      );
    }
    signal?.throwIfAborted();
    const completion = this.queue.enqueue(
      key,
      async () => {
        this.activeTurnSessionChats.set(key, current.chatId);
        await this.recordRuntimeStatus(this.queue.stats());
        try {
          await this.runClientTurn(target, text, turnId, media);
        } finally {
          this.activeTurnSessionChats.delete(key);
          await this.recordRuntimeStatus(this.queue.stats());
        }
      },
      `Session ${current.sessionRef}`,
    );
    this.acceptedClientTurnIds.set(current.sessionRef, turnId);
    void completion
      .catch(() => undefined)
      .finally(() => {
        if (this.acceptedClientTurnIds.get(current.sessionRef) === turnId) {
          this.acceptedClientTurnIds.delete(current.sessionRef);
        }
      });
    return { turnId, sessionRef: current.sessionRef };
  }

  async cancelClientTurn(sessionRef: string): Promise<boolean> {
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    if (!current || current.agentId !== this.options.agentId) return false;
    return await this.executor.cancel(current.sessionRef);
  }

  async sessionActivity(sessionRef: string): Promise<SessionActivity> {
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    if (!current) {
      const target = await this.options.stateStore.getSessionRefTarget(sessionRef);
      if (!target || target.agentId !== this.options.agentId) return "idle";
      return this.queue.activity(`discovered:${sessionRef.toUpperCase()}`);
    }
    if (current.agentId !== this.options.agentId) return "idle";
    return this.queue.activity(sessionKey(current.chatId, current.sessionId));
  }

  activeClientTurnId(sessionRef: string): string | null {
    return this.acceptedClientTurnIds.get(sessionRef.toUpperCase()) ?? null;
  }

  async claimSessionLifecycle(sessionRef: string): Promise<() => Promise<void>> {
    try {
      const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
      if (!current) {
        const target = await this.options.stateStore.getSessionRefTarget(sessionRef);
        if (!target || target.agentId !== this.options.agentId) throw new Error(`Unknown Session Ref: ${sessionRef}`);
        return await this.queue.acquire(`discovered:${sessionRef.toUpperCase()}`, `Session ${sessionRef}`);
      }
      if (current.agentId !== this.options.agentId) throw new Error(`Unknown Session Ref: ${sessionRef}`);
      const key = sessionKey(current.chatId, current.sessionId);
      return await this.queue.acquire(
        key,
        `Session ${current.sessionRef}`,
        async () => {
          await this.executor.cancel(current.sessionRef);
        },
        async () => {
          await this.executor.release(current.sessionRef);
        },
      );
    } catch (error) {
      if (error instanceof SessionLifecycleError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/^Unknown Session Ref:/u.test(message)) {
        throw new SessionLifecycleError("session-not-found", message);
      }
      if (/lifecycle operation is in progress/iu.test(message)) {
        throw new SessionLifecycleError("session-state-conflict", message);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.executor.close();
  }

  async closeSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, false);
  }

  async invalidateSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, true);
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    const sessionRef = current?.sessionRef;
    return sessionRef ? await this.executor.cancel(sessionRef) : false;
  }

  runtimeModesFor(binding: AgentBindingConfig): readonly string[] {
    return this.runtimeAdapters.modesFor(binding);
  }

  async listRuntimeModels(binding: AgentBindingConfig): Promise<RuntimeModelOption[] | null> {
    return await this.runtimeAdapters.listModels(binding);
  }

  async listRuntimeWorkspaces(): Promise<RuntimeWorkspaceChoice[]> {
    const { projects } = await this.synchronizeRuntimeProjects();
    return projects
      .flatMap((project) => {
        const workspace = workspaceView(project.rootPath);
        return workspace
          ? [
              {
                workspaceId: workspace.id,
                name: workspace.name,
                rootPath: project.rootPath,
                projectId: project.projectId,
                projectName: project.name,
              },
            ]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.rootPath.localeCompare(right.rootPath));
  }

  async synchronizeRuntimeProjects(): Promise<{
    projects: ProjectRecord[];
    failures: string[];
  }> {
    const binding = getAgentBinding(this.options.config, this.options.agentId);
    return await synchronizeProjects({
      bindingId: this.options.agentId,
      runtimeKind: binding.kind,
      threads: await this.runtimeAdapters.discoverAllThreads(binding),
      projects: this.projects,
      stateStore: this.options.stateStore,
    });
  }

  async discoverRuntimeThreads(chatId: string): Promise<SelectableRuntimeThread[]> {
    const intent = await this.options.stateStore.getSessionIntent(chatId, this.options.agentId);
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    if (!intent && !current) return [];
    if (intent && !intent.projectId) return [];
    const binding = getAgentBinding(this.options.config, current?.agentId || intent?.agentId || this.options.agentId);
    const workspace = intent?.projectId
      ? await this.projects.resolveProjectWorkspace(intent.projectId)
      : current
        ? await this.projects.resolveWorkspace(current)
        : null;
    if (!workspace) return [];
    const sessions = await this.options.stateStore.listRuntimeSessions(chatId, this.options.agentId);
    const discovered = await this.runtimeAdapters.discoverThreads(binding, workspace);
    const discoveriesById = new Map(discovered.map((thread) => [thread.runtimeThreadId, thread]));
    await Promise.all(
      sessions.map(async (session) => {
        if (session.name || !session.runtimeSessionId) return;
        const name = discoveriesById.get(session.runtimeSessionId)?.name;
        if (name)
          await this.options.stateStore.setRuntimeSessionName(chatId, this.options.agentId, session.sessionId, name);
      }),
    );
    const managed = new Set(
      sessions.map((session) => session.runtimeSessionId).filter((id): id is string => Boolean(id)),
    );
    return await Promise.all(
      discovered
        .filter((thread) => !managed.has(thread.runtimeThreadId))
        .map(async (thread) => ({
          ...thread,
          sessionRef: await this.options.stateStore.getOrCreateSessionRef({
            chatId,
            agentId: this.options.agentId,
            runtimeSessionId: thread.runtimeThreadId,
          }),
        })),
    );
  }

  private async releaseSession(chatId: string, invalidateRuntimeId: boolean): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    if (!current) return false;
    const released = invalidateRuntimeId
      ? await this.executor.invalidate(current.sessionRef)
      : await this.executor.release(current.sessionRef);
    return released || Boolean(current.runtimeSessionId);
  }

  private async runTurn(
    message: NormalizedInboundMessage,
    current: RuntimeSessionRecord,
    onTurnAccepted?: () => Promise<void>,
  ): Promise<void> {
    const activeAgentId = current.agentId || this.options.agentId;
    const workspace = await this.projects.resolveWorkspace(current);
    const model = await this.modelFor(current, activeAgentId);
    const target = await this.sessionContinuity.forSession(current.sessionRef).targetForTurn("clawchat");
    const mode = await resolveOutputVisibility({
      config: this.options.config,
      store: this.options.stateStore,
      bindingId: activeAgentId,
      chatId: message.chatId,
    });
    const policy = policyForOutputVisibility(mode);
    const surface = new ClawChatTurnSurface({
      project: async (event) => {
        await this.options.transcriptProjection?.upsertRuntimeActivity(current.sessionRef, event);
      },
      materialize: (event) => materializeRuntimeOutput(event, policy),
      deliver: async (reply) => await this.sendReply(message, reply, workspace),
    });
    const runtimeInteractions = this.options.runtimeInteractions;
    for await (const event of this.executor.execute(target, {
      prompt: renderPrompt(message),
      media: runtimeMedia(message),
      trustedMediaOrigins: configuredMediaOrigins(this.options.config),
      workspace,
      mode: current.mode ?? undefined,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      sessionOptions: {
        ...(getAgentBinding(this.options.config, activeAgentId).sessionOptions ?? {}),
        ...(current.sessionOptions ?? {}),
      },
      turnId: message.messageId,
      interactionPort: runtimeInteractions
        ? {
            request: async (request, context) =>
              await runtimeInteractions.request(request, {
                ...context,
                clawchat: {
                  chatId: message.chatId,
                  chatType: message.chatType,
                  sourceMessageId: message.messageId,
                  sourceSender: {
                    id: message.sender.id,
                    displayName: message.sender.nick_name || message.sender.id,
                  },
                  sourceFragments: message.fragments,
                },
              }),
          }
        : undefined,
      onAccepted: onTurnAccepted,
      metadata: {
        sessionRef: current.sessionRef,
        chatId: message.chatId,
        sessionId: current.sessionId,
        agentId: activeAgentId,
        projectId: current.projectId ?? "none",
      },
      outputPolicy: { mode: policy.mode, allowedKinds: allowedRuntimeKinds(policy) },
    })) {
      await surface.accept(event);
    }
    await surface.complete();
  }

  private async runClientTurn(
    target: TurnTarget,
    prompt: string,
    turnId: string,
    media: ConnectRuntimeMedia[],
  ): Promise<void> {
    const current = runtimeSessionFromTurnTarget(target);
    const activeAgentId = target.bindingId || this.options.agentId;
    const workspace = await this.projects.resolveWorkspace(current);
    const model = await this.modelFor(current, activeAgentId);
    await this.options.transcriptProjection?.appendUserMessage({
      sessionRef: current.sessionRef,
      text: prompt,
      origin: "client",
      author: "You",
      id: `turn_${turnId}_user`,
      media: media.map((item) => ({
        kind: item.kind,
        url: item.url,
        name: item.name ?? null,
        mime: item.mime ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
      })),
    });
    const surface = new ClientTurnSurface({
      project: async (event) => {
        await this.options.transcriptProjection?.upsertRuntimeActivity(current.sessionRef, event);
      },
    });
    try {
      for await (const event of this.executor.execute(target, {
        prompt,
        media,
        trustedMediaOrigins: configuredMediaOrigins(this.options.config),
        workspace,
        mode: current.mode ?? undefined,
        model: model.model,
        reasoningEffort: model.reasoningEffort,
        sessionOptions: {
          ...(getAgentBinding(this.options.config, activeAgentId).sessionOptions ?? {}),
          ...(current.sessionOptions ?? {}),
        },
        turnId,
        interactionPort: this.options.runtimeInteractions,
        metadata: {
          sessionRef: current.sessionRef,
          origin: "client",
          turnId,
          chatId: current.chatId,
          sessionId: current.sessionId,
          agentId: activeAgentId,
          projectId: current.projectId ?? "none",
        },
        outputPolicy: {
          mode: "client-full",
          allowedKinds: ["final", "assistant", "tool", "progress", "reasoning", "control"],
        },
      })) {
        await surface.accept(event);
      }
      await surface.complete();
    } catch (error) {
      await surface.fail(error);
    }
  }

  private async recordRuntimeStatus(stats: QueueStats): Promise<void> {
    await this.options.stateStore.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: this.options.agentId,
      activeChats: new Set(this.activeTurnSessionChats.values()).size,
      globalRunning: this.activeTurnSessionChats.size,
      globalQueued: stats.queued,
      recentError: null,
    });
  }

  private async sendVisibleFailure(message: NormalizedInboundMessage, text: string): Promise<void> {
    await this.sendReply(message, { text, requiredControl: false });
  }

  private async sendReply(
    message: NormalizedInboundMessage,
    reply: MaterializedRuntimeReply,
    workspace?: RuntimeWorkspace,
  ): Promise<void> {
    const route = { chatId: message.chatId, chatType: message.chatType };
    const localMedia = workspace
      ? await resolveLocalReplyMedia(reply.text, this.options.config.stateDbPath, workspace)
      : { text: reply.text, files: [] };
    const payload = buildReplyTextMessagePayload(localMedia.text, message);
    for (const file of localMedia.files) {
      payload.message.body.fragments.push(
        await this.options.wsClient.uploadMedia(Bun.file(file.path), { filename: file.filename }),
      );
    }
    if (payload.message.body.fragments.length === 0) return;
    await this.options.wsClient.sendMessageEnvelope(EVENT.MESSAGE_REPLY, route.chatId, payload, {
      toType: route.chatType,
    });
  }

  private async materializeCurrentSession(chatId: string): Promise<RuntimeSessionRecord> {
    const target = await this.sessionContinuity
      .inConversation({ chatId, bindingId: this.options.agentId })
      .targetForOrdinaryTurn("clawchat");
    return runtimeSessionFromTurnTarget(target);
  }

  private async projectClawChatMessage(
    message: NormalizedInboundMessage,
    current: RuntimeSessionRecord,
  ): Promise<void> {
    await this.options.transcriptProjection?.appendUserMessage({
      sessionRef: current.sessionRef,
      text: message.text,
      origin: "clawchat",
      author: message.sender.nick_name || message.sender.id,
      sender: {
        id: message.sender.id,
        displayName: message.sender.nick_name || null,
      },
      conversationType: message.chatType,
      id: message.messageId || undefined,
      media: transcriptMedia(message),
    });
  }

  private async runTrackedTurn(
    message: NormalizedInboundMessage,
    current: RuntimeSessionRecord,
    onTurnAccepted?: () => Promise<void>,
  ): Promise<void> {
    const key = sessionKey(current.chatId, current.sessionId);
    this.activeTurnSessionChats.set(key, current.chatId);
    await this.recordRuntimeStatus(this.queue.stats());
    try {
      await this.runTurn(message, current, onTurnAccepted);
    } finally {
      this.activeTurnSessionChats.delete(key);
      await this.recordRuntimeStatus(this.queue.stats());
    }
  }

  private async withRoutingGate<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.routingTails.get(chatId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(async () => await current);
    this.routingTails.set(chatId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release?.();
      if (this.routingTails.get(chatId) === tail) this.routingTails.delete(chatId);
    }
  }

  private async modelFor(current: RuntimeSessionRecord, agentId: string) {
    const binding = getAgentBinding(this.options.config, agentId);
    if (binding.kind === "opencode") return { model: undefined, reasoningEffort: undefined };
    return resolveModelSelection(binding, current, await this.runtimeAdapters.listModels(binding));
  }
}

function runtimeSessionFromTurnTarget(target: TurnTarget): RuntimeSessionRecord {
  return {
    chatId: target.chatId,
    sessionId: target.sessionId,
    sessionRef: target.sessionRef,
    agentId: target.bindingId,
    runtimeSessionId: target.runtimeThreadId,
    projectId: target.projectId,
    name: target.name,
    mode: target.mode,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
    sessionOptions: target.sessionOptions,
    hasMessages: true,
    isCurrent: true,
    updatedAt: Date.now(),
  };
}

interface LocalReplyMediaFile {
  path: string;
  filename: string;
}

const LOCAL_MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu;

async function resolveLocalReplyMedia(
  text: string,
  stateDbPath: string,
  workspace: RuntimeWorkspace,
): Promise<{ text: string; files: LocalReplyMediaFile[] }> {
  const roots = await Promise.all(
    [join(dirname(stateDbPath), "media-cache"), workspace.workingDirectory, ...workspace.additionalDirectories].map(
      async (root) => await realpath(root).catch(() => null),
    ),
  );
  const files: LocalReplyMediaFile[] = [];
  const seen = new Set<string>();
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(LOCAL_MARKDOWN_IMAGE_PATTERN)) {
    const index = match.index;
    const reference = match[1] ?? match[2] ?? "";
    const path = await resolveSafeLocalMediaPath(reference, workspace.workingDirectory, roots);
    result += text.slice(cursor, index);
    if (!path) {
      result += match[0];
    } else if (!(await isSupportedImageFile(path))) {
      result += match[0];
    } else if (!seen.has(path)) {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size <= 0) throw new Error(`Runtime media file is empty or invalid: ${path}`);
      if (metadata.size > MAX_RUNTIME_MEDIA_BYTES) {
        throw new Error(`Runtime media file exceeds the ${MAX_RUNTIME_MEDIA_BYTES}-byte upload limit: ${path}`);
      }
      seen.add(path);
      files.push({ path, filename: basename(path) });
    }
    cursor = index + match[0].length;
  }
  result += text.slice(cursor);
  return { text: result.trim(), files };
}

async function isSupportedImageFile(path: string): Promise<boolean> {
  const extension = extname(path).toLowerCase();
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (extension === ".png") {
      return (
        bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    }
    if (extension === ".jpg" || extension === ".jpeg") {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (extension === ".gif") {
      const signature = bytes.subarray(0, 6).toString("ascii");
      return signature === "GIF87a" || signature === "GIF89a";
    }
    if (extension === ".webp") {
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    }
    return false;
  } finally {
    await handle.close();
  }
}

function configuredMediaOrigins(config: ConnectConfig): string[] {
  const origins = new Set<string>(["https://media.clawling.chat"]);
  for (const value of [config.baseUrl, config.mediaUploadUrl]) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Endpoint validation reports malformed URLs at their owning transport boundary.
    }
  }
  return [...origins];
}

async function resolveSafeLocalMediaPath(
  reference: string,
  workingDirectory: string,
  roots: Array<string | null>,
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = reference.startsWith("file:") ? fileURLToPath(reference) : decodeURIComponent(reference);
  } catch {
    return null;
  }
  const candidate = await realpath(isAbsolute(decoded) ? decoded : resolve(workingDirectory, decoded)).catch(
    () => null,
  );
  if (!candidate) return null;
  return roots.some((root) => root && pathIsWithin(candidate, root)) ? candidate : null;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const nested = relative(root, candidate);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function sessionKey(chatId: string, sessionId: string): string {
  return `${chatId}:${sessionId}`;
}

function pendingIntentKey(chatId: string, agentId: string): string {
  return `pending:${chatId}:${agentId}`;
}

function renderPrompt(message: NormalizedInboundMessage): string {
  const sender = message.sender.nick_name || message.sender.id;
  const mentionedUsers = message.fragments.flatMap((fragment) =>
    fragment.kind === "mention" && typeof fragment.user_id === "string"
      ? [{ user_id: fragment.user_id, display: typeof fragment.display === "string" ? fragment.display : null }]
      : [],
  );
  return [
    "<clawchat_turn_context>",
    JSON.stringify({
      origin: "clawchat",
      chat_id: message.chatId,
      chat_type: message.chatType,
      message_id: message.messageId,
      sender: { user_id: message.sender.id, display: sender },
      mentioned_users: mentionedUsers,
    }),
    "</clawchat_turn_context>",
    "",
    message.text,
  ].join("\n");
}

function runtimeMedia(message: NormalizedInboundMessage): ConnectRuntimeMedia[] {
  return message.fragments.flatMap((fragment) => {
    if (fragment.kind !== "image" && fragment.kind !== "file" && fragment.kind !== "audio" && fragment.kind !== "video")
      return [];
    const record = fragment as Record<string, unknown>;
    if (typeof record.url !== "string" || !record.url) return [];
    return [
      {
        kind: fragment.kind,
        url: record.url,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
        ...(typeof record.size === "number" ? { size: record.size } : {}),
        ...(typeof record.width === "number" ? { width: record.width } : {}),
        ...(typeof record.height === "number" ? { height: record.height } : {}),
        ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
      },
    ];
  });
}

function transcriptMedia(message: NormalizedInboundMessage): import("../client-contract").MessageBlockContent["media"] {
  return message.fragments.flatMap((fragment) => {
    if (!["image", "file", "audio", "video"].includes(fragment.kind)) return [];
    const record = fragment as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "";
    if (!url) return [];
    return [
      {
        kind: fragment.kind as "image" | "file" | "audio" | "video",
        url,
        name: typeof record.name === "string" ? record.name : null,
        mime: typeof record.mime === "string" ? record.mime : null,
        width: typeof record.width === "number" ? record.width : null,
        height: typeof record.height === "number" ? record.height : null,
      },
    ];
  });
}
