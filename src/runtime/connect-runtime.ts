import { getAgent } from "../config.js";
import { buildReplyTextMessagePayload } from "../message-mapper.js";
import { EVENT, type ChatType, type NormalizedInboundMessage } from "../protocol.js";
import type { ConnectStateStore } from "../state.js";
import type { ConnectConfig } from "../types.js";
import type { ConnectWsClient } from "../ws-client.js";
import { allowedRuntimeKinds, materializeRuntimeOutput, policyForOutputVisibility, resolveOutputVisibility, type MaterializedRuntimeReply } from "../output-visibility.js";
import { createAcpRuntimeAdapter, type ConnectRuntimeAdapter, type ConnectRuntimeSession } from "./acp-adapter.js";
import { registerClawChatToolsBestEffort } from "../tools/bridge.js";
import { createFileBackedMemoryPort, createMentionMessagePort } from "../tools/ports.js";
import { SessionQueue } from "./session-queue.js";

export interface ConnectRuntimeOptions { agentId: string; config: ConnectConfig; stateStore: ConnectStateStore; wsClient: ConnectWsClient; runtimeAdapter?: ConnectRuntimeAdapter; }

export class ConnectRuntime {
  private readonly runtimeAdapter: ConnectRuntimeAdapter;
  private readonly sessions = new Map<string, ConnectRuntimeSession>();
  private readonly queue: SessionQueue;
  private readonly toolBridgeNotices = new Map<string, string>();
  private readonly sentToolBridgeNotices = new Set<string>();

  constructor(private readonly options: ConnectRuntimeOptions) {
    getAgent(options.config, options.agentId);
    this.runtimeAdapter = options.runtimeAdapter ?? createAcpRuntimeAdapter();
    this.queue = new SessionQueue({ maxConcurrentTurns: options.config.maxConcurrentTurns, maxPendingPerChat: options.config.maxPendingPerChat });
  }

  async handleInboundMessage(message: NormalizedInboundMessage): Promise<void> {
    try {
      await this.queue.enqueue(message.chatId, async () => this.runTurn(message));
    } catch (error) {
      await this.sendVisibleFailure(message, `ClawChat runtime queue rejected this turn: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) await session.close();
    this.sessions.clear();
  }

  async resetSession(chatId: string): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId);
    const key = sessionKey(chatId, current?.sessionId ?? "default");
    const session = this.sessions.get(key);
    if (session) await session.close();
    this.sessions.delete(key);
    this.toolBridgeNotices.delete(key);
    this.sentToolBridgeNotices.delete(key);
    if (current) {
      await this.options.stateStore.upsertRuntimeSession({ chatId: current.chatId, sessionId: current.sessionId, agentId: current.agentId, runtimeSessionId: null, name: current.name, mode: current.mode, cwd: current.cwd, isCurrent: current.isCurrent });
    }
    return Boolean(session) || Boolean(current?.runtimeSessionId);
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId);
    const key = sessionKey(chatId, current?.sessionId ?? "default");
    const session = this.sessions.get(key);
    return await session?.cancel?.() ?? false;
  }

  private async runTurn(message: NormalizedInboundMessage): Promise<void> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(message.chatId);
    if (!current?.cwd) {
      await this.sendVisibleFailure(message, "Please set a working directory first:\n\n/dir /absolute/path/to/repo");
      return;
    }
    const activeAgentId = current.agentId || this.options.agentId;
    const agent = getAgent(this.options.config, activeAgentId);
    const session = await this.sessionForChat(message.chatId, current.sessionId, activeAgentId);
    await this.sendToolBridgeNoticeOnce(message, current.sessionId, activeAgentId);
    const mode = await resolveOutputVisibility({ config: this.options.config, store: this.options.stateStore, chatId: message.chatId });
    const policy = policyForOutputVisibility(mode);
    const buffered: MaterializedRuntimeReply[] = [];
    for await (const event of session.prompt({ prompt: renderPrompt(message), cwd: current.cwd, mode: current.mode ?? agent.mode, metadata: { chatId: message.chatId, sessionId: current.sessionId, agentId: activeAgentId }, outputPolicy: { mode: policy.mode, allowedKinds: allowedRuntimeKinds(policy) } })) {
      const reply = materializeRuntimeOutput(event, policy);
      if (!reply) continue;
      if (reply.requiredControl) await this.sendReply(message, reply, activeAgentId);
      else buffered.push(reply);
    }
    for (const reply of buffered) await this.sendReply(message, reply, activeAgentId);
    const stats = this.queue.stats();
    await this.options.stateStore.upsertRuntimeStatus({ websocketConnected: true, activeAgent: activeAgentId, activeChats: this.sessions.size, globalRunning: stats.running, globalQueued: stats.queued, recentError: null });
  }

  private async sendToolBridgeNoticeOnce(message: NormalizedInboundMessage, sessionId: string, agentId: string): Promise<void> {
    const key = sessionKey(message.chatId, sessionId);
    const reason = this.toolBridgeNotices.get(key);
    if (!reason || this.sentToolBridgeNotices.has(key)) return;
    this.sentToolBridgeNotices.add(key);
    await this.sendReply(message, { text: `ClawChat tools were not dynamically registered with this ACP runtime: ${reason}\n\nIf you need ClawChat tools, configure the stdio MCP server: clawchat-connect mcp-server --agent ${agentId}`, requiredControl: false }, agentId);
  }

  private async sendVisibleFailure(message: NormalizedInboundMessage, text: string): Promise<void> {
    await this.sendReply(message, { text, requiredControl: false }, this.options.agentId);
  }

  private async sendReply(message: NormalizedInboundMessage, reply: MaterializedRuntimeReply, agentId: string): Promise<void> {
    const route = await this.resolveReplyRoute(message, reply, agentId);
    await this.options.wsClient.sendMessageEnvelope(EVENT.MESSAGE_REPLY, route.chatId, buildReplyTextMessagePayload(reply.text, message), { toType: route.chatType });
  }

  private async resolveReplyRoute(message: NormalizedInboundMessage, reply: MaterializedRuntimeReply, agentId: string): Promise<{ chatId: string; chatType: ChatType }> {
    if (!reply.requiredControl || message.chatType !== "group") return { chatId: message.chatId, chatType: message.chatType };
    const activation = await this.options.stateStore.getActivation(agentId).catch(() => null);
    const ownerDirectChatId = activation?.conversationId ?? null;
    if (!ownerDirectChatId) throw new Error("owner direct conversation is unavailable for required control delivery");
    return { chatId: ownerDirectChatId, chatType: "direct" };
  }

  private async sessionForChat(chatId: string, sessionId: string, agentId: string): Promise<ConnectRuntimeSession> {
    const key = sessionKey(chatId, sessionId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const agent = getAgent(this.options.config, agentId);
    const session = await this.runtimeAdapter.start(agent);
    const bridge = await registerClawChatToolsBestEffort(session, { agentId, config: this.options.config, stateStore: this.options.stateStore, chatId, mentionMessage: createMentionMessagePort(this.options.wsClient), memory: createFileBackedMemoryPort(this.options.config) }).catch((error) => ({ registered: false, reason: error instanceof Error ? error.message : String(error) }));
    if (!bridge.registered) this.toolBridgeNotices.set(key, bridge.reason ?? "runtime declined dynamic tool registration; use the stdio MCP server");
    this.sessions.set(key, session);
    return session;
  }
}

function sessionKey(chatId: string, sessionId: string): string { return `${chatId}:${sessionId}`; }
function renderPrompt(message: NormalizedInboundMessage): string { const sender = message.sender.nick_name || message.sender.id; return [`ClawChat ${message.chatType} message from ${sender}:`, message.text].join("\n"); }
