import { createClawChatApiClient, type FetchLike, normalizeActivationResult } from "./api-client";
import { getAgentBinding, loadConfig, saveConfig } from "./config";
import {
  createLivewareExposureDependencies,
  type LivewareExposureDependencies,
  prepareLivewareExposure,
  resolveLivewareExecutablePath,
  retireLivewareExposure,
} from "./liveware-exposure";
import { type ConnectStateStore, createStateStore } from "./state";
import type { ActivationCredentials, ConnectConfig } from "./types";

export interface ActivateConnectOptions {
  agentId: string;
  code: string;
  configPath?: string;
  config?: ConnectConfig;
  store?: ConnectStateStore;
  fetchImpl?: FetchLike;
  livewareDependencies?: LivewareExposureDependencies;
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
    const previousActivations = await store.listActivations();
    const previousExposure = await store.getLivewareExposure();
    const existingUserId = await store.getActivationUserId(agentId);
    const client = createClawChatApiClient({
      baseUrl: config.baseUrl,
      deviceId,
      fetchImpl: options.fetchImpl,
    });
    const result = normalizeActivationResult(agentId, await client.agentsConnect({ code, existingUserId }));
    const ownerChanged = previousActivations.some((activation) => activation.ownerUserId !== result.ownerUserId);
    let livewareDependencies = options.livewareDependencies;
    const getLivewareDependencies = async (): Promise<LivewareExposureDependencies> => {
      livewareDependencies ??= createLivewareExposureDependencies({
        livewarePath: await resolveLivewareExecutablePath(),
        clawChatBaseUrl: config.baseUrl,
        fetchImpl: options.fetchImpl,
      });
      return livewareDependencies;
    };
    if (ownerChanged && previousExposure) {
      const previousPrincipal = previousActivations.find(
        (activation) =>
          activation.localAgentId === previousExposure.localAgentId &&
          activation.ownerUserId === previousExposure.ownerUserId,
      );
      if (!previousPrincipal) {
        throw new Error(
          `Connect Owner replacement cannot retire Liveware Exposure ${previousExposure.appId}: its activation is missing`,
        );
      }
      await retireLivewareExposure(
        { activation: previousPrincipal, deviceId, stateStore: store },
        await getLivewareDependencies(),
      );
    }
    await store.replaceOwnerActivation(result);
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
    try {
      if (config.livewareAccessPolicy === "off") {
        const remainingExposure = await store.getLivewareExposure();
        if (remainingExposure) {
          await retireLivewareExposure(
            { activation: result, deviceId, stateStore: store },
            await getLivewareDependencies(),
          );
        }
      } else {
        await prepareLivewareExposure(
          {
            activation: result,
            deviceId,
            upstream: `http://127.0.0.1:${config.clientPort}`,
            accessPolicy: config.livewareAccessPolicy,
            stateStore: store,
          },
          await getLivewareDependencies(),
        );
      }
    } catch (error) {
      throw new Error(
        `Agent Binding ${agentId} credentials were saved, but Liveware Exposure synchronization failed: ${error instanceof Error ? error.message : String(error)}. Restart the Connect Service to retry.`,
      );
    }
    if ((result.conversationId || result.serverAgentId) && options.configPath)
      await saveConfig(config, options.configPath);
    return result;
  } finally {
    if (ownsStore) await store.close();
  }
}
