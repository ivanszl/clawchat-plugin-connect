import {
  createOpenCodeRuntimeAdapter,
  type OpenCodeRuntimeAdapter,
  type OpenCodeRuntimeAdapterBinding,
  type OpenCodeRuntimeAdapterOptions,
} from "../../runtime/opencode-adapter";
import { canonicalExecutableIdentity } from "../../runtime/executable-identity";
import { startOpenCodeWebApp } from "../../runtime/opencode-web-process";
import type {
  ConnectPluginConfiguration,
  ConnectPluginEntry,
  ConnectPluginManagedWebAppInstanceContext,
  ConnectPluginManagedWebAppProvider,
  ConnectPluginRuntimeAdapter,
  ConnectPluginRuntimeStartContext,
} from "../sdk";
import { type CompatibleOpenCodeExecutable, requireCompatibleOpenCodeExecutable } from "./opencode-compatibility";
import {
  OPENCODE_OFFICIAL_CAPABILITY_ID,
  OPENCODE_OFFICIAL_PLUGIN_ID,
  OPENCODE_OFFICIAL_RUNTIME_FAMILY,
  OPENCODE_WEB_APP_CAPABILITY_ID,
} from "./opencode-manifest";

interface OpenCodeInstallationConfiguration {
  executablePath?: string;
}

export interface OpenCodeOfficialPluginEntryOptions {
  runtimeAdapter?: OpenCodeRuntimeAdapterOptions;
  startWebApp?: typeof startOpenCodeWebApp;
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
            undefined,
          );
          return bridgeOpenCodeAdapter(createOpenCodeRuntimeAdapter(options.runtimeAdapter), {
            ...binding,
            executablePathOverride: executable.path,
          });
        },
      });
      context.hostCapabilities
        .get("managed-web-app-provider")
        .register(
          openCodeWebProvider(
            installation,
            options.requireExecutable ?? requireCompatibleOpenCodeExecutable,
            options.startWebApp ?? startOpenCodeWebApp,
          ),
        );
    },
  };
}

interface OpenCodeWebScope {
  readonly key: string;
  readonly executable: CompatibleOpenCodeExecutable;
}

function openCodeWebProvider(
  installation: OpenCodeInstallationConfiguration,
  requireExecutable: (
    configuredPath: string | undefined,
    env: Readonly<Record<string, string>> | undefined,
  ) => CompatibleOpenCodeExecutable,
  startWebApp: typeof startOpenCodeWebApp,
): ConnectPluginManagedWebAppProvider {
  return {
    capabilityId: OPENCODE_WEB_APP_CAPABILITY_ID,
    instanceKey(context) {
      return openCodeWebScope(installation, context, requireExecutable).key;
    },
    async acquire(context) {
      const scope = openCodeWebScope(installation, context, requireExecutable);
      if (scope.key !== context.instanceKey) {
        throw new Error("OpenCode Web executable or Web configuration changed during acquisition");
      }
      return await startWebApp({ executable: scope.executable });
    },
  };
}

function openCodeWebScope(
  installation: OpenCodeInstallationConfiguration,
  context: ConnectPluginManagedWebAppInstanceContext,
  requireExecutable: (
    configuredPath: string | undefined,
    env: Readonly<Record<string, string>> | undefined,
  ) => CompatibleOpenCodeExecutable,
): OpenCodeWebScope {
  const runtime = context.runtimeConfiguration as Partial<OpenCodeRuntimeAdapterBinding>;
  const compatible = requireExecutable(runtime.executablePathOverride ?? installation.executablePath, undefined);
  const executable = canonicalExecutableIdentity(compatible.path, "OpenCode");
  return {
    key: JSON.stringify({
      executable: executable.identity,
      version: compatible.version,
      web: { hostname: "127.0.0.1", port: 0, mdns: false },
    }),
    executable: { path: executable.path, version: compatible.version },
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
      ? async (workspace, options) => (await adapter.listSkills?.(binding, workspace, options)) ?? []
      : undefined,
    onSkillsChanged: adapter.onSkillsChanged?.bind(adapter),
    listCommands: adapter.listCommands
      ? async (workspace, options) => (await adapter.listCommands?.(binding, workspace, options)) ?? []
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
    agentId: context.bindingId,
    chatId: context.chatId,
    sessionId: context.sessionId,
    runtimeSessionId: context.runtimeThreadId,
    onRuntimeSessionId: context.onRuntimeThreadId,
    cacheMedia: context.cacheMedia,
  };
}

export default createOpenCodeOfficialPluginEntry();
