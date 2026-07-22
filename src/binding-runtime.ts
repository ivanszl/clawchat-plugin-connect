import { handleChatCommand } from "./chat-commands";
import type { TranscriptProjection } from "./client-interface/transcript-projection";
import { getAgentBinding } from "./config";
import { buildTextMessagePayload } from "./message-mapper";
import type { ProjectCatalog } from "./projects";
import { type Envelope, EVENT, type NormalizedInboundMessage, type Transport } from "./protocol";
import { ConnectRuntime } from "./runtime/connect-runtime";
import type { RuntimeAdapterRegistry } from "./runtime/registry";
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
  enqueueClientTurn?(sessionRef: string, prompt: string): Promise<{ turnId: string; sessionRef: string }>;
  cancelClientTurn?(sessionRef: string): Promise<boolean>;
}

export async function startBindingRuntime(options: BindingRuntimeOptions): Promise<BindingRuntimeHandle> {
  const binding = getAgentBinding(options.config, options.agentId);
  const wsClient = new ConnectWsClient({
    agentId: options.agentId,
    url: options.config.websocketUrl,
    mediaUploadUrl: options.config.mediaUploadUrl,
    token: options.activation.accessToken,
    userId: options.activation.userId,
    userNickName: options.agentId,
    stateStore: options.stateStore,
    deviceId: options.deviceId,
    transport: options.wsTransport,
    protocolEventHandler: async (type, envelope) => await dispatchProtocolEventHandler(options, type, envelope),
    capabilities: {
      chatMetadataEvents: Boolean(options.protocolEventHandlers?.metadata_invalidated),
      notifySignals: Boolean(options.protocolEventHandlers?.notify),
      permissionEvents: Boolean(options.protocolEventHandlers?.permission),
      historySync: Boolean(options.protocolEventHandlers?.history_transit),
    },
  });
  const runtime = new ConnectRuntime({
    agentId: options.agentId,
    config: options.config,
    configPath: options.configPath,
    stateStore: options.stateStore,
    wsClient,
    projects: options.projects,
    runtimeAdapters: options.runtimeAdapters,
    transcriptProjection: options.transcriptProjection,
  });
  wsClient.on("message", (message: NormalizedInboundMessage) => {
    void dispatchInboundMessage({ ...options, message, wsClient, runtime }).catch((error) =>
      options.writeError(`${options.agentId}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
  });
  wireQuarantineEvents(wsClient, options);
  wsClient.on("error", (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    options.writeError(`${options.agentId}: ${detail}\n`);
    void recordConnectionStatus(options, false, detail).catch(() => undefined);
  });
  wsClient.on("state", (state: string) => {
    if (state === "connected") void recordConnectionStatus(options, true, null).catch(() => undefined);
    else if (state === "disconnected") void recordConnectionStatus(options, false, null).catch(() => undefined);
  });
  try {
    await options.runtimeAdapters.prepare(binding);
    await wsClient.connect();
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
    enqueueClientTurn: async (sessionRef, prompt) => await runtime.enqueueClientTurn(sessionRef, prompt),
    cancelClientTurn: async (sessionRef) => await runtime.cancelClientTurn(sessionRef),
    async close() {
      wsClient.close();
      await runtime.dispose();
      await recordConnectionStatus(options, false, null);
    },
  };
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
  },
): Promise<void> {
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
    return true;
  };
  if (params.message.text.trim().split(/\s+/u)[0] === "/cancel") {
    await routeCommand();
    return;
  }
  await params.runtime.handleInboundMessage(params.message, routeCommand);
}

async function recordConnectionStatus(
  options: BindingRuntimeOptions,
  websocketConnected: boolean,
  recentError: string | null,
): Promise<void> {
  await options.stateStore.setRuntimeConnectionStatus(options.agentId, websocketConnected, recentError);
}
