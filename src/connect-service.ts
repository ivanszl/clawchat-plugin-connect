import { resolve } from "node:path";
import { isAgentLivewareOperation } from "./agent-liveware";
import {
  type BindingProtocolEventHandlers,
  type BindingRuntimeHandle,
  type BindingRuntimeOptions,
  startBindingRuntime,
} from "./binding-runtime";
import {
  type BindingScopedClientGatewayHandle,
  type BindingScopedClientGatewayOptions,
  startBindingScopedClientGateway,
} from "./client-interface/binding-scoped-gateway";
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
  startBindingScopedClientGateway?: (
    options: BindingScopedClientGatewayOptions,
  ) => Promise<BindingScopedClientGatewayHandle>;
  startLivewareExposure?: typeof startLivewareExposure;
  retireLivewareExposure?: typeof retireLivewareExposure;
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
  const livewareExposures: LivewareExposureHandle[] = [];
  const bindingScopedGateways: BindingScopedClientGatewayHandle[] = [];
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
    const existingExposures = await store.listLivewareExposures();
    if (config.livewareAccessPolicy !== "off" || existingExposures.length > 0) {
      let livewareDependencies = dependencies.livewareDependencies;
      if (!livewareDependencies) {
        try {
          livewareDependencies = createLivewareExposureDependencies({
            livewarePath: await resolveLivewareExecutablePath(),
            clawChatBaseUrl: config.baseUrl,
          });
        } catch (error) {
          writeError(
            `Liveware Exposure unavailable; local Connect remains running: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      if (!livewareDependencies) {
        await (options.waitUntilShutdown ?? waitForShutdown)();
        return { startedAgentIds: handles.map((handle) => handle.agentId) };
      }
      if (config.livewareAccessPolicy === "off") {
        for (const existingExposure of existingExposures) {
          const retirementPrincipal = activatedBindings.find(
            ({ agentId }) => agentId === existingExposure.localAgentId,
          )?.activation;
          if (!retirementPrincipal) {
            writeError(
              `${existingExposure.localAgentId}: Liveware Exposure cannot be retired because its activation is missing.\n`,
            );
            continue;
          }
          try {
            await (dependencies.retireLivewareExposure ?? retireLivewareExposure)(
              { activation: retirementPrincipal, deviceId, stateStore: store },
              livewareDependencies,
            );
            writeOutput(`${existingExposure.localAgentId}: Liveware Exposure was retired.\n`);
          } catch (error) {
            writeError(
              `${existingExposure.localAgentId}: Liveware Exposure retirement failed; local Connect remains running: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
      } else {
        for (const { agentId, activation } of activatedBindings) {
          if (!activation) continue;
          let gateway: BindingScopedClientGatewayHandle | null = null;
          try {
            gateway = await (dependencies.startBindingScopedClientGateway ?? startBindingScopedClientGateway)({
              bindingId: agentId,
              upstreamOrigin: clientInterface.origin,
            });
            const exposure = await (dependencies.startLivewareExposure ?? startLivewareExposure)(
              {
                activation,
                deviceId,
                upstream: gateway.origin,
                accessPolicy: config.livewareAccessPolicy,
                stateStore: store,
                writeError,
              },
              livewareDependencies,
            );
            bindingScopedGateways.push(gateway);
            livewareExposures.push(exposure);
            writeOutput(
              `${agentId}: Liveware Exposure is available at ${exposure.record.publicUrl} (${exposure.record.accessPolicy}).\n`,
            );
          } catch (error) {
            await gateway?.stop().catch(() => undefined);
            writeError(
              `${agentId}: Liveware Exposure unavailable; local Connect remains running: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
      }
    }
    await (options.waitUntilShutdown ?? waitForShutdown)();
    return { startedAgentIds: handles.map((handle) => handle.agentId) };
  } finally {
    await stopToolWorkers?.();
    const shutdownFailures: unknown[] = [];
    for (const result of await Promise.allSettled(livewareExposures.map(async (exposure) => await exposure.close()))) {
      if (result.status === "rejected") shutdownFailures.push(result.reason);
    }
    for (const result of await Promise.allSettled(bindingScopedGateways.map(async (gateway) => await gateway.stop()))) {
      if (result.status === "rejected") shutdownFailures.push(result.reason);
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
