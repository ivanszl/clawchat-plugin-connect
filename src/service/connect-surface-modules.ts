import type { Context, Plugin } from "cordis";
import { isAgentLivewareOperation } from "../agent/agent-liveware";
import { verifyInstalledSkills } from "../agent/skills";
import { getConnectTool } from "../agent/tool-catalog";
import { isIndeterminateToolError } from "../agent/tool-executor";
import {
  type BindingScopedClientGatewayHandle,
  type BindingScopedClientGatewayOptions,
  startBindingScopedClientGateway,
} from "../client-interface/binding-scoped-gateway";
import { resolveClientAssetsPath } from "../client-interface/client-assets";
import {
  type ClientInterfaceHandle,
  type ClientInterfaceOptions,
  startClientInterface,
} from "../client-interface/server";
import type { ConnectStateStore } from "../persistence/state";
import type { ToolRequestRecord } from "../persistence/state-types";
import type { ConnectExecutionCapabilities } from "../runtime/execution-capabilities";
import { ClawChatTurnSurface, ClientTurnSurface, type ConnectTurnSurfaceCapabilities } from "../runtime/turn-surface";
import type { ConnectConfig } from "../types";
import {
  type BindingProtocolEventHandlers,
  type BindingRuntimeHandle,
  type BindingRuntimeOptions,
  startBindingRuntime,
} from "./binding-runtime";
import type { ActivatedAgentBinding } from "./connect-durable-modules";
import {
  createLivewareExposureDependencies,
  type LivewareExposureDependencies,
  type LivewareExposureHandle,
  resolveLivewareExecutablePath,
  retireLivewareExposure,
  startLivewareExposure,
} from "./liveware-exposure";

interface ClawChatTransportModule {
  readonly activatedBindings: ActivatedAgentBinding[];
  readonly deviceId: string;
  readonly handles: BindingRuntimeHandle[];
}

interface ClientAssetsModule {
  readonly path: string;
}

interface ToolRequestWorkerModule {
  readonly active: true;
}

declare module "cordis" {
  interface Context {
    connectTurnSurfaces: ConnectTurnSurfaceCapabilities;
    connectClawChatTransports: ClawChatTransportModule;
    connectClientAssets: ClientAssetsModule;
    connectClientInterface: ClientInterfaceHandle;
    connectToolRequestWorkers: ToolRequestWorkerModule;
  }
}

export interface ConnectSurfaceOptions {
  config: ConnectConfig;
  configPath: string;
  protocolEventHandlers?: BindingProtocolEventHandlers;
  writeOutput(message: string): void;
  writeError(message: string): void;
}

export interface ConnectSurfaceDependencies {
  startBindingRuntime?: (options: BindingRuntimeOptions) => Promise<BindingRuntimeHandle>;
  startClientInterface?: (options: ClientInterfaceOptions) => Promise<ClientInterfaceHandle>;
  resolveClientAssetsPath?: () => Promise<string>;
  livewareDependencies?: LivewareExposureDependencies;
  startBindingScopedClientGateway?: (
    options: BindingScopedClientGatewayOptions,
  ) => Promise<BindingScopedClientGatewayHandle>;
  startLivewareExposure?: typeof startLivewareExposure;
  retireLivewareExposure?: typeof retireLivewareExposure;
  verifyInstalledSkills?: () => Promise<void>;
}

export interface ConnectSurfaceResult {
  startedAgentIds: string[];
}

export interface MountedConnectSurfaceModules {
  readonly result: ConnectSurfaceResult;
  dispose(): Promise<void>;
}

export async function mountMandatorySurfaceModules(
  root: Context,
  options: ConnectSurfaceOptions,
  dependencies: ConnectSurfaceDependencies,
  reportDisposalFailure: (error: unknown) => void,
): Promise<MountedConnectSurfaceModules> {
  const disposers = new Map<string, () => Promise<void>>();
  const mount = async (plugin: Plugin & { name: string }): Promise<void> => {
    const fiber = root.plugin(plugin);
    await fiber;
    disposers.set(plugin.name, fiber.dispose);
  };
  const dispose = async (): Promise<void> => {
    const order = [
      "connect-tool-request-workers",
      "connect-liveware-publication",
      "connect-client-interface",
      "connect-clawchat-transports",
      "connect-client-assets",
      "connect-turn-surfaces",
    ];
    for (const name of order) {
      const disposer = disposers.get(name);
      if (!disposer) continue;
      try {
        await disposer();
      } catch (error) {
        reportDisposalFailure(error);
      }
      disposers.delete(name);
    }
  };

  const turnSurfacePlugin = {
    name: "connect-turn-surfaces",
    inject: ["connectSessionTurnExecutor", "connectTranscriptProjection", "connectRuntimeInteractions"],
    provide: "connectTurnSurfaces",
    apply: (ctx) => {
      const turnSurfaces: ConnectTurnSurfaceCapabilities = {
        createClawChat: ({ sessionRef, ...surfaceOptions }) =>
          new ClawChatTurnSurface({
            ...surfaceOptions,
            project: async (event) => {
              await ctx.connectTranscriptProjection.upsertRuntimeActivity(sessionRef, event);
            },
          }),
        createClient: ({ sessionRef }) =>
          new ClientTurnSurface({
            project: async (event) => {
              await ctx.connectTranscriptProjection.upsertRuntimeActivity(sessionRef, event);
            },
          }),
      };
      ctx.provide("connectTurnSurfaces", turnSurfaces);
    },
  } satisfies Plugin;

  const clientAssetsPlugin = {
    name: "connect-client-assets",
    provide: "connectClientAssets",
    apply: async (ctx) => {
      const assets = {
        path: await (dependencies.resolveClientAssetsPath ?? resolveClientAssetsPath)(),
      };
      ctx.provide("connectClientAssets", assets);
    },
  } satisfies Plugin;

  const clawChatTransportPlugin = {
    name: "connect-clawchat-transports",
    inject: [
      "connectPersistence",
      "connectAgentBindings",
      "connectProjects",
      "connectSessionContinuity",
      "connectRuntimeAdapters",
      "connectSessionQueue",
      "connectSessionTurnExecutor",
      "connectTranscriptProjection",
      "connectRuntimeInteractions",
      "connectTurnSurfaces",
    ],
    provide: "connectClawChatTransports",
    apply: async (ctx) => {
      await (dependencies.verifyInstalledSkills ?? verifyInstalledSkills)();
      const { activatedBindings, deviceId } = await ctx.connectAgentBindings.prepareService(options.config);
      await ctx.connectPersistence.stateStore.expirePendingRuntimeInteractions();
      const handles: BindingRuntimeHandle[] = [];
      const startRuntime = dependencies.startBindingRuntime ?? startBindingRuntime;
      const execution: ConnectExecutionCapabilities = {
        runtimeAdapters: ctx.connectRuntimeAdapters,
        transcriptProjection: ctx.connectTranscriptProjection,
        runtimeInteractions: ctx.connectRuntimeInteractions,
        createSessionQueue: (bindingId, queueOptions) => ctx.connectSessionQueue.create(bindingId, queueOptions),
        createSessionTurnExecutor: (executorOptions) => ctx.connectSessionTurnExecutor.create(executorOptions),
        quiesceBindings: async (bindingIds, criticalSection) =>
          await ctx.connectSessionQueue.quiesceBindings(
            bindingIds,
            async () => await ctx.connectSessionTurnExecutor.releaseBindings(bindingIds),
            criticalSection,
          ),
      };
      try {
        for (const { agentId, activation } of activatedBindings) {
          try {
            const handle = await startRuntime({
              agentId,
              activation,
              config: options.config,
              configPath: options.configPath,
              deviceId,
              stateStore: ctx.connectPersistence.stateStore,
              projects: ctx.connectProjects,
              sessionContinuityModule: ctx.connectSessionContinuity,
              execution,
              turnSurfaces: ctx.connectTurnSurfaces,
              protocolEventHandlers: options.protocolEventHandlers,
              writeError: options.writeError,
            });
            handles.push(handle);
            await ctx.connectAgentBindings.setRuntimeAvailability(agentId, "available", null).catch(() => undefined);
            options.writeOutput(
              `Connected Agent Binding ${agentId} to ${handle.websocketUrl} as ${handle.deviceId}.\n`,
            );
          } catch (reason) {
            const detail = reason instanceof Error ? reason.message : String(reason);
            await ctx.connectAgentBindings
              .setRuntimeAvailability(agentId, "startup-unavailable", detail)
              .catch(() => undefined);
            options.writeError(`Failed to start Agent Binding ${agentId}: ${detail}\n`);
          }
        }
        if (handles.length === 0) {
          options.writeError(
            "Connect started with no usable Agent Bindings; unavailable runtimes will remain disconnected.\n",
          );
        }
        const transports = { activatedBindings, deviceId, handles };
        ctx.provide("connectClawChatTransports", transports);
        return async () => {
          const results = await Promise.allSettled(handles.map(async (handle) => await handle.close()));
          for (const result of results) {
            if (result.status === "rejected") reportDisposalFailure(result.reason);
          }
        };
      } catch (error) {
        await Promise.allSettled(handles.map(async (handle) => await handle.close()));
        throw error;
      }
    },
  } satisfies Plugin;

  const toolRequestWorkerPlugin = {
    name: "connect-tool-request-workers",
    inject: ["connectPersistence", "connectClawChatTransports"],
    provide: "connectToolRequestWorkers",
    apply: (ctx) => {
      const stop = startToolRequestWorkers(
        ctx.connectClawChatTransports.handles,
        ctx.connectPersistence.stateStore,
        options.writeError,
      );
      ctx.provide("connectToolRequestWorkers", { active: true });
      return async () => {
        try {
          await stop();
        } catch (error) {
          reportDisposalFailure(error);
        }
      };
    },
  } satisfies Plugin;

  const clientInterfacePlugin = {
    name: "connect-client-interface",
    inject: [
      "connectPersistence",
      "connectProjects",
      "connectSessionContinuity",
      "connectRuntimeAdapters",
      "connectTranscriptProjection",
      "connectRuntimeInteractions",
      "connectClawChatTransports",
      "connectTurnSurfaces",
      "connectClientAssets",
      "connectPluginHost",
    ],
    provide: "connectClientInterface",
    apply: async (ctx) => {
      const clientInterface = await (dependencies.startClientInterface ?? startClientInterface)({
        config: options.config,
        configPath: options.configPath,
        stateStore: ctx.connectPersistence.stateStore,
        runtimeAdapters: ctx.connectRuntimeAdapters,
        transcriptProjection: ctx.connectTranscriptProjection,
        runtimeInteractions: ctx.connectRuntimeInteractions,
        projects: ctx.connectProjects,
        sessionContinuityModule: ctx.connectSessionContinuity,
        pluginManager: ctx.connectPluginHost,
        runtimes: ctx.connectClawChatTransports.handles,
        assetsPath: ctx.connectClientAssets.path,
      });
      ctx.provide("connectClientInterface", clientInterface);
      options.writeOutput(`Connect Client is available at ${clientInterface.origin}.\n`);
      if (options.config.clientHost === "0.0.0.0") {
        options.writeOutput(
          `WARNING: Connect Client is exposed on all IPv4 interfaces without authentication; use port ${options.config.clientPort} only on a trusted LAN.\n`,
        );
      }
      return async () => {
        try {
          await clientInterface.stop();
        } catch (error) {
          reportDisposalFailure(error);
        }
      };
    },
  } satisfies Plugin;

  const livewarePublicationPlugin = {
    name: "connect-liveware-publication",
    inject: ["connectPersistence", "connectClawChatTransports", "connectClientInterface"],
    apply: async (ctx) => {
      const store = ctx.connectPersistence.stateStore;
      const { activatedBindings, deviceId, handles } = ctx.connectClawChatTransports;
      const exposures: LivewareExposureHandle[] = [];
      const gateways: BindingScopedClientGatewayHandle[] = [];
      const existingExposures = await store.listLivewareExposures();
      if (options.config.livewareAccessPolicy !== "off" || existingExposures.length > 0) {
        let livewareDependencies = dependencies.livewareDependencies;
        if (!livewareDependencies) {
          try {
            livewareDependencies = createLivewareExposureDependencies({
              livewarePath: await resolveLivewareExecutablePath(),
              clawChatBaseUrl: options.config.baseUrl,
            });
          } catch (error) {
            options.writeError(
              `Liveware Exposure unavailable; local Connect remains running: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
        if (livewareDependencies) {
          if (options.config.livewareAccessPolicy === "off") {
            for (const existingExposure of existingExposures) {
              const retirementPrincipal = activatedBindings.find(
                ({ agentId }) => agentId === existingExposure.localAgentId,
              )?.activation;
              if (!retirementPrincipal) {
                options.writeError(
                  `${existingExposure.localAgentId}: Liveware Exposure cannot be retired because its activation is missing.\n`,
                );
                continue;
              }
              try {
                await (dependencies.retireLivewareExposure ?? retireLivewareExposure)(
                  { activation: retirementPrincipal, deviceId, stateStore: store },
                  livewareDependencies,
                );
                options.writeOutput(`${existingExposure.localAgentId}: Liveware Exposure was retired.\n`);
              } catch (error) {
                options.writeError(
                  `${existingExposure.localAgentId}: Liveware Exposure retirement failed; local Connect remains running: ${error instanceof Error ? error.message : String(error)}\n`,
                );
              }
            }
          } else {
            for (const { agentId, activation } of activatedBindings.filter(({ agentId }) =>
              handles.some((handle) => handle.agentId === agentId),
            )) {
              let gateway: BindingScopedClientGatewayHandle | null = null;
              try {
                gateway = await (dependencies.startBindingScopedClientGateway ?? startBindingScopedClientGateway)({
                  bindingId: agentId,
                  upstreamOrigin: ctx.connectClientInterface.origin,
                });
                const exposure = await (dependencies.startLivewareExposure ?? startLivewareExposure)(
                  {
                    activation,
                    deviceId,
                    upstream: gateway.origin,
                    accessPolicy: options.config.livewareAccessPolicy,
                    stateStore: store,
                    writeError: options.writeError,
                  },
                  livewareDependencies,
                );
                gateways.push(gateway);
                exposures.push(exposure);
                options.writeOutput(
                  `${agentId}: Liveware Exposure is available at ${exposure.record.publicUrl} (${exposure.record.accessPolicy}).\n`,
                );
              } catch (error) {
                await gateway?.stop().catch(() => undefined);
                options.writeError(
                  `${agentId}: Liveware Exposure unavailable; local Connect remains running: ${error instanceof Error ? error.message : String(error)}\n`,
                );
              }
            }
          }
        }
      }
      return async () => {
        for (const result of await Promise.allSettled(exposures.map(async (exposure) => await exposure.close()))) {
          if (result.status === "rejected") reportDisposalFailure(result.reason);
        }
        for (const result of await Promise.allSettled(gateways.map(async (gateway) => await gateway.stop()))) {
          if (result.status === "rejected") reportDisposalFailure(result.reason);
        }
      };
    },
  } satisfies Plugin;

  try {
    await mount(turnSurfacePlugin);
    await mount(clientAssetsPlugin);
    await mount(clawChatTransportPlugin);
    await mount(toolRequestWorkerPlugin);
    await mount(clientInterfacePlugin);
    await mount(livewarePublicationPlugin);
    return {
      result: {
        startedAgentIds: root.connectClawChatTransports.handles.map((handle) => handle.agentId),
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function startToolRequestWorkers(
  handles: BindingRuntimeHandle[],
  store: ConnectStateStore,
  writeError: (message: string) => void,
): () => Promise<void> {
  let stopping = false;
  const workers = handles.map(async (handle) => {
    while (!stopping) {
      try {
        await store.markInterruptedToolRequestsIndeterminate(handle.agentId);
        break;
      } catch (error) {
        writeError(
          `${handle.agentId}: Tool Request worker recovery failed; retrying: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        await Bun.sleep(100);
      }
    }
    while (!stopping) {
      let request: ToolRequestRecord | null = null;
      try {
        request = await store.claimNextToolRequest(handle.agentId);
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
        let timer: Timer | undefined;
        let outcome: { state: "succeeded"; result: unknown } | { state: "failed" | "indeterminate"; error: string };
        try {
          const result = await Promise.race([
            handle.executeTool(request.toolName, request.input),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new ToolExecutionTimeout()), remainingMs);
            }),
          ]);
          outcome = { state: "succeeded", result };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          outcome = { state: toolFailureState(error), error: detail };
          writeError(`${handle.agentId}: tool ${request.toolName} failed: ${detail}\n`);
        } finally {
          clearTimeout(timer);
        }
        await store.settleToolRequest(request.requestId, outcome);
        await store.pruneSettledToolRequests(handle.agentId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        writeError(`${handle.agentId}: Tool Request worker failed; retrying: ${detail}\n`);
        if (request) {
          try {
            await store.settleToolRequest(request.requestId, {
              state: "indeterminate",
              error: `Tool Request worker failed after claiming this request: ${detail}`,
            });
          } catch (settlementError) {
            writeError(
              `${handle.agentId}: Tool Request worker could not settle ${request.requestId} indeterminate: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}\n`,
            );
          }
        }
        if (!stopping) await Bun.sleep(100);
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
