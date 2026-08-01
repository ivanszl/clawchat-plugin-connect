import { executeAgentLiveware, isAgentLivewareOperation } from "./agent-liveware";
import { createClawChatApiClient } from "./api-client";
import { handleChatCommand, isConnectControlMessage, requiresOrderedSessionControl } from "./chat-commands";
import type { TranscriptProjection } from "./client-interface/transcript-projection";
import { getAgentBinding } from "./config";
import {
  addressInboundMessage,
  buildReplyTextMessagePayload,
  buildTextMessagePayload,
  normalizeInboundMessage,
} from "./message-mapper";
import type { ProjectCatalog } from "./projects";
import { type Envelope, EVENT, type NormalizedInboundMessage, type Transport } from "./protocol";
import { ConnectRuntime } from "./runtime/connect-runtime";
import type { RuntimeAdapterRegistry } from "./runtime/registry";
import type { RuntimeInteractionCoordinator } from "./runtime/runtime-interaction-coordinator";
import { RuntimeInteractionRouter } from "./runtime/runtime-interaction-router";
import type { SessionActivity } from "./runtime/session-queue";
import type { ConnectRuntimeMedia, RuntimeSlashSelection } from "./runtime/types";
import { verifyInstalledSkills } from "./skills";
import type { ConnectStateStore } from "./state";
import { executeConnectTool } from "./tool-executor";
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
  verifyInstalledSkills?: () => Promise<void>;
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
    selection?: RuntimeSlashSelection | null,
    signal?: AbortSignal,
  ): Promise<{ turnId: string; sessionRef: string }>;
  uploadClientMedia?(file: Blob, filename: string): Promise<ConnectRuntimeMedia>;
  cancelClientTurn?(sessionRef: string): Promise<boolean>;
  sessionActivity?(sessionRef: string): Promise<SessionActivity>;
  activeClientTurnId?(sessionRef: string): string | null;
  claimSessionLifecycle?(sessionRef: string): Promise<() => Promise<void>>;
  executeTool?(toolName: string, input: Record<string, unknown>): Promise<unknown>;
}

export async function startBindingRuntime(options: BindingRuntimeOptions): Promise<BindingRuntimeHandle> {
  await (options.verifyInstalledSkills ?? verifyInstalledSkills)();
  const binding = getAgentBinding(options.config, options.agentId);
  const runtimeConfig: ConnectConfig = {
    ...options.config,
    agents: { ...options.config.agents, [options.agentId]: binding },
  };
  const clawChatApi = createClawChatApiClient({
    baseUrl: options.config.baseUrl,
    deviceId: options.deviceId,
    token: options.activation.accessToken,
  });
  const senderDisplayNames = new Map<string, Promise<string | null>>();
  const resolveSenderDisplayName = async (senderId: string): Promise<string | null> => {
    const active = senderDisplayNames.get(senderId);
    if (active) return await active;
    const resolution = clawChatApi
      .getUserProfile(senderId)
      .then((profile) => profile.nickname)
      .catch(() => {
        senderDisplayNames.delete(senderId);
        return null;
      });
    senderDisplayNames.set(senderId, resolution);
    return await resolution;
  };
  let runtime: ConnectRuntime;
  let inboundMessages: InboundMessageProcessor;
  let wsClient: ConnectWsClient;
  let interactionRouter: RuntimeInteractionRouter;
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
    interactionSubmitHandler: async (envelope) => await interactionRouter.handleInteractionSubmit(envelope),
    protocolEventHandler: async (type, envelope) => await dispatchProtocolEventHandler(options, type, envelope),
    capabilities: {
      chatMetadataEvents: Boolean(options.protocolEventHandlers?.metadata_invalidated),
      notifySignals: Boolean(options.protocolEventHandlers?.notify),
      permissionEvents: Boolean(options.protocolEventHandlers?.permission),
      historySync: Boolean(options.protocolEventHandlers?.history_transit),
    },
  });
  interactionRouter = new RuntimeInteractionRouter({
    clientPort: options.runtimeInteractions,
    ownerUserId: options.activation.ownerUserId,
    ownerConversationId: options.activation.conversationId,
    agentUserId: options.activation.userId,
    agentDisplayName: options.agentId,
    resolveSenderDisplayName,
    sendClawChatMessage: async (delivery) => {
      const payload = buildTextMessagePayload(
        "",
        delivery.sourceMessageId
          ? {
              replyToMessageId: delivery.sourceMessageId,
              replyPreview:
                delivery.sourceSender && delivery.sourceFragments
                  ? {
                      id: delivery.sourceSender.id,
                      nickName: delivery.sourceSender.displayName,
                      fragments: delivery.sourceFragments,
                    }
                  : null,
            }
          : {},
      );
      payload.message.body.fragments = delivery.fragments;
      payload.message.context.mentions = delivery.fragments.flatMap((fragment) => {
        if (fragment.kind !== "mention" || !fragment.user_id) return [];
        return [
          {
            user_id: fragment.user_id,
            ...(fragment.display ? { display: fragment.display } : {}),
          },
        ];
      });
      await wsClient.sendMessageEnvelope(EVENT.MESSAGE_REPLY, delivery.chatId, payload, { toType: delivery.chatType });
    },
  });
  runtime = new ConnectRuntime({
    agentId: options.agentId,
    config: runtimeConfig,
    configPath: options.configPath,
    stateStore: options.stateStore,
    wsClient,
    projects: options.projects,
    runtimeAdapters: options.runtimeAdapters,
    transcriptProjection: options.transcriptProjection,
    runtimeInteractions: interactionRouter,
    resolveSenderDisplayName,
  });
  inboundMessages = new InboundMessageProcessor(options, wsClient, runtime, interactionRouter);
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
    void resolveSenderDisplayName(options.activation.ownerUserId)
      .then(async (ownerDisplayName) => {
        if (ownerDisplayName) {
          await options.stateStore.updateTranscriptSenderDisplayName(options.activation.ownerUserId, ownerDisplayName);
        }
      })
      .catch((error) =>
        options.writeError(
          `${options.agentId}: sender display name backfill failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
    await inboundMessages.recover();
    await recordConnectionStatus(options, true, null);
    try {
      const synchronization = await runtime.synchronizeRuntimeProjects();
      for (const failure of synchronization.failures) {
        options.writeError(`${options.agentId}: Project synchronization skipped ${failure}\n`);
      }
    } catch (error) {
      options.writeError(
        `${options.agentId}: Project synchronization unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
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
    enqueueClientTurn: async (sessionRef, prompt, media, selection, signal) =>
      await runtime.enqueueClientTurn(sessionRef, prompt, media, selection, signal),
    uploadClientMedia: async (file, filename) => await runtime.uploadClientMedia(file, filename),
    cancelClientTurn: async (sessionRef) => await runtime.cancelClientTurn(sessionRef),
    sessionActivity: async (sessionRef) => await runtime.sessionActivity(sessionRef),
    activeClientTurnId: (sessionRef) => runtime.activeClientTurnId(sessionRef),
    claimSessionLifecycle: async (sessionRef) => await runtime.claimSessionLifecycle(sessionRef),
    executeTool: async (toolName, input) => {
      const toolOptions = {
        baseUrl: options.config.baseUrl,
        deviceId: options.deviceId,
        activation: options.activation,
        wsClient,
      };
      if (isAgentLivewareOperation(toolName)) {
        const managedAppId = (await options.stateStore.getLivewareExposure(options.agentId))?.appId ?? null;
        return await executeAgentLiveware(toolName, input, {
          activation: options.activation,
          clawChatBaseUrl: options.config.baseUrl,
          deviceId: options.deviceId,
          registerApp: async (name, appId, url) =>
            await executeConnectTool("clawchat_register_app", { name, appId, url }, toolOptions),
          unregisterApp: async (appId) => await executeConnectTool("clawchat_unregister_app", { appId }, toolOptions),
          managedAppId,
        });
      }
      return await executeConnectTool(toolName, input, toolOptions);
    },
    async close() {
      await inboundMessages.close();
      await interactionRouter.close();
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
    private readonly interactionRouter: RuntimeInteractionRouter,
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
      interactionRouter: this.interactionRouter,
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
    interactionRouter: RuntimeInteractionRouter;
    onTurnAccepted: () => Promise<void>;
  },
): Promise<boolean> {
  const addressed = addressInboundMessage(params.message, params.activation.userId);
  if (!addressed) return true;
  const message = addressed.message;
  const canRouteCommand = addressed.acceptsCommands || addressed.malformedLineBreakCommand;
  if (
    message.chatType === "group" &&
    addressed.hasAddressingMention &&
    !message.text.trim() &&
    !addressed.hasAttachment
  ) {
    await params.wsClient.sendMessageEnvelope(
      EVENT.MESSAGE_REPLY,
      message.chatId,
      buildReplyTextMessagePayload("Please include a message, attachment, or use @Agent /help.", message),
      { toType: message.chatType },
    );
    await params.onTurnAccepted();
    return true;
  }

  if (await params.interactionRouter.handleMessage(message)) {
    await params.onTurnAccepted();
    return true;
  }
  const routeCommand = async (): Promise<boolean> => {
    if (!canRouteCommand) return false;
    const command = await handleChatCommand({
      message,
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
      listRuntimeWorkspaces: () => params.runtime.listRuntimeWorkspaces(),
    });
    if (!command.handled) return false;
    if (command.text) {
      await params.wsClient.sendMessageEnvelope(
        EVENT.MESSAGE_REPLY,
        message.chatId,
        buildReplyTextMessagePayload(command.text, message),
        { toType: message.chatType },
      );
    }
    await params.onTurnAccepted();
    return true;
  };
  if (
    (canRouteCommand && message.text.trim().split(/\s+/u)[0] === "/cancel") ||
    (canRouteCommand &&
      isConnectControlMessage(message.text) &&
      (message.sender.id !== params.activation.ownerUserId || !requiresOrderedSessionControl(message.text)))
  ) {
    await routeCommand();
    return true;
  }
  await params.runtime.handleInboundMessage(
    message,
    routeCommand,
    canRouteCommand && requiresOrderedSessionControl(message.text),
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
