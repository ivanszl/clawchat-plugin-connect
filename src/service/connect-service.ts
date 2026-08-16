import { resolve } from "node:path";
import { defaultConfigPath, loadConfig } from "../config";
import { createSqlitePersistenceService, type PersistenceService } from "../persistence/service";
import type { ConnectStateStore } from "../persistence/state";
import { RuntimeAdapterRegistry } from "../runtime/registry";
import type { ConnectConfig } from "../types";
import type { BindingProtocolEventHandlers } from "./binding-runtime";
import { runConnectRootLifecycle } from "./connect-root-lifecycle";
import type { ConnectSurfaceDependencies } from "./connect-surface-modules";

export interface ConnectServiceOptions {
  configPath?: string;
  config?: ConnectConfig;
  persistenceService?: PersistenceService;
  stateStore?: ConnectStateStore;
  waitUntilShutdown?: () => Promise<void>;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
  protocolEventHandlers?: BindingProtocolEventHandlers;
}

export interface ConnectServiceDependencies extends ConnectSurfaceDependencies {
  createRuntimeAdapterRegistry?: () => RuntimeAdapterRegistry;
}

export interface ConnectServiceResult {
  startedAgentIds: string[];
}

export async function startConnectService(
  options: ConnectServiceOptions = {},
  dependencies: ConnectServiceDependencies = {},
): Promise<ConnectServiceResult> {
  const configPath = resolve(options.configPath ?? defaultConfigPath());
  const config = options.config ?? (await loadConfig(configPath));
  const persistence =
    options.persistenceService ??
    (options.stateStore
      ? persistenceServiceFromStateAdapter(options.stateStore)
      : createSqlitePersistenceService({ dbPath: config.stateDbPath }));
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(message));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
  return await runConnectRootLifecycle({
    persistence,
    config,
    configPath,
    surfaceOptions: {
      protocolEventHandlers: options.protocolEventHandlers,
      writeOutput,
      writeError,
    },
    surfaceDependencies: dependencies,
    createRuntimeAdapterRegistry: dependencies.createRuntimeAdapterRegistry ?? (() => new RuntimeAdapterRegistry()),
    waitUntilShutdown: options.waitUntilShutdown ?? waitForShutdown,
    reportPluginFailure: (pluginId, error) => {
      writeError(
        `Plugin ${pluginId} activation failed; dependent Agent Bindings are unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
    reportDisposalFailure: (error) => {
      writeError(`Connect shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });
}

function persistenceServiceFromStateAdapter(state: ConnectStateStore): PersistenceService {
  return {
    state,
    initialize: async () => {
      await state.initialize();
    },
    close: async () => {
      await state.close();
    },
  };
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}
