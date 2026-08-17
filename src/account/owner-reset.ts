import { resolve } from "node:path";
import { FileTurnSubmissionStaging } from "../client-interface/turn-submission-staging";
import { defaultConfigPath, loadConfig, saveConfig } from "../config";
import { type ConnectStateStore, createStateStore } from "../persistence/state";
import { retireOfficialLivewarePublications } from "../plugin/official/liveware-retirement";
import { manageBackgroundService } from "../service/background-service";
import { WorkspaceCatalog } from "../workspaces/workspaces";

export const OWNER_RESET_CONFIRMATION_PHRASE = "RESET INSTALLATION OWNER" as const;

export const OWNER_RESET_PREVIEW = `${[
  "Owner Reset will permanently remove:",
  "- Installation Owner and every Agent Binding",
  "- activation credentials and owner-scoped ClawChat connections",
  "- Liveware registrations, tunnel bindings, and managed Apps",
  "- Sessions, Session Refs, ClawChat conversation and Runtime Thread mappings",
  "- Queued Turns, Runtime Interactions, transcript projection, and Tool Requests",
  "- Binding preferences and Workspace Catalog records",
  "Owner Reset will retain:",
  "- installed Plugins, Plugin lock state, and installation-level Plugin configuration",
  "- native Runtime Threads and Runtime Transcripts",
  "- coding-agent installations and configuration",
  "- all Workspace files, including Binding Default Workspaces",
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
  retireLivewarePublications?: (bindingIds: readonly string[]) => Promise<void>;
  purgeStagedSessions?: (sessionRefs: readonly string[]) => Promise<void>;
  purgeBindingCatalog?: (bindingIds: readonly string[]) => Promise<void>;
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
    const bindingIds = [
      ...new Set([...Object.keys(config.agents), ...activations.map((activation) => activation.localAgentId)]),
    ].sort();
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

    await (
      dependencies.retireLivewarePublications ??
      (async (retiredBindingIds: readonly string[]) =>
        await retireOfficialLivewarePublications({
          bindingIds: retiredBindingIds,
          configPath,
          clawChatBaseUrl: config.baseUrl,
          stateStore: store,
        }))
    )(bindingIds);

    const sessions = await store.listAllRuntimeSessions();
    const sessionRefs = sessions.map((session) => session.sessionRef);
    if (dependencies.purgeStagedSessions) {
      await dependencies.purgeStagedSessions(sessionRefs);
    } else {
      await new FileTurnSubmissionStaging(config.stateDbPath).purgeSessions(sessionRefs);
    }

    if (dependencies.purgeBindingCatalog) {
      await dependencies.purgeBindingCatalog(bindingIds);
    } else {
      const workspaces = new WorkspaceCatalog(store);
      for (const bindingId of bindingIds) await workspaces.purgeBindingCatalog(bindingId);
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
