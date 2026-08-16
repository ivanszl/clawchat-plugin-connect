import {
  createOpenCodeRuntimeAdapter,
  type OpenCodeRuntimeAdapter,
  type OpenCodeRuntimeAdapterBinding,
  type OpenCodeRuntimeAdapterOptions,
} from "../../runtime/opencode-adapter";
import type {
  ConnectPluginConfiguration,
  ConnectPluginEntry,
  ConnectPluginRuntimeAdapter,
  ConnectPluginRuntimeStartContext,
} from "../sdk";
import { type CompatibleOpenCodeExecutable, requireCompatibleOpenCodeExecutable } from "./opencode-compatibility";
import {
  OPENCODE_OFFICIAL_CAPABILITY_ID,
  OPENCODE_OFFICIAL_PLUGIN_ID,
  OPENCODE_OFFICIAL_RUNTIME_FAMILY,
} from "./opencode-manifest";

interface OpenCodeInstallationConfiguration {
  executablePath?: string;
}

export interface OpenCodeOfficialPluginEntryOptions {
  runtimeAdapter?: OpenCodeRuntimeAdapterOptions;
  requireExecutable?: (
    configuredPath: string | undefined,
    env: Readonly<Record<string, string>> | undefined,
  ) => CompatibleOpenCodeExecutable;
}

export function createOpenCodeOfficialPluginEntry(
  options: OpenCodeOfficialPluginEntryOptions = {},
): ConnectPluginEntry {
  return {
    activate(context) {
      const installation = context.installationConfiguration as OpenCodeInstallationConfiguration;
      context.hostCapabilities.get("runtime-provider").register({
        capabilityId: OPENCODE_OFFICIAL_CAPABILITY_ID,
        family: OPENCODE_OFFICIAL_RUNTIME_FAMILY,
        create(configuration) {
          const binding = openCodeBinding(installation, configuration);
          const executable = (options.requireExecutable ?? requireCompatibleOpenCodeExecutable)(
            binding.executablePathOverride,
            binding.env,
          );
          return bridgeOpenCodeAdapter(createOpenCodeRuntimeAdapter(options.runtimeAdapter), {
            ...binding,
            executablePathOverride: executable.path,
          });
        },
      });
    },
  };
}

function openCodeBinding(
  installation: OpenCodeInstallationConfiguration,
  configuration: ConnectPluginConfiguration,
): OpenCodeRuntimeAdapterBinding {
  const binding = structuredClone(configuration) as Omit<OpenCodeRuntimeAdapterBinding, "runtime" | "runtimeConfig">;
  return {
    runtime: {
      pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
      capabilityId: OPENCODE_OFFICIAL_CAPABILITY_ID,
    },
    runtimeConfig: structuredClone(configuration) as Record<string, unknown>,
    ...(installation.executablePath && !binding.executablePathOverride
      ? { executablePathOverride: installation.executablePath }
      : {}),
    ...binding,
  };
}

function bridgeOpenCodeAdapter(
  adapter: OpenCodeRuntimeAdapter,
  binding: OpenCodeRuntimeAdapterBinding,
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
          if (!snapshot) throw new Error("OpenCode Runtime Adapter returned no activity");
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
    start: async (context) => await adapter.start(binding, runtimeStartContext(context)),
    close: adapter.close ? async () => await adapter.close?.() : undefined,
  };
}

function runtimeStartContext(context: ConnectPluginRuntimeStartContext) {
  return {
    agentId: context.agentId,
    chatId: context.chatId,
    sessionId: context.sessionId,
    runtimeSessionId: context.runtimeThreadId,
    onRuntimeSessionId: context.onRuntimeThreadId,
    cacheMedia: context.cacheMedia,
  };
}

export default createOpenCodeOfficialPluginEntry();
