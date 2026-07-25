import { handleChatCommand, isConnectControlMessage, requiresOrderedSessionControl } from "./chat-commands";
import type { TranscriptProjection } from "./client-interface/transcript-projection";
import { getAgentBinding } from "./config";
import { buildTextMessagePayload, normalizeInboundMessage } from "./message-mapper";
import type { ProjectCatalog } from "./projects";
import { type Envelope, EVENT, type NormalizedInboundMessage, type Transport } from "./protocol";
import { ConnectRuntime } from "./runtime/connect-runtime";
import type { RuntimeAdapterRegistry } from "./runtime/registry";
import type { RuntimeInteractionCoordinator } from "./runtime/runtime-interaction-coordinator";
import type { ConnectRuntimeMedia } from "./runtime/types";
import type { ConnectStateStore } from "./state";
import type { ActivationCredentials, ConnectConfig } from "./types";
import { ConnectWsClient } from "./ws-client";

export interface BindingRuntimeOptions {
  agentId: string;
  activation: ActivationCredentials;
  config: ConnectConfig;
  configPath: string;
  deviceId: string;
  stateStore: ConnectStateStore;
  projects: ProjectCatalog;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection?: TranscriptProjection;
  runtimeInteractions?: RuntimeInteractionCoordinator;
  wsTransport?: Transport;
  protocolEventHandlers?: BindingProtocolEventHandlers;
  writeError: (message: string) => void;
}

export type BindingProtocolEventType =
  | "stream"
  | "typing"
  | "presence"
  | "delivered"
  | "metadata_invalidated"
  | "notify"
  | "permission"
  | "history_transit"
  | "replay_done"
  | "message_error"
  | "unknown";

export type BindingProtocolEvent =
  | {
      [Type in BindingProtocolEventType]: { type: Type; envelope: Envelope };
    }[BindingProtocolEventType]
  | { type: "quarantined"; envelope: Envelope; error: string };

export type BindingProtocolEventHandlers = {
  [Type in BindingProtocolEvent["type"]]?: (
    event: Extract<BindingProtocolEvent, { type: Type }>,
  ) => void | Promise<void>;
};

export interface BindingRuntimeHandle {
  agentId: string;
  websocketUrl: string;
  deviceId: string;
  close(): Promise<void>;
  enqueueClientTurn?(
    sessionRef: string,
    prompt: string,
    media?: ConnectRuntimeMedia[],
  ): Promise<{ turnId: string; sessionRef: string }>;
  uploadClientMedia?(file: Blob, filename: string): Promise<ConnectRuntimeMedia>;
  cancelClientTurn?(sessionRef: string): Promise<boolean>;
}

export async function startBindingRuntime(options: BindingRuntimeOptions): Promise<BindingRuntimeHandle> {
  const binding = getAgentBinding(options.config, options.agentId);
  let runtime: ConnectRuntime;
  let inboundMessages: InboundMessageProcessor;
  let wsClient: ConnectWsClient;
  wsClient = new ConnectWsClient({
    agentId: options.agentId,
    url: options.config.websocketUrl,
    mediaUploadUrl: options.config.mediaUploadUrl,
    token: options.activation.accessToken,
    userId: options.activation.userId,
    userNickName: options.agentId,
    stateStore: options.stateStore,
    deviceId: options.deviceId,
    transport: options.wsTransport,
    messageHandler: (message) => inboundMessages.accept(message),
    protocolEventHandler: async (type, envelope) => await dispatchProtocolEventHandler(options, type, envelope),
    capabilities: {
      chatMetadataEvents: Boolean(options.protocolEventHandlers?.metadata_invalidated),
      notifySignals: Boolean(options.protocolEventHandlers?.notify),
      permissionEvents: Boolean(options.protocolEventHandlers?.permission),
      historySync: Boolean(options.protocolEventHandlers?.history_transit),
    },
  });
  runtime = new ConnectRuntime({
    agentId: options.agentId,
    config: options.config,
    configPath: options.configPath,
    stateStore: options.stateStore,
    wsClient,
    projects: options.projects,
    runtimeAdapters: options.runtimeAdapters,
    transcriptProjection: options.transcriptProjection,
    runtimeInteractions: options.runtimeInteractions,
  });
  inboundMessages = new InboundMessageProcessor(options, wsClient, runtime);
  wireQuarantineEvents(wsClient, options);
  wsClient.on("error", (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    options.writeError(`${options.agentId}: ${detail}\n`);
    void recordConnectionStatus(options, false, detail).catch(() => undefined);
  });
  wsClient.on("state", (state: string) => {
    if (state === "connected") {
      void recordConnectionStatus(options, true, null).catch(() => undefined);
      void inboundMessages
        .recover()
        .catch((error) =>
          options.writeError(
            `${options.agentId}: inbound recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
        );
    } else if (state === "disconnected") void recordConnectionStatus(options, false, null).catch(() => undefined);
  });
  try {
    await options.runtimeAdapters.prepare(binding);
    await wsClient.connect();
    await inboundMessages.recover();
    await recordConnectionStatus(options, true, null);
  } catch (error) {
    wsClient.close();
    await runtime.dispose();
    await recordConnectionStatus(options, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return {
    agentId: options.agentId,
    websocketUrl: options.config.websocketUrl,
    deviceId: options.deviceId,
    enqueueClientTurn: async (sessionRef, prompt, media) => await runtime.enqueueClientTurn(sessionRef, prompt, media),
    uploadClientMedia: async (file, filename) => await runtime.uploadClientMedia(file, filename),
    cancelClientTurn: async (sessionRef) => await runtime.cancelClientTurn(sessionRef),
    async close() {
      await inboundMessages.close();
      wsClient.close();
      await runtime.dispose();
      await recordConnectionStatus(options, false, null);
    },
  };
}

class InboundMessageProcessor {
  private readonly pending = new Map<string, Promise<void>>();
  private recovery: Promise<void> | null = null;
  private accepting = true;

  constructor(
    private readonly options: BindingRuntimeOptions,
    private readonly wsClient: ConnectWsClient,
    private readonly runtime: ConnectRuntime,
  ) {}

  accept(message: NormalizedInboundMessage): "accepted" {
    if (!this.accepting) throw new Error("inbound message processor is closing");
    const key = inboundHandlingKey(message);
    if (this.pending.has(key)) return "accepted";
    let markedHandled = false;
    const markHandled = async () => {
      if (markedHandled) return;
      await this.options.stateStore.markInboundMessageHandled(this.options.agentId, message.messageId, message.raw);
      markedHandled = true;
    };
    const work = dispatchInboundMessage({
      ...this.options,
      message,
      wsClient: this.wsClient,
      runtime: this.runtime,
      onTurnAccepted: markHandled,
    })
      .then(async (handledWithoutTurn) => {
        if (handledWithoutTurn) await markHandled();
      })
      .catch((error) =>
        this.options.writeError(
          `${this.options.agentId}: inbound message remains pending: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      )
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return "accepted";
  }

  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = this.recoverOnce().finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }

  private async recoverOnce(): Promise<void> {
    for (const raw of await this.options.stateStore.listUnhandledInboundMessages(this.options.agentId)) {
      const message = normalizeStoredInboundMessage(raw);
      if (!message) continue;
      if (await this.options.stateStore.hasReconciledInboundMessage(this.options.agentId, message.messageId)) {
        await this.options.stateStore.markInboundMessageHandled(this.options.agentId, message.messageId, message.raw);
        continue;
      }
      this.accept(message);
    }
  }

  async close(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled(this.pending.values());
  }
}

function normalizeStoredInboundMessage(raw: unknown): NormalizedInboundMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return normalizeInboundMessage(raw as Envelope);
}

function inboundHandlingKey(message: NormalizedInboundMessage): string {
  const content = { ...message.raw } as Record<string, unknown>;
  for (const field of ["dseq", "emitted_at", "trace_id"]) delete content[field];
  return `${message.messageId}:${JSON.stringify(content)}`;
}

async function dispatchProtocolEventHandler(
  options: BindingRuntimeOptions,
  type: BindingProtocolEventType,
  envelope: Envelope,
): Promise<void> {
  const handler = options.protocolEventHandlers?.[type] as
    | ((event: BindingProtocolEvent) => void | Promise<void>)
    | undefined;
  if (handler) await handler({ type, envelope } as BindingProtocolEvent);
}

function wireQuarantineEvents(wsClient: ConnectWsClient, options: BindingRuntimeOptions): void {
  wsClient.on("quarantined", (event: { envelope: Envelope; error: string }) => {
    options.writeError(
      `${options.agentId}: quarantined Protocol v2 ${event.envelope.event} dseq=${event.envelope.dseq ?? "?"}: ${event.error}\n`,
    );
    const handler = options.protocolEventHandlers?.quarantined;
    if (!handler) return;
    void Promise.resolve(handler({ type: "quarantined", ...event })).catch((error) =>
      options.writeError(
        `${options.agentId}: Protocol event handler failed: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    );
  });
}

async function dispatchInboundMessage(
  params: BindingRuntimeOptions & {
    message: NormalizedInboundMessage;
    wsClient: ConnectWsClient;
    runtime: ConnectRuntime;
    onTurnAccepted: () => Promise<void>;
  },
): Promise<boolean> {
  const routeCommand = async (): Promise<boolean> => {
    const command = await handleChatCommand({
      message: params.message,
      agentId: params.agentId,
      ownerUserId: params.activation.ownerUserId,
      config: params.config,
      stateStore: params.stateStore,
      projects: params.projects,
      closeRuntimeSession: (chatId) => params.runtime.closeSession(chatId),
      invalidateRuntimeSession: (chatId) => params.runtime.invalidateSession(chatId),
      cancelRuntimeTurn: (chatId) => params.runtime.cancelTurn(chatId),
      runtimeModesFor: (binding) => params.runtime.runtimeModesFor(binding),
      listRuntimeModels: (binding) => params.runtime.listRuntimeModels(binding),
      discoverRuntimeThreads: (chatId) => params.runtime.discoverRuntimeThreads(chatId),
    });
    if (!command.handled) return false;
    if (command.text) {
      await params.wsClient.sendMessageEnvelope(
        EVENT.MESSAGE_REPLY,
        params.message.chatId,
        buildTextMessagePayload(command.text),
        { toType: params.message.chatType },
      );
    }
    await params.onTurnAccepted();
    return true;
  };
  if (
    params.message.text.trim().split(/\s+/u)[0] === "/cancel" ||
    (isConnectControlMessage(params.message.text) &&
      (params.message.sender.id !== params.activation.ownerUserId ||
        !requiresOrderedSessionControl(params.message.text)))
  ) {
    await routeCommand();
    return true;
  }
  await params.runtime.handleInboundMessage(
    params.message,
    routeCommand,
    requiresOrderedSessionControl(params.message.text),
    params.onTurnAccepted,
  );
  return false;
}

async function recordConnectionStatus(
  options: BindingRuntimeOptions,
  websocketConnected: boolean,
  recentError: string | null,
): Promise<void> {
  await options.stateStore.setRuntimeConnectionStatus(options.agentId, websocketConnected, recentError);
}
