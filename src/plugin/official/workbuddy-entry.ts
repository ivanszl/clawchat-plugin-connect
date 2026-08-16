import type { ConnectRuntimeAdapter } from "../../runtime/types";
import {
  createWorkBuddyRuntimeAdapter,
  type WorkBuddyRuntimeAdapterBinding,
  type WorkBuddyRuntimeAdapterOptions,
} from "../../runtime/workbuddy-adapter";
import type { WorkBuddyProfile } from "../../runtime/workbuddy-task-discovery";
import type { ConnectPluginEntry, ConnectPluginRuntimeAdapter, ConnectPluginRuntimeStartContext } from "../sdk";
import {
  OFFICIAL_WORKBUDDY_DISTRIBUTIONS,
  WORKBUDDY_OFFICIAL_PLUGIN_ID,
  WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
} from "./workbuddy-manifest";

export {
  WORKBUDDY_AI_CAPABILITY_ID,
  WORKBUDDY_BINDING_CONFIGURATION_SCHEMA,
  WORKBUDDY_CN_CAPABILITY_ID,
  WORKBUDDY_INSTALLATION_CONFIGURATION_SCHEMA,
  WORKBUDDY_OFFICIAL_PLUGIN_ID,
  WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
} from "./workbuddy-manifest";

const CAPABILITIES = OFFICIAL_WORKBUDDY_DISTRIBUTIONS;

/**
 * Creates the official entry while retaining the Adapter's existing highest
 * fake boundary for deterministic conformance tests. Production activation
 * always uses the default, distribution-owned source.
 */
export function createWorkBuddyOfficialPluginEntry(
  adapterOptions: WorkBuddyRuntimeAdapterOptions = {},
): ConnectPluginEntry {
  return {
    activate(context) {
      const runtimeProviders = context.hostCapabilities.get("runtime-provider");
      for (const capability of CAPABILITIES) {
        runtimeProviders.register({
          capabilityId: capability.capabilityId,
          family: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
          create() {
            const binding = workBuddyBinding(capability.profile, capability.capabilityId);
            return bridgeWorkBuddyAdapter(createWorkBuddyRuntimeAdapter(adapterOptions), binding);
          },
        });
      }
    },
  };
}

export function createWorkBuddyOfficialAdapter(
  profile: WorkBuddyProfile,
  adapterOptions: WorkBuddyRuntimeAdapterOptions = {},
): ConnectPluginRuntimeAdapter {
  const capability = CAPABILITIES.find((candidate) => candidate.profile === profile);
  if (!capability) throw new Error(`Unsupported WorkBuddy profile: ${profile}`);
  return bridgeWorkBuddyAdapter(
    createWorkBuddyRuntimeAdapter(adapterOptions),
    workBuddyBinding(profile, capability.capabilityId),
  );
}

function bridgeWorkBuddyAdapter(
  adapter: ConnectRuntimeAdapter,
  binding: WorkBuddyRuntimeAdapterBinding,
): ConnectPluginRuntimeAdapter {
  return {
    modes: adapter.modes,
    lifecycleCapabilities: adapter.lifecycleCapabilities,
    prepare: adapter.prepare ? async () => await adapter.prepare?.(binding) : undefined,
    modesFor: adapter.modesFor ? (scope) => adapter.modesFor?.(binding, scope) ?? adapter.modes : undefined,
    listModels: adapter.listModels ? async (scope) => (await adapter.listModels?.(binding, scope)) ?? [] : undefined,
    listSessionOptions: adapter.listSessionOptions
      ? async (workspace, scope) => (await adapter.listSessionOptions?.(binding, workspace, scope)) ?? []
      : undefined,
    listSkills: adapter.listSkills
      ? async (workspace, options) => (await adapter.listSkills?.(binding, workspace, options)) ?? []
      : undefined,
    onSkillsChanged: adapter.onSkillsChanged?.bind(adapter),
    listCommands: adapter.listCommands
      ? async (workspace, options) => (await adapter.listCommands?.(binding, workspace, options)) ?? []
      : undefined,
    onCommandsChanged: adapter.onCommandsChanged?.bind(adapter),
    onCatalogsChanged: adapter.onCatalogsChanged?.bind(adapter),
    discoverThreads: adapter.discoverThreads
      ? async (workspace) => (await adapter.discoverThreads?.(binding, workspace)) ?? []
      : undefined,
    discoverAllThreads: adapter.discoverAllThreads
      ? async () => (await adapter.discoverAllThreads?.(binding)) ?? []
      : undefined,
    discoverArchivedThreads: adapter.discoverArchivedThreads
      ? async () => (await adapter.discoverArchivedThreads?.(binding)) ?? []
      : undefined,
    verifyThreadReady: adapter.verifyThreadReady
      ? async (runtimeThreadId) => await adapter.verifyThreadReady?.(binding, runtimeThreadId)
      : undefined,
    readActivity: adapter.readActivity
      ? async (runtimeThreadId) => {
          const snapshot = await adapter.readActivity?.(binding, runtimeThreadId);
          if (!snapshot) throw new Error("WorkBuddy Runtime Adapter returned no activity");
          return snapshot;
        }
      : undefined,
    reconcileInput: adapter.reconcileInput
      ? async (runtimeThreadId, candidate) =>
          (await adapter.reconcileInput?.(binding, runtimeThreadId, candidate)) ?? { outcome: "unknown" }
      : undefined,
    archiveThread: adapter.archiveThread
      ? async (runtimeThreadId) => await adapter.archiveThread?.(binding, runtimeThreadId)
      : undefined,
    unarchiveThread: adapter.unarchiveThread
      ? async (runtimeThreadId) => await adapter.unarchiveThread?.(binding, runtimeThreadId)
      : undefined,
    deleteThread: adapter.deleteThread
      ? async (runtimeThreadId) => await adapter.deleteThread?.(binding, runtimeThreadId)
      : undefined,
    start: async (context) => await startWithoutHostPaths(adapter, binding, context),
    close: adapter.close ? async () => await adapter.close?.() : undefined,
  };
}

async function startWithoutHostPaths(
  adapter: ConnectRuntimeAdapter,
  binding: WorkBuddyRuntimeAdapterBinding,
  context: ConnectPluginRuntimeStartContext,
) {
  return await adapter.start(binding, {
    agentId: context.agentId,
    chatId: context.chatId,
    sessionId: context.sessionId,
    runtimeSessionId: context.runtimeThreadId,
    onRuntimeSessionId: context.onRuntimeThreadId,
    cacheMedia: context.cacheMedia,
  });
}
function workBuddyBinding(
  profile: WorkBuddyProfile,
  capabilityId: (typeof CAPABILITIES)[number]["capabilityId"],
): WorkBuddyRuntimeAdapterBinding {
  return {
    runtime: { pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID, capabilityId },
    runtimeConfig: {},
    profile,
  };
}


export default createWorkBuddyOfficialPluginEntry();
