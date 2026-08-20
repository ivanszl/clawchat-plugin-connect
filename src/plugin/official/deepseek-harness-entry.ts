import { fileURLToPath } from "node:url";
import {
  createDeepSeekHarnessRuntimeAdapter,
  type DeepSeekHarnessRuntimeAdapter,
  type DeepSeekHarnessRuntimeAdapterBinding,
  type DeepSeekHarnessRuntimeAdapterOptions,
} from "../../runtime/deepseek-harness-adapter";
import { CONNECT_VERSION } from "../../service/version";
import type {
  ConnectPluginConfiguration,
  ConnectPluginEntry,
  ConnectPluginRuntimeAdapter,
  ConnectPluginRuntimeStartContext,
} from "../sdk";
import {
  DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
  DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
  DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY,
} from "./deepseek-harness-manifest";

interface DeepSeekHarnessInstallationConfiguration {
  executablePath?: string;
}

export interface DeepSeekHarnessOfficialPluginEntryOptions {
  runtimeAdapter?: Partial<DeepSeekHarnessRuntimeAdapterOptions>;
  createAdapter?: (options: DeepSeekHarnessRuntimeAdapterOptions) => DeepSeekHarnessRuntimeAdapter;
}

export function createDeepSeekHarnessOfficialPluginEntry(
  options: DeepSeekHarnessOfficialPluginEntryOptions = {},
): ConnectPluginEntry {
  return {
    activate(context) {
      const installation = context.installationConfiguration as DeepSeekHarnessInstallationConfiguration;
      context.hostCapabilities.get("runtime-provider").register({
        capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
        family: DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY,
        create(configuration) {
          const binding = deepSeekHarnessBinding(installation, configuration);
          const adapterOptions: DeepSeekHarnessRuntimeAdapterOptions = {
            bridgePath:
              options.runtimeAdapter?.bridgePath ??
              fileURLToPath(new URL("./deepseek-harness-bridge.mjs", import.meta.url)),
            bridgeBuild: options.runtimeAdapter?.bridgeBuild ?? CONNECT_VERSION,
            ...(options.runtimeAdapter?.createBridge ? { createBridge: options.runtimeAdapter.createBridge } : {}),
            ...(options.runtimeAdapter?.probeExecutable
              ? { probeExecutable: options.runtimeAdapter.probeExecutable }
              : {}),
          };
          const adapter = (options.createAdapter ?? createDeepSeekHarnessRuntimeAdapter)(adapterOptions);
          return bridgeDeepSeekHarnessAdapter(adapter, binding);
        },
      });
    },
  };
}

function deepSeekHarnessBinding(
  installation: DeepSeekHarnessInstallationConfiguration,
  configuration: ConnectPluginConfiguration,
): DeepSeekHarnessRuntimeAdapterBinding {
  const binding = structuredClone(configuration) as Omit<
    DeepSeekHarnessRuntimeAdapterBinding,
    "runtime" | "runtimeConfig"
  >;
  return {
    runtime: {
      pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
    },
    runtimeConfig: structuredClone(configuration) as Record<string, unknown>,
    ...(installation.executablePath && !binding.executablePathOverride
      ? { executablePathOverride: installation.executablePath }
      : {}),
    ...binding,
  };
}

function bridgeDeepSeekHarnessAdapter(
  adapter: DeepSeekHarnessRuntimeAdapter,
  binding: DeepSeekHarnessRuntimeAdapterBinding,
): ConnectPluginRuntimeAdapter {
  const discoverThreads = adapter.discoverThreads?.bind(adapter);
  const discoverAllThreads = adapter.discoverAllThreads?.bind(adapter);
  const discoverArchivedThreads = adapter.discoverArchivedThreads?.bind(adapter);
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
      ? async (workspace, catalogOptions) => (await adapter.listSkills?.(binding, workspace, catalogOptions)) ?? []
      : undefined,
    onSkillsChanged: adapter.onSkillsChanged?.bind(adapter),
    listCommands: adapter.listCommands
      ? async (workspace, catalogOptions) => (await adapter.listCommands?.(binding, workspace, catalogOptions)) ?? []
      : undefined,
    onCommandsChanged: adapter.onCommandsChanged?.bind(adapter),
    onCatalogsChanged: adapter.onCatalogsChanged?.bind(adapter),
    discoverThreads: discoverThreads ? async (workspace) => await discoverThreads(binding, workspace) : undefined,
    discoverAllThreads: discoverAllThreads ? async () => await discoverAllThreads(binding) : undefined,
    discoverArchivedThreads: discoverArchivedThreads ? async () => await discoverArchivedThreads(binding) : undefined,
    verifyThreadReady: adapter.verifyThreadReady
      ? async (runtimeThreadId) => await adapter.verifyThreadReady?.(binding, runtimeThreadId)
      : undefined,
    readActivity: adapter.readActivity
      ? async (runtimeThreadId) => {
          const snapshot = await adapter.readActivity?.(binding, runtimeThreadId);
          if (!snapshot) throw new Error("DeepSeek Harness Runtime Adapter returned no Activity");
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
    start: async (context) => await adapter.start(binding, runtimeStartContext(context)),
    close: adapter.close ? async () => await adapter.close?.() : undefined,
  };
}

function runtimeStartContext(context: ConnectPluginRuntimeStartContext) {
  return {
    agentId: context.bindingId,
    chatId: context.chatId,
    sessionId: context.sessionId,
    runtimeSessionId: context.runtimeThreadId,
    onRuntimeSessionId: context.onRuntimeThreadId,
    cacheMedia: context.cacheMedia,
  };
}

export default createDeepSeekHarnessOfficialPluginEntry();
