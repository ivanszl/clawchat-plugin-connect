import { defaultConfigPath, getAgent } from "../config";
import { buildReplyTextMessagePayload } from "../message-mapper";
import {
  allowedRuntimeKinds,
  type MaterializedRuntimeReply,
  materializeRuntimeOutput,
  policyForOutputVisibility,
  resolveOutputVisibility,
} from "../output-visibility";
import { type ChatType, EVENT, type NormalizedInboundMessage } from "../protocol";
import type { ConnectStateStore } from "../state";
import { registerClawChatToolsBestEffort } from "../tools/bridge";
import { createFileBackedMemoryPort, createMentionMessagePort } from "../tools/ports";
import type { ConnectConfig, RuntimeSessionRecord } from "../types";
import type { ConnectWsClient } from "../ws-client";
import { createAcpRuntimeAdapter } from "./acp-adapter";
import { createCodexRuntimeAdapter } from "./codex-adapter";
import { SessionQueue } from "./session-queue";
import type { ConnectRuntimeAdapter, ConnectRuntimeSession } from "./types";

export interface ConnectRuntimeOptions {
  agentId: string;
  config: ConnectConfig;
  configPath?: string;
  stateStore: ConnectStateStore;
  wsClient: ConnectWsClient;
  /** @deprecated Prefer runtimeAdapters when injecting test adapters. */
  runtimeAdapter?: ConnectRuntimeAdapter;
  runtimeAdapters?: Partial<Record<"acp" | "codex", ConnectRuntimeAdapter>>;
}

export class ConnectRuntime {
  private readonly runtimeAdapters: Record<"acp" | "codex", ConnectRuntimeAdapter>;
  private readonly sessions = new Map<string, ConnectRuntimeSession>();
  private readonly queue: SessionQueue;
  private readonly toolBridgeNotices = new Map<string, string>();
  private readonly sentToolBridgeNotices = new Set<string>();

  constructor(private readonly options: ConnectRuntimeOptions) {
    getAgent(options.config, options.agentId);
    this.runtimeAdapters = {
      acp: options.runtimeAdapters?.acp ?? options.runtimeAdapter ?? createAcpRuntimeAdapter(),
      codex: options.runtimeAdapters?.codex ?? options.runtimeAdapter ?? createCodexRuntimeAdapter(),
    };
    this.queue = new SessionQueue({
      maxConcurrentTurns: options.config.maxConcurrentTurns,
      maxPendingPerChat: options.config.maxPendingPerChat,
    });
  }

  async handleInboundMessage(message: NormalizedInboundMessage): Promise<void> {
    try {
      await this.queue.enqueue(message.chatId, async () => this.runTurn(message));
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
    this.toolBridgeNotices.clear();
    this.sentToolBridgeNotices.clear();
    for (const session of sessions) await session.close();
  }

  async closeSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, false);
  }

  async invalidateSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, true);
  }

  /** @deprecated Use invalidateSession. */
  async resetSession(chatId: string): Promise<boolean> {
    return await this.invalidateSession(chatId);
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId);
    const key = sessionKey(chatId, current?.sessionId ?? "default");
    const session = this.sessions.get(key);
    return (await session?.cancel?.()) ?? false;
  }

  private async releaseSession(chatId: string, invalidateRuntimeId: boolean): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId);
    const key = sessionKey(chatId, current?.sessionId ?? "default");
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    this.toolBridgeNotices.delete(key);
    this.sentToolBridgeNotices.delete(key);
    if (session) await session.close();
    if (invalidateRuntimeId && current) {
      await this.options.stateStore.setRuntimeSessionId(chatId, current.sessionId, null);
    }
    return Boolean(session) || Boolean(current?.runtimeSessionId);
  }

  private async runTurn(message: NormalizedInboundMessage): Promise<void> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(message.chatId);
    if (!current?.cwd) {
      await this.sendVisibleFailure(message, "Please set a working directory first:\n\n/dir /absolute/path/to/repo");
      return;
    }
    const activeAgentId = current.agentId || this.options.agentId;
    const agent = getAgent(this.options.config, activeAgentId);
    const session = await this.sessionForChat(current, activeAgentId);
    await this.sendToolBridgeNoticeOnce(message, current.sessionId, activeAgentId);
    const mode = await resolveOutputVisibility({
      config: this.options.config,
      store: this.options.stateStore,
      chatId: message.chatId,
    });
    const policy = policyForOutputVisibility(mode);
    const buffered: MaterializedRuntimeReply[] = [];
    for await (const event of session.prompt({
      prompt: renderPrompt(message),
      cwd: current.cwd,
      mode: current.mode ?? (agent.kind === "acp" ? agent.mode : undefined),
      metadata: { chatId: message.chatId, sessionId: current.sessionId, agentId: activeAgentId },
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

  private async sendToolBridgeNoticeOnce(
    message: NormalizedInboundMessage,
    sessionId: string,
    agentId: string,
  ): Promise<void> {
    const key = sessionKey(message.chatId, sessionId);
    const reason = this.toolBridgeNotices.get(key);
    if (!reason || this.sentToolBridgeNotices.has(key)) return;
    this.sentToolBridgeNotices.add(key);
    await this.sendReply(
      message,
      {
        text: `ClawChat tools were not dynamically registered with this ACP runtime: ${reason}\n\nIf you need ClawChat tools, configure the stdio MCP server: clawchat-connect mcp-server --agent ${agentId}`,
        requiredControl: false,
      },
      agentId,
    );
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

  private async sessionForChat(current: RuntimeSessionRecord, agentId: string): Promise<ConnectRuntimeSession> {
    const key = sessionKey(current.chatId, current.sessionId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const agent = getAgent(this.options.config, agentId);
    let session: ConnectRuntimeSession | null = null;
    session = await this.runtimeAdapters[agent.kind].start(agent, {
      agentId,
      chatId: current.chatId,
      sessionId: current.sessionId,
      runtimeSessionId: current.runtimeSessionId,
      configPath: this.options.configPath ?? defaultConfigPath(),
      stateDbPath: this.options.config.stateDbPath,
      onRuntimeSessionId: async (runtimeSessionId) => {
        if (!session || this.sessions.get(key) !== session) return;
        await this.options.stateStore.setRuntimeSessionId(current.chatId, current.sessionId, runtimeSessionId);
      },
    });
    this.sessions.set(key, session);
    if (!session.toolsAlreadyExposed) {
      const bridge = await registerClawChatToolsBestEffort(session, {
        agentId,
        config: this.options.config,
        stateStore: this.options.stateStore,
        chatId: current.chatId,
        mentionMessage: createMentionMessagePort(this.options.wsClient),
        memory: createFileBackedMemoryPort(this.options.config),
      }).catch((error) => ({ registered: false, reason: error instanceof Error ? error.message : String(error) }));
      if (!bridge.registered) {
        this.toolBridgeNotices.set(
          key,
          bridge.reason ?? "runtime declined dynamic tool registration; use the stdio MCP server",
        );
      }
    }
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
