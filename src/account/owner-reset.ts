import { resolve } from "node:path";
import { FileTurnSubmissionStaging } from "../client-interface/turn-submission-staging";
import { defaultConfigPath, loadConfig, saveConfig } from "../config";
import { type ConnectStateStore, createStateStore } from "../persistence/state";
import { ProjectCatalog } from "../projects/projects";
import { manageBackgroundService } from "../service/background-service";
import {
  createLivewareExposureDependencies,
  type LivewareExposureDependencies,
  resolveLivewareExecutablePath,
  retireLivewareExposure,
} from "../service/liveware-exposure";
import type { ActivationCredentials } from "../types";

export const OWNER_RESET_CONFIRMATION_PHRASE = "RESET INSTALLATION OWNER" as const;

export const OWNER_RESET_PREVIEW = `${[
  "Owner Reset will permanently remove:",
  "- Installation Owner and every Agent Binding",
  "- activation credentials and owner-scoped ClawChat connections",
  "- Liveware registrations, tunnel bindings, and managed Apps",
  "- Sessions, Session Refs, ClawChat conversation and Runtime Thread mappings",
  "- Queued Turns, Runtime Interactions, transcript projection, and Tool Requests",
  "- Binding preferences and Binding-scoped transient workspaces",
  "Owner Reset will retain:",
  "- installed Plugins, Plugin lock state, and installation-level Plugin configuration",
  "- global Projects and host configuration",
  "- native Runtime Threads and Runtime Transcripts",
  "- coding-agent installations and configuration",
  "- Project workspace files and all other non-transient workspace files",
].join("\n")}\n`;

export interface ResetInstallationOwnerOptions {
  configPath?: string;
}

export interface ResetInstallationOwnerResult {
  ownerUserId: string | null;
  removedBindings: string[];
  configPath: string;
}

export interface ResetInstallationOwnerDependencies {
  store?: ConnectStateStore;
  getServiceStatus?: (configPath: string) => Promise<{ running: boolean }>;
  stopService?: (configPath: string) => Promise<void>;
  startService?: (configPath: string) => Promise<void>;
  retireLivewareExposure?: (options: {
    activation: ActivationCredentials;
    deviceId: string;
    stateStore: ConnectStateStore;
  }) => Promise<void>;
  livewareDependencies?: LivewareExposureDependencies;
  purgeStagedSessions?: (sessionRefs: readonly string[]) => Promise<void>;
  purgeBindingWorkspaces?: (bindingIds: readonly string[]) => Promise<void>;
}

export async function resetInstallationOwner(
  options: ResetInstallationOwnerOptions,
  dependencies: ResetInstallationOwnerDependencies = {},
): Promise<ResetInstallationOwnerResult> {
  const configPath = resolve(options.configPath ?? defaultConfigPath());
  const config = await loadConfig(configPath);
  const store = dependencies.store ?? createStateStore({ dbPath: config.stateDbPath });
  const ownsStore = !dependencies.store;
  let serviceStopped = false;
  let resetCompleted = false;
  try {
    const ownerResetState = await store.prepareInstallationOwnerReset();
    const ownerUserId = ownerResetState.ownerUserId;
    const ambiguousLegacyOwners = ownerUserId === null && ownerResetState.legacyOwnerUserIds.length > 1;
    if (!ownerUserId && !ambiguousLegacyOwners)
      throw new Error("Connect installation is already unowned; activate an Agent Binding to establish an owner");

    const activations = await store.listActivations();
    const activationByBinding = new Map(activations.map((activation) => [activation.localAgentId, activation]));
    const exposures = await store.listLivewareExposures();
    const retirableExposures = exposures.filter((exposure) => {
      const activation = activationByBinding.get(exposure.localAgentId);
      if (!activation) {
        if (ambiguousLegacyOwners) return false;
        throw new Error(
          `Cannot reset Installation Owner while Liveware App ${exposure.appId} lacks credentials for Agent Binding ${exposure.localAgentId}`,
        );
      }
      if (activation.ownerUserId !== exposure.ownerUserId) {
        if (ambiguousLegacyOwners) return false;
        throw new Error(
          `Cannot reset Installation Owner ${ownerUserId} with owner-inconsistent Agent Binding ${exposure.localAgentId}`,
        );
      }
      if (ownerUserId && activation.ownerUserId !== ownerUserId) {
        throw new Error(
          `Cannot reset Installation Owner ${ownerUserId} with owner-inconsistent Agent Binding ${exposure.localAgentId}`,
        );
      }
      return true;
    });
    if (ownerUserId) {
      for (const activation of activations) {
        if (activation.ownerUserId !== ownerUserId) {
          throw new Error(
            `Cannot reset Installation Owner ${ownerUserId} with owner-inconsistent Agent Binding ${activation.localAgentId}`,
          );
        }
      }
    }

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

    if (retirableExposures.length > 0) {
      const deviceId = await store.getOrCreateDeviceId();
      const livewareDependencies =
        dependencies.retireLivewareExposure || dependencies.livewareDependencies
          ? dependencies.livewareDependencies
          : createLivewareExposureDependencies({
              livewarePath: await resolveLivewareExecutablePath(),
              clawChatBaseUrl: config.baseUrl,
            });
      for (const exposure of retirableExposures) {
        const activation = activationByBinding.get(exposure.localAgentId);
        if (!activation) continue;
        if (dependencies.retireLivewareExposure) {
          await dependencies.retireLivewareExposure({ activation, deviceId, stateStore: store });
        } else {
          if (!livewareDependencies) throw new Error("Liveware cleanup dependencies are unavailable");
          await retireLivewareExposure({ activation, deviceId, stateStore: store }, livewareDependencies);
        }
      }
    }

    const sessions = await store.listAllRuntimeSessions();
    const sessionRefs = sessions.map((session) => session.sessionRef);
    if (dependencies.purgeStagedSessions) {
      await dependencies.purgeStagedSessions(sessionRefs);
    } else {
      await new FileTurnSubmissionStaging(config.stateDbPath).purgeSessions(sessionRefs);
    }

    const bindingIds = [
      ...new Set([...Object.keys(config.agents), ...activations.map((activation) => activation.localAgentId)]),
    ].sort();
    if (dependencies.purgeBindingWorkspaces) {
      await dependencies.purgeBindingWorkspaces(bindingIds);
    } else {
      const projects = new ProjectCatalog(store);
      for (const bindingId of bindingIds) await projects.purgeBindingWorkspaces(bindingId);
    }

    const resetConfig = { ...config, defaultAgent: null, agents: {} };
    const savedConfigPath = await saveConfig(resetConfig, configPath);
    try {
      await store.purgeInstallationOwnerState(ownerUserId);
    } catch (error) {
      await saveConfig(config, configPath);
      throw error;
    }
    resetCompleted = true;
    return {
      ownerUserId,
      removedBindings: bindingIds,
      configPath: savedConfigPath,
    };
  } finally {
    try {
      if (serviceStopped && !resetCompleted) {
        await (
          dependencies.startService ??
          (async (path: string) => {
            await manageBackgroundService({ action: "start", configPath: path });
          })
        )(configPath);
      }
    } finally {
      store.finishInstallationOwnerReset();
      if (ownsStore) await store.close();
    }
  }
}
