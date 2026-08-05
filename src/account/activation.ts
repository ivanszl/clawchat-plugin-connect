import { createClawChatApiClient, type FetchLike, normalizeActivationResult } from "../clawchat/api-client";
import { getAgentBinding, loadConfig, saveConfig } from "../config";
import { type ConnectStateStore, createStateStore } from "../persistence/state";
import type { ActivationCredentials, ConnectConfig } from "../types";

export interface ActivateConnectOptions {
  agentId: string;
  code: string;
  configPath?: string;
  config?: ConnectConfig;
  store?: ConnectStateStore;
  fetchImpl?: FetchLike;
}
export type ActivateConnectResult = ActivationCredentials;

export async function activateConnect(options: ActivateConnectOptions): Promise<ActivateConnectResult> {
  const agentId = options.agentId.trim();
  if (!agentId) throw new Error("agentId is required");
  const code = options.code.trim();
  if (!code) throw new Error("activation code is required");
  const config = options.config ?? (await loadConfig(options.configPath));
  getAgentBinding(config, agentId);
  const store = options.store ?? createStateStore({ dbPath: config.stateDbPath });
  const ownsStore = !options.store;
  try {
    const deviceId = await store.getOrCreateDeviceId();
    const existingActivation = await store.getActivation(agentId);
    const existingUserId = existingActivation?.userId ?? null;
    const client = createClawChatApiClient({
      baseUrl: config.baseUrl,
      deviceId,
      fetchImpl: options.fetchImpl,
    });
    const result = normalizeActivationResult(agentId, await client.agentsConnect({ code, existingUserId }));
    if (existingActivation && existingActivation.ownerUserId !== result.ownerUserId) {
      throw new Error(
        `ClawChat re-pair ownership contract was violated for Agent Binding ${agentId}; its existing credentials were preserved`,
      );
    }
    await store.upsertActivation(result);
    const authenticatedClient = createClawChatApiClient({
      baseUrl: config.baseUrl,
      deviceId,
      token: result.accessToken,
      fetchImpl: options.fetchImpl,
    });
    try {
      await authenticatedClient.updateMyProfile({ nickname: agentId });
    } catch (error) {
      throw new Error(
        `Agent Binding ${agentId} credentials were saved, but ClawChat Profile nickname synchronization failed: ${error instanceof Error ? error.message : String(error)}. Activate again with a fresh code to retry.`,
      );
    }
    if ((result.conversationId || result.serverAgentId) && options.configPath)
      await saveConfig(config, options.configPath);
    return result;
  } finally {
    if (ownsStore) await store.close();
  }
}
