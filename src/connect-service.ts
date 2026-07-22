import { resolve } from "node:path";
import {
  type BindingProtocolEvent,
  type BindingRuntimeHandle,
  type BindingRuntimeOptions,
  startBindingRuntime,
} from "./binding-runtime";
import {
  type ClientInterfaceHandle,
  type ClientInterfaceOptions,
  startClientInterface,
} from "./client-interface/server";
import { TranscriptProjection } from "./client-interface/transcript-projection";
import { defaultConfigPath, loadConfig } from "./config";
import { ProjectCatalog } from "./projects";
import type { RuntimeAdapterRegistry } from "./runtime/registry";
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
  onProtocolEvent?: (event: BindingProtocolEvent) => void | Promise<void>;
}

export interface ConnectServiceDependencies {
  startBindingRuntime?: (options: BindingRuntimeOptions) => Promise<BindingRuntimeHandle>;
  startClientInterface?: (options: ClientInterfaceOptions) => Promise<ClientInterfaceHandle>;
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
  const store = options.stateStore ?? createStateStore({ dbPath: config.stateDbPath });
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(message));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
  const handles: BindingRuntimeHandle[] = [];
  const runtimeAdapters = (dependencies.createRuntimeAdapterRegistry ?? createReleasedRuntimeAdapterRegistry)();
  let clientInterface: ClientInterfaceHandle | null = null;
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
    const transcriptProjection = new TranscriptProjection({ config, stateStore: store, runtimeAdapters });
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
          transcriptProjection,
          onProtocolEvent: options.onProtocolEvent,
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
    clientInterface = await (dependencies.startClientInterface ?? startClientInterface)({
      config,
      configPath,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection,
      projects,
      runtimes: handles,
    });
    writeOutput(`Connect Client is available at ${clientInterface.origin}.\n`);
    if (config.clientHost === "0.0.0.0") {
      writeOutput(
        `WARNING: Connect Client is exposed on all IPv4 interfaces without authentication; use port ${config.clientPort} only on a trusted LAN.\n`,
      );
    }
    await (options.waitUntilShutdown ?? waitForShutdown)();
    return { startedAgentIds: handles.map((handle) => handle.agentId) };
  } finally {
    const shutdownFailures: unknown[] = [];
    try {
      await clientInterface?.stop();
    } catch (error) {
      shutdownFailures.push(error);
    }
    for (const result of await Promise.allSettled(handles.map(async (handle) => await handle.close()))) {
      if (result.status === "rejected") shutdownFailures.push(result.reason);
    }
    try {
      await runtimeAdapters.close();
    } catch (error) {
      shutdownFailures.push(error);
    }
    try {
      await store.close();
    } catch (error) {
      shutdownFailures.push(error);
    }
    for (const failure of shutdownFailures) {
      writeError(`Connect shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}\n`);
    }
  }
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}
