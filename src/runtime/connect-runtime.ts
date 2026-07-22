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
import { ProjectCatalog } from "../projects";
import { type ChatType, EVENT, type NormalizedInboundMessage } from "../protocol";
import type { ConnectStateStore } from "../state";
import type { AgentBindingConfig, ConnectConfig, RuntimeSessionRecord, RuntimeWorkspace } from "../types";
import type { ConnectWsClient } from "../ws-client";
import { MAX_RUNTIME_MEDIA_BYTES } from "./media-cache";
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
      const queueKey = message.chatId;
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
    const key = current.chatId;
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
      trustedMediaOrigins: configuredMediaOrigins(this.options.config),
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
      if (reply.requiredControl) await this.sendReply(message, reply, activeAgentId, workspace);
      else buffered.push(reply);
    }
    for (const reply of buffered) await this.sendReply(message, reply, activeAgentId, workspace);
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
    workspace?: RuntimeWorkspace,
  ): Promise<void> {
    const route = await this.resolveReplyRoute(message, reply, agentId);
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
  const origins = new Set<string>();
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
