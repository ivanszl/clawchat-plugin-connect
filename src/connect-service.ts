import { resolve } from "node:path";
import { type BindingRuntimeHandle, type BindingRuntimeOptions, startBindingRuntime } from "./binding-runtime";
import { defaultConfigPath, loadConfig } from "./config";
import { ProjectCatalog } from "./projects";
import { createReleasedRuntimeAdapterRegistry } from "./runtime/released-adapters";
import { type ConnectStateStore, createStateStore } from "./state";
import type { ConnectConfig } from "./types";

export interface ConnectServiceOptions {
  configPath?: string;
  config?: ConnectConfig;
  stateStore?: ConnectStateStore;
  waitUntilShutdown?: () => Promise<void>;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
}

export interface ConnectServiceDependencies {
  startBindingRuntime?: (options: BindingRuntimeOptions) => Promise<BindingRuntimeHandle>;
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
  const store = options.stateStore ?? createStateStore({ dbPath: config.stateDbPath });
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(message));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
  const handles: BindingRuntimeHandle[] = [];
  try {
    const activatedBindings = (
      await Promise.all(
        Object.keys(config.agents).map(async (agentId) => ({
          agentId,
          activation: await store.getActivation(agentId),
        })),
      )
    ).filter((entry) => entry.activation !== null);
    if (activatedBindings.length === 0) {
      throw new Error(
        "no activated Agent Bindings are configured; activate at least one Binding before starting Connect",
      );
    }
    const deviceId = await store.getOrCreateDeviceId();
    const projects = new ProjectCatalog(store);
    const runtimeAdapters = createReleasedRuntimeAdapterRegistry();
    const startRuntime = dependencies.startBindingRuntime ?? startBindingRuntime;
    const attempts = await Promise.allSettled(
      activatedBindings.map(async ({ agentId, activation }) => {
        if (!activation) throw new Error(`Agent Binding ${agentId} activation disappeared`);
        return await startRuntime({
          agentId,
          activation,
          config,
          configPath,
          deviceId,
          stateStore: store,
          projects,
          runtimeAdapters,
          writeError,
        });
      }),
    );
    const failures: string[] = [];
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const agentId = activatedBindings[index]?.agentId ?? "unknown";
      if (attempt?.status === "fulfilled") {
        handles.push(attempt.value);
        writeOutput(
          `Connected Agent Binding ${agentId} to ${attempt.value.websocketUrl} as ${attempt.value.deviceId}.\n`,
        );
      } else if (attempt) {
        const detail = attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason);
        failures.push(`${agentId}: ${detail}`);
        writeError(`Failed to start Agent Binding ${agentId}: ${detail}\n`);
      }
    }
    if (handles.length === 0) {
      throw new Error(`Connect could not start any activated Agent Bindings:\n- ${failures.join("\n- ")}`);
    }
    await (options.waitUntilShutdown ?? waitForShutdown)();
    return { startedAgentIds: handles.map((handle) => handle.agentId) };
  } finally {
    await Promise.allSettled(handles.map(async (handle) => await handle.close()));
    await store.close();
  }
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}
