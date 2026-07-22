import { randomUUID } from "node:crypto";
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
import { ProjectCatalog } from "../projects";
import { type ChatType, EVENT, type NormalizedInboundMessage } from "../protocol";
import type { ConnectStateStore } from "../state";
import type { AgentBindingConfig, ConnectConfig, RuntimeSessionRecord } from "../types";
import type { ConnectWsClient } from "../ws-client";
import type { RuntimeAdapterRegistry } from "./registry";
import { type QueueStats, SessionQueue } from "./session-queue";
import type { ConnectRuntimeMedia, ConnectRuntimeSession, SelectableRuntimeThread } from "./types";

export interface ConnectRuntimeOptions {
  agentId: string;
  config: ConnectConfig;
  configPath?: string;
  stateStore: ConnectStateStore;
  wsClient: ConnectWsClient;
  projects?: ProjectCatalog;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection?: TranscriptProjection;
}

export class ConnectRuntime {
  private readonly runtimeAdapters: RuntimeAdapterRegistry;
  private readonly projects: ProjectCatalog;
  private readonly sessions = new Map<string, ConnectRuntimeSession>();
  private readonly activeTurnChats = new Set<string>();
  private readonly queue: SessionQueue;

  constructor(private readonly options: ConnectRuntimeOptions) {
    getAgentBinding(options.config, options.agentId);
    this.runtimeAdapters = options.runtimeAdapters;
    this.projects = options.projects ?? new ProjectCatalog(options.stateStore);
    this.queue = new SessionQueue({
      maxConcurrentTurns: options.config.maxConcurrentTurns,
      maxPendingPerChat: options.config.maxPendingPerChat,
      onStatsChange: async (stats) => await this.recordRuntimeStatus(stats),
    });
  }

  async handleInboundMessage(message: NormalizedInboundMessage, beforeTurn?: () => Promise<boolean>): Promise<void> {
    try {
      const queuedSession = await this.options.stateStore.getCurrentRuntimeSession(
        message.chatId,
        this.options.agentId,
      );
      const queueKey = queuedSession ? sessionKey(queuedSession.chatId, queuedSession.sessionId) : message.chatId;
      await this.queue.enqueue(queueKey, async () => {
        if (await beforeTurn?.()) return;
        this.activeTurnChats.add(queueKey);
        await this.recordRuntimeStatus(this.queue.stats());
        try {
          await this.runTurn(message);
        } finally {
          this.activeTurnChats.delete(queueKey);
          await this.recordRuntimeStatus(this.queue.stats());
        }
      });
    } catch (error) {
      await this.sendVisibleFailure(
        message,
        `ClawChat runtime turn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async enqueueClientTurn(sessionRef: string, prompt: string): Promise<{ turnId: string; sessionRef: string }> {
    const text = prompt.trim();
    if (!text) throw new Error("prompt is required");
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    if (!current || current.agentId !== this.options.agentId) throw new Error(`Unknown Session Ref: ${sessionRef}`);
    const turnId = randomUUID();
    const key = sessionKey(current.chatId, current.sessionId);
    void this.queue
      .enqueue(key, async () => {
        this.activeTurnChats.add(key);
        await this.recordRuntimeStatus(this.queue.stats());
        try {
          await this.runClientTurn(current, text, turnId);
        } finally {
          this.activeTurnChats.delete(key);
          await this.recordRuntimeStatus(this.queue.stats());
        }
      })
      .catch(async (error) => {
        await this.options.transcriptProjection?.appendRuntimeOutput(current.sessionRef, {
          kind: "final",
          text: `Connect Client turn failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return { turnId, sessionRef: current.sessionRef };
  }

  async cancelClientTurn(sessionRef: string): Promise<boolean> {
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    if (!current || current.agentId !== this.options.agentId) return false;
    const session = this.sessions.get(sessionKey(current.chatId, current.sessionId));
    return (await session?.cancel?.()) ?? false;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const results = await Promise.allSettled(sessions.map(async (session) => await session.close()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async closeSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, false);
  }

  async invalidateSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, true);
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    const key = sessionKey(chatId, current?.sessionId ?? "default");
    const session = this.sessions.get(key);
    return (await session?.cancel?.()) ?? false;
  }

  runtimeModesFor(binding: AgentBindingConfig): readonly string[] {
    return this.runtimeAdapters.modesFor(binding);
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
    const key = sessionKey(chatId, current?.sessionId ?? "default");
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (session) await session.close();
    if (invalidateRuntimeId && current) {
      await this.options.stateStore.setRuntimeSessionId(chatId, this.options.agentId, current.sessionId, null);
    }
    return Boolean(session) || Boolean(current?.runtimeSessionId);
  }

  private async runTurn(message: NormalizedInboundMessage): Promise<void> {
    const current = await this.ensureCurrentSession(message.chatId);
    const activeAgentId = current.agentId || this.options.agentId;
    const workspace = await this.projects.resolveWorkspace(current);
    const session = await this.sessionForChat(current, activeAgentId);
    const mode = await resolveOutputVisibility({
      config: this.options.config,
      store: this.options.stateStore,
      chatId: message.chatId,
    });
    const policy = policyForOutputVisibility(mode);
    const buffered: MaterializedRuntimeReply[] = [];
    await this.options.transcriptProjection?.appendUserMessage({
      sessionRef: current.sessionRef,
      text: message.text,
      origin: "clawchat",
      author: message.sender.nick_name || message.sender.id,
      id: message.messageId || undefined,
    });
    for await (const event of session.prompt({
      prompt: renderPrompt(message),
      media: runtimeMedia(message),
      workspace,
      mode: current.mode ?? undefined,
      metadata: {
        chatId: message.chatId,
        sessionId: current.sessionId,
        agentId: activeAgentId,
        projectId: current.projectId ?? "none",
      },
      outputPolicy: { mode: policy.mode, allowedKinds: allowedRuntimeKinds(policy) },
    })) {
      await this.options.transcriptProjection?.appendRuntimeOutput(current.sessionRef, event);
      const reply = materializeRuntimeOutput(event, policy);
      if (!reply) continue;
      if (reply.requiredControl) await this.sendReply(message, reply, activeAgentId);
      else buffered.push(reply);
    }
    for (const reply of buffered) await this.sendReply(message, reply, activeAgentId);
  }

  private async runClientTurn(current: RuntimeSessionRecord, prompt: string, turnId: string): Promise<void> {
    const activeAgentId = current.agentId || this.options.agentId;
    const workspace = await this.projects.resolveWorkspace(current);
    const session = await this.sessionForChat(current, activeAgentId);
    await this.options.transcriptProjection?.appendUserMessage({
      sessionRef: current.sessionRef,
      text: prompt,
      origin: "client",
      author: "You",
      id: `turn_${turnId}_user`,
    });
    for await (const event of session.prompt({
      prompt,
      workspace,
      mode: current.mode ?? undefined,
      metadata: {
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
      await this.options.transcriptProjection?.appendRuntimeOutput(current.sessionRef, event);
    }
  }

  private async recordRuntimeStatus(stats: QueueStats): Promise<void> {
    await this.options.stateStore.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: this.options.agentId,
      activeChats: this.sessions.size,
      globalRunning: this.activeTurnChats.size,
      globalQueued: stats.queued,
      recentError: null,
    });
  }

  private async sendVisibleFailure(message: NormalizedInboundMessage, text: string): Promise<void> {
    await this.sendReply(message, { text, requiredControl: false }, this.options.agentId);
  }

  private async sendReply(
    message: NormalizedInboundMessage,
    reply: MaterializedRuntimeReply,
    agentId: string,
  ): Promise<void> {
    const route = await this.resolveReplyRoute(message, reply, agentId);
    await this.options.wsClient.sendMessageEnvelope(
      EVENT.MESSAGE_REPLY,
      route.chatId,
      buildReplyTextMessagePayload(reply.text, message),
      { toType: route.chatType },
    );
  }

  private async resolveReplyRoute(
    message: NormalizedInboundMessage,
    reply: MaterializedRuntimeReply,
    agentId: string,
  ): Promise<{ chatId: string; chatType: ChatType }> {
    if (!reply.requiredControl || message.chatType !== "group") {
      return { chatId: message.chatId, chatType: message.chatType };
    }
    const activation = await this.options.stateStore.getActivation(agentId).catch(() => null);
    const ownerDirectChatId = activation?.conversationId ?? null;
    if (!ownerDirectChatId) throw new Error("owner direct conversation is unavailable for required control delivery");
    return { chatId: ownerDirectChatId, chatType: "direct" };
  }

  private async ensureCurrentSession(chatId: string): Promise<RuntimeSessionRecord> {
    const intent = await this.options.stateStore.getSessionIntent(chatId, this.options.agentId);
    if (intent) {
      const sessionId = randomUUID();
      await this.options.stateStore.upsertRuntimeSession({
        chatId,
        sessionId,
        agentId: intent.agentId,
        runtimeSessionId: null,
        projectId: intent.projectId,
        name: intent.name,
        mode: intent.mode,
        hasMessages: true,
        isCurrent: true,
      });
      const created = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
      if (!created) throw new Error("failed to materialize Session Intent");
      return created;
    }
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    if (current) return current;
    const sessionId = randomUUID();
    await this.options.stateStore.upsertRuntimeSession({
      chatId,
      sessionId,
      agentId: this.options.agentId,
      runtimeSessionId: null,
      projectId: null,
      hasMessages: true,
      isCurrent: true,
    });
    const created = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    if (!created) throw new Error("failed to create a non-Project session");
    return created;
  }

  private async sessionForChat(current: RuntimeSessionRecord, agentId: string): Promise<ConnectRuntimeSession> {
    const key = sessionKey(current.chatId, current.sessionId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const binding = getAgentBinding(this.options.config, agentId);
    let session: ConnectRuntimeSession | null = null;
    session = await this.runtimeAdapters.start(binding, {
      agentId,
      chatId: current.chatId,
      sessionId: current.sessionId,
      runtimeSessionId: current.runtimeSessionId,
      configPath: this.options.configPath ?? defaultConfigPath(),
      stateDbPath: this.options.config.stateDbPath,
      onRuntimeSessionId: async (runtimeSessionId) => {
        if (!session || this.sessions.get(key) !== session) return;
        await this.options.stateStore.setRuntimeSessionId(
          current.chatId,
          current.agentId,
          current.sessionId,
          runtimeSessionId,
        );
      },
    });
    this.sessions.set(key, session);
    return session;
  }
}

function sessionKey(chatId: string, sessionId: string): string {
  return `${chatId}:${sessionId}`;
}

function renderPrompt(message: NormalizedInboundMessage): string {
  const sender = message.sender.nick_name || message.sender.id;
  return [`ClawChat ${message.chatType} message from ${sender}:`, message.text].join("\n");
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
