import { resolve } from "node:path";
import { manageBackgroundService } from "./background-service";
import { FileTurnSubmissionStaging } from "./client-interface/turn-submission-staging";
import { defaultConfigPath, loadConfig, saveConfig } from "./config";
import {
  createLivewareExposureDependencies,
  resolveLivewareExecutablePath,
  retireLivewareExposure,
} from "./liveware-exposure";
import { ProjectCatalog } from "./projects";
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
  getServiceStatus?: (configPath: string) => Promise<{ running: boolean }>;
  stopService?: (configPath: string) => Promise<void>;
  startService?: (configPath: string) => Promise<void>;
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
  if (!agentId) throw new Error("Agent Binding ID is required");
  const configPath = resolve(options.configPath ?? defaultConfigPath());
  const config = await loadConfig(configPath);
  if (!config.agents[agentId]) throw new Error(`Unknown Agent Binding: ${agentId}`);
  const store = dependencies.store ?? createStateStore({ dbPath: config.stateDbPath });
  const ownsStore = !dependencies.store;
  let serviceStopped = false;
  try {
    const serviceStatus = await (
      dependencies.getServiceStatus ??
      (async (path: string) => await manageBackgroundService({ action: "status", configPath: path }))
    )(configPath);
    if (serviceStatus.running) {
      await (
        dependencies.stopService ??
        (async (path: string) => {
          await manageBackgroundService({ action: "stop", configPath: path });
        })
      )(configPath);
      serviceStopped = true;
    }
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
    const sessionRefs = (await store.listAllRuntimeSessions())
      .filter((session) => session.agentId === agentId)
      .map((session) => session.sessionRef);
    await new FileTurnSubmissionStaging(config.stateDbPath).purgeSessions(sessionRefs);
    await new ProjectCatalog(store).purgeBindingWorkspaces(agentId);
    await store.purgeAgentBinding(agentId);
    delete config.agents[agentId];
    if (config.defaultAgent === agentId) config.defaultAgent = Object.keys(config.agents)[0] ?? null;
    return { agentId, configPath: await saveConfig(config, configPath) };
  } finally {
    try {
      if (serviceStopped && Object.keys(config.agents).length > 0) {
        await (
          dependencies.startService ??
          (async (path: string) => {
            await manageBackgroundService({ action: "start", configPath: path });
          })
        )(configPath);
      }
    } finally {
      if (ownsStore) await store.close();
    }
  }
}
