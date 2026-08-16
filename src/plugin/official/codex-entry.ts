import {
  createCodexRuntimeAdapter,
  type CodexRuntimeAdapterBinding,
} from "../../runtime/codex-adapter";
import type { ConnectRuntimeAdapter, ConnectRuntimeStartContext } from "../../runtime/types";
import type {
  ConnectPluginConfiguration,
  ConnectPluginEntry,
  ConnectPluginRuntimeAdapter,
  ConnectPluginRuntimeStartContext,
} from "../sdk";
import { requireCompatibleCodexExecutable } from "./codex-compatibility";
import { CODEX_CAPABILITY_ID, CODEX_PLUGIN_ID, CODEX_RUNTIME_FAMILY } from "./codex-manifest";

const codexPluginEntry: ConnectPluginEntry = {
  activate(context) {
    const installationExecutable = optionalString(context.installationConfiguration.executablePath);
    const installed = requireCompatibleCodexExecutable(installationExecutable, undefined);
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: CODEX_CAPABILITY_ID,
      family: CODEX_RUNTIME_FAMILY,
      create(configuration) {
        const binding = codexBinding(configuration, installed.path);
        const configuredExecutable = binding.executablePathOverride ?? binding.codexPathOverride;
        const compatible = requireCompatibleCodexExecutable(configuredExecutable, binding.env);
        binding.executablePathOverride = compatible.path;
        delete binding.codexPathOverride;
        return bindCodexAdapter(createCodexRuntimeAdapter(), binding);
      },
    });
  },
};

export default codexPluginEntry;

function codexBinding(
  configuration: ConnectPluginConfiguration,
  installationExecutable: string,
): CodexRuntimeAdapterBinding {
  const executablePathOverride = optionalString(configuration.executablePathOverride);
  const codexPathOverride = optionalString(configuration.codexPathOverride);
  const env = stringRecord(configuration.env);
  const additionalDirectories = stringArray(configuration.additionalDirectories);
  const sessionOptions = stringRecord(configuration.sessionOptions);
  return {
    runtime: { pluginId: CODEX_PLUGIN_ID, capabilityId: CODEX_CAPABILITY_ID },
    runtimeConfig: structuredClone(configuration) as Record<string, unknown>,
    ...(executablePathOverride
      ? { executablePathOverride }
      : codexPathOverride
        ? { codexPathOverride }
        : { executablePathOverride: installationExecutable }),
    ...(env ? { env } : {}),
    ...(optionalString(configuration.displayName) ? { displayName: optionalString(configuration.displayName) } : {}),
    ...(optionalString(configuration.model) ? { model: optionalString(configuration.model) } : {}),
    ...(optionalString(configuration.sandboxMode)
      ? {
          sandboxMode: optionalString(configuration.sandboxMode) as NonNullable<CodexRuntimeAdapterBinding["sandboxMode"]>,
        }
      : {}),
    ...(optionalString(configuration.modelReasoningEffort)
      ? {
          modelReasoningEffort: optionalString(configuration.modelReasoningEffort) as NonNullable<
            CodexRuntimeAdapterBinding["modelReasoningEffort"]
          >,
        }
      : {}),
    approvalPolicy:
      (optionalString(configuration.approvalPolicy) as CodexRuntimeAdapterBinding["approvalPolicy"]) ?? "on-request",
    ...(optionalString(configuration.webSearchMode)
      ? {
          webSearchMode: optionalString(configuration.webSearchMode) as NonNullable<
            CodexRuntimeAdapterBinding["webSearchMode"]
          >,
        }
      : {}),
    ...(typeof configuration.networkAccessEnabled === "boolean"
      ? { networkAccessEnabled: configuration.networkAccessEnabled }
      : {}),
    ...(additionalDirectories ? { additionalDirectories } : {}),
    ...(optionalString(configuration.outputVisibility)
      ? {
          outputVisibility: optionalString(configuration.outputVisibility) as NonNullable<
            CodexRuntimeAdapterBinding["outputVisibility"]
          >,
        }
      : {}),
    ...(sessionOptions ? { sessionOptions } : {}),
  };
}

function bindCodexAdapter(
  adapter: ConnectRuntimeAdapter,
  binding: CodexRuntimeAdapterBinding,
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
          const activity = await adapter.readActivity?.(binding, runtimeThreadId);
          if (!activity) throw new Error("Codex Runtime Adapter returned no Runtime Activity");
          return activity;
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
    start: async (context) => {
      const session = await adapter.start(binding, internalStartContext(context));
      return {
        prompt: (input) =>
          session.prompt({
            ...input,
            model: input.model ?? binding.model,
            reasoningEffort: input.reasoningEffort ?? binding.modelReasoningEffort,
          }),
        cancel: session.cancel?.bind(session),
        close: session.close.bind(session),
      };
    },
    close: adapter.close ? async () => await adapter.close?.() : undefined,
  };
}

function internalStartContext(context: ConnectPluginRuntimeStartContext): ConnectRuntimeStartContext {
  return {
    agentId: context.agentId,
    chatId: context.chatId,
    sessionId: context.sessionId,
    runtimeSessionId: context.runtimeThreadId,
    onRuntimeSessionId: context.onRuntimeThreadId,
    cacheMedia: context.cacheMedia,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}
