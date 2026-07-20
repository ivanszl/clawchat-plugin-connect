import { randomUUID } from "node:crypto";
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
import { SessionQueue } from "./session-queue";
import type { ConnectRuntimeSession } from "./types";

export interface ConnectRuntimeOptions {
  agentId: string;
  config: ConnectConfig;
  configPath?: string;
  stateStore: ConnectStateStore;
  wsClient: ConnectWsClient;
  projects?: ProjectCatalog;
  runtimeAdapters: RuntimeAdapterRegistry;
}

export class ConnectRuntime {
  private readonly runtimeAdapters: RuntimeAdapterRegistry;
  private readonly projects: ProjectCatalog;
  private readonly sessions = new Map<string, ConnectRuntimeSession>();
  private readonly queue: SessionQueue;

  constructor(private readonly options: ConnectRuntimeOptions) {
    getAgentBinding(options.config, options.agentId);
    this.runtimeAdapters = options.runtimeAdapters;
    this.projects = options.projects ?? new ProjectCatalog(options.stateStore);
    this.queue = new SessionQueue({
      maxConcurrentTurns: options.config.maxConcurrentTurns,
      maxPendingPerChat: options.config.maxPendingPerChat,
    });
  }

  async handleInboundMessage(message: NormalizedInboundMessage, beforeTurn?: () => Promise<boolean>): Promise<void> {
    try {
      await this.queue.enqueue(message.chatId, async () => {
        if (await beforeTurn?.()) return;
        await this.runTurn(message);
      });
    } catch (error) {
      await this.sendVisibleFailure(
        message,
        `ClawChat runtime turn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) await session.close();
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
    for await (const event of session.prompt({
      prompt: renderPrompt(message),
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
      const reply = materializeRuntimeOutput(event, policy);
      if (!reply) continue;
      if (reply.requiredControl) await this.sendReply(message, reply, activeAgentId);
      else buffered.push(reply);
    }
    for (const reply of buffered) await this.sendReply(message, reply, activeAgentId);
    const stats = this.queue.stats();
    await this.options.stateStore.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: activeAgentId,
      activeChats: this.sessions.size,
      globalRunning: stats.running,
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
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    if (current) return current;
    const sessionId = randomUUID();
    await this.options.stateStore.upsertRuntimeSession({
      chatId,
      sessionId,
      agentId: this.options.agentId,
      runtimeSessionId: null,
      projectId: null,
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
