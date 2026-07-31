import { resolve } from "node:path";
import { isAgentLivewareOperation } from "./agent-liveware";
import {
  type BindingProtocolEventHandlers,
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
import {
  createLivewareExposureDependencies,
  type LivewareExposureDependencies,
  type LivewareExposureHandle,
  resolveLivewareExecutablePath,
  retireLivewareExposure,
  startLivewareExposure,
} from "./liveware-exposure";
import { ProjectCatalog } from "./projects";
import type { RuntimeAdapterRegistry } from "./runtime/registry";
import { createReleasedRuntimeAdapterRegistry } from "./runtime/released-adapters";
import { RuntimeInteractionCoordinator } from "./runtime/runtime-interaction-coordinator";
import { verifyInstalledSkills } from "./skills";
import { type ConnectStateStore, createStateStore } from "./state";
import { getConnectTool } from "./tool-catalog";
import { isIndeterminateToolError } from "./tool-executor";
import type { ConnectConfig } from "./types";

export interface ConnectServiceOptions {
  configPath?: string;
  config?: ConnectConfig;
  stateStore?: ConnectStateStore;
  waitUntilShutdown?: () => Promise<void>;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
  protocolEventHandlers?: BindingProtocolEventHandlers;
}

export interface ConnectServiceDependencies {
  startBindingRuntime?: (options: BindingRuntimeOptions) => Promise<BindingRuntimeHandle>;
  startClientInterface?: (options: ClientInterfaceOptions) => Promise<ClientInterfaceHandle>;
  createRuntimeAdapterRegistry?: () => RuntimeAdapterRegistry;
  livewareDependencies?: LivewareExposureDependencies;
  verifyInstalledSkills?: () => Promise<void>;
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
  await (dependencies.verifyInstalledSkills ?? verifyInstalledSkills)();
  const store = options.stateStore ?? createStateStore({ dbPath: config.stateDbPath });
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(message));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
  const handles: BindingRuntimeHandle[] = [];
  const runtimeAdapters = (dependencies.createRuntimeAdapterRegistry ?? createReleasedRuntimeAdapterRegistry)();
  let clientInterface: ClientInterfaceHandle | null = null;
  let livewareExposure: LivewareExposureHandle | null = null;
  let runtimeInteractions: RuntimeInteractionCoordinator | null = null;
  let stopToolWorkers: (() => Promise<void>) | null = null;
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
    await store.expirePendingRuntimeInteractions();
    const projects = new ProjectCatalog(store);
    const transcriptProjection = new TranscriptProjection({ config, stateStore: store, runtimeAdapters });
    const interactionCoordinator = new RuntimeInteractionCoordinator(transcriptProjection);
    runtimeInteractions = interactionCoordinator;
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
          runtimeInteractions: interactionCoordinator,
          protocolEventHandlers: options.protocolEventHandlers,
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
    stopToolWorkers = startToolRequestWorkers(handles, store, writeError);
    clientInterface = await (dependencies.startClientInterface ?? startClientInterface)({
      config,
      configPath,
      stateStore: store,
      runtimeAdapters,
      transcriptProjection,
      runtimeInteractions: interactionCoordinator,
      projects,
      runtimes: handles,
    });
    writeOutput(`Connect Client is available at ${clientInterface.origin}.\n`);
    if (config.clientHost === "0.0.0.0") {
      writeOutput(
        `WARNING: Connect Client is exposed on all IPv4 interfaces without authentication; use port ${config.clientPort} only on a trusted LAN.\n`,
      );
    }
    const livewarePrincipal =
      activatedBindings.find(({ agentId }) => agentId === config.defaultAgent)?.activation ??
      activatedBindings[0]?.activation ??
      null;
    if (livewarePrincipal) {
      const existingExposure = await store.getLivewareExposure();
      if (config.livewareAccessPolicy !== "off" || existingExposure) {
        try {
          const livewareDependencies =
            dependencies.livewareDependencies ??
            createLivewareExposureDependencies({
              livewarePath: await resolveLivewareExecutablePath(),
              clawChatBaseUrl: config.baseUrl,
            });
          if (config.livewareAccessPolicy === "off") {
            const retirementPrincipal =
              activatedBindings.find(({ agentId }) => agentId === existingExposure?.localAgentId)?.activation ??
              livewarePrincipal;
            await retireLivewareExposure(
              { activation: retirementPrincipal, deviceId, stateStore: store },
              livewareDependencies,
            );
            writeOutput("Liveware Exposure is disabled and its previous App was retired.\n");
          } else {
            livewareExposure = await startLivewareExposure(
              {
                activation: livewarePrincipal,
                deviceId,
                upstream: `http://127.0.0.1:${config.clientPort}`,
                accessPolicy: config.livewareAccessPolicy,
                stateStore: store,
                writeError,
              },
              livewareDependencies,
            );
            writeOutput(
              `Liveware Exposure is available at ${livewareExposure.record.publicUrl} (${livewareExposure.record.accessPolicy}).\n`,
            );
          }
        } catch (error) {
          writeError(
            `Liveware Exposure unavailable; local Connect remains running: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }
    await (options.waitUntilShutdown ?? waitForShutdown)();
    return { startedAgentIds: handles.map((handle) => handle.agentId) };
  } finally {
    await stopToolWorkers?.();
    const shutdownFailures: unknown[] = [];
    try {
      await livewareExposure?.close();
    } catch (error) {
      shutdownFailures.push(error);
    }
    try {
      await clientInterface?.stop();
    } catch (error) {
      shutdownFailures.push(error);
    }
    try {
      await runtimeInteractions?.close();
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

function startToolRequestWorkers(
  handles: BindingRuntimeHandle[],
  store: ConnectStateStore,
  writeError: (message: string) => void,
): () => Promise<void> {
  let stopping = false;
  const workers = handles.map(async (handle) => {
    await store.markInterruptedToolRequestsIndeterminate(handle.agentId);
    while (!stopping) {
      const request = await store.claimNextToolRequest(handle.agentId);
      if (!request) {
        await Bun.sleep(100);
        continue;
      }
      const tool = getConnectTool(request.toolName);
      const timeoutMs = tool?.timeoutMs ?? (isAgentLivewareOperation(request.toolName) ? 120_000 : null);
      if (!timeoutMs || !handle.executeTool) {
        await store.settleToolRequest(request.requestId, {
          state: "failed",
          error: `unsupported tool ${request.toolName}`,
        });
        continue;
      }
      const remainingMs = Math.max(1, Math.min(timeoutMs, request.expiresAt - Date.now()));
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const result = await Promise.race([
          handle.executeTool(request.toolName, request.input),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ToolExecutionTimeout()), remainingMs);
          }),
        ]);
        await store.settleToolRequest(request.requestId, { state: "succeeded", result });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await store.settleToolRequest(request.requestId, {
          state: toolFailureState(error),
          error: detail,
        });
        writeError(`${handle.agentId}: tool ${request.toolName} failed: ${detail}\n`);
      } finally {
        if (timer) clearTimeout(timer);
        await store.pruneSettledToolRequests(handle.agentId);
      }
    }
  });
  return async () => {
    stopping = true;
    await Promise.allSettled(workers);
  };
}

export function toolFailureState(error: unknown): "failed" | "indeterminate" {
  return error instanceof ToolExecutionTimeout || isIndeterminateToolError(error) ? "indeterminate" : "failed";
}

class ToolExecutionTimeout extends Error {
  constructor() {
    super("tool execution timed out after submission; outcome is indeterminate");
  }
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}
