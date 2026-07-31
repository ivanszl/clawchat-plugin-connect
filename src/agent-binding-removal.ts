import { resolve } from "node:path";
import { manageBackgroundService } from "./background-service";
import { defaultConfigPath, loadConfig, saveConfig } from "./config";
import {
  createLivewareExposureDependencies,
  resolveLivewareExecutablePath,
  retireLivewareExposure,
} from "./liveware-exposure";
import { type ConnectStateStore, createStateStore } from "./state";
import type { ActivationCredentials } from "./types";

export interface RemoveAgentBindingOptions {
  agentId: string;
  configPath?: string;
}

export interface RemoveAgentBindingResult {
  agentId: string;
  configPath: string;
}

export interface RemoveAgentBindingDependencies {
  store?: ConnectStateStore;
  stopService?: (configPath: string) => Promise<void>;
  retireLivewareExposure?: (options: {
    activation: ActivationCredentials;
    deviceId: string;
    stateStore: ConnectStateStore;
  }) => Promise<void>;
}

export async function removeAgentBinding(
  options: RemoveAgentBindingOptions,
  dependencies: RemoveAgentBindingDependencies = {},
): Promise<RemoveAgentBindingResult> {
  const agentId = options.agentId.trim();
  if (!agentId) throw new Error("agent id is required");
  const configPath = resolve(options.configPath ?? defaultConfigPath());
  const config = await loadConfig(configPath);
  if (!config.agents[agentId]) throw new Error(`Unknown clawchat-connect agent: ${agentId}`);
  const store = dependencies.store ?? createStateStore({ dbPath: config.stateDbPath });
  const ownsStore = !dependencies.store;
  try {
    await (
      dependencies.stopService ??
      (async (path: string) => {
        const status = await manageBackgroundService({ action: "status", configPath: path });
        if (status.running) await manageBackgroundService({ action: "stop", configPath: path });
      })
    )(configPath);
    const activation = await store.getActivation(agentId);
    const exposure = await store.getLivewareExposure(agentId);
    if (exposure) {
      if (!activation) {
        throw new Error(
          `Agent Binding ${agentId} cannot retire Liveware Exposure ${exposure.appId}: its activation is missing`,
        );
      }
      const deviceId = await store.getOrCreateDeviceId();
      if (dependencies.retireLivewareExposure) {
        await dependencies.retireLivewareExposure({ activation, deviceId, stateStore: store });
      } else {
        await retireLivewareExposure(
          { activation, deviceId, stateStore: store },
          createLivewareExposureDependencies({
            livewarePath: await resolveLivewareExecutablePath(),
            clawChatBaseUrl: config.baseUrl,
          }),
        );
      }
    }
    await store.purgeAgentBinding(agentId);
    delete config.agents[agentId];
    if (config.defaultAgent === agentId) config.defaultAgent = Object.keys(config.agents)[0] ?? null;
    return { agentId, configPath: await saveConfig(config, configPath) };
  } finally {
    if (ownsStore) await store.close();
  }
}
