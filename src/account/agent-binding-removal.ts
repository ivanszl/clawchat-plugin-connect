import { resolve } from "node:path";
import { FileTurnSubmissionStaging } from "../client-interface/turn-submission-staging";
import { defaultConfigPath, loadConfig, saveConfig } from "../config";
import { type ConnectStateStore, createStateStore } from "../persistence/state";
import { retireOfficialLivewarePublications } from "../plugin/official/liveware-retirement";
import { manageBackgroundService } from "../service/background-service";
import { CORE_BINDING_RETIRE_PATH, CORE_CONTROL_CONFIG_HEADER, CORE_CONTROL_ORIGIN } from "../service/core-control";
import { WorkspaceCatalog } from "../workspaces/workspaces";

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
  retireRunningBindings?: (bindingIds: readonly string[], configPath: string) => Promise<void>;
  retireLivewarePublications?: (bindingIds: readonly string[]) => Promise<void>;
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
  const serviceRunning = await (
    dependencies.getServiceStatus ??
    (async (path: string) => await manageBackgroundService({ action: "status", configPath: path }))
  )(configPath);
  try {
    if (serviceRunning.running) {
      await (dependencies.retireRunningBindings ?? retireRunningAgentBindings)([agentId], configPath);
    } else {
      await (
        dependencies.retireLivewarePublications ??
        (async (bindingIds: readonly string[]) =>
          await retireOfficialLivewarePublications({
            bindingIds,
            configPath,
            clawChatBaseUrl: config.baseUrl,
            stateStore: store,
          }))
      )([agentId]);
    }
    const sessionRefs = (await store.listAllRuntimeSessions())
      .filter((session) => session.agentId === agentId)
      .map((session) => session.sessionRef);
    await new FileTurnSubmissionStaging(config.stateDbPath).purgeSessions(sessionRefs);
    await new WorkspaceCatalog(store).purgeBindingCatalog(agentId);
    await store.purgeAgentBinding(agentId);
    delete config.agents[agentId];
    if (config.defaultAgent === agentId) config.defaultAgent = Object.keys(config.agents)[0] ?? null;
    return { agentId, configPath: await saveConfig(config, configPath) };
  } finally {
    if (ownsStore) await store.close();
  }
}

async function retireRunningAgentBindings(bindingIds: readonly string[], configPath: string): Promise<void> {
  const response = await fetch(`${CORE_CONTROL_ORIGIN}${CORE_BINDING_RETIRE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [CORE_CONTROL_CONFIG_HEADER]: configPath,
    },
    body: JSON.stringify({ bindingIds }),
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  const detail = typeof body?.error?.message === "string" ? `: ${body.error.message}` : "";
  throw new Error(`Running Agent Binding retirement failed with HTTP ${response.status}${detail}`);
}
