import type { Context, Plugin } from "cordis";
import { isAgentLivewareOperation } from "../agent/agent-liveware";
import { verifyInstalledSkills } from "../agent/skills";
import { getConnectTool } from "../agent/tool-catalog";
import { isIndeterminateToolError } from "../agent/tool-executor";
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
import { type BindingRuntimeLifecycle, retireBindingRuntimeSurfaces } from "./binding-runtime-lifecycle";
import type { ActivatedAgentBinding } from "./connect-durable-modules";

interface ClawChatTransportModule {
  readonly activatedBindings: ActivatedAgentBinding[];
  readonly deviceId: string;
  readonly handles: BindingRuntimeHandle[];
  retireBindings(bindingIds: readonly string[]): Promise<void>;
}

interface ClientAssetsModule {
  readonly path: string;
}

interface ToolRequestWorkerModule {
  readonly active: true;
  retireBindings(bindingIds: readonly string[]): Promise<void>;
  stop(): Promise<void>;
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
  bindingRuntimeLifecycle: BindingRuntimeLifecycle,
): Promise<MountedConnectSurfaceModules> {
  const disposers = new Map<string, () => Promise<void>>();
  const mount = async (plugin: Plugin & { name: string }): Promise<void> => {
    const fiber = root.plugin(plugin);
    await fiber;
    disposers.set(plugin.name, fiber.dispose);
  };
  let detachRetirement: () => void = () => undefined;
  const dispose = async (): Promise<void> => {
    detachRetirement();
    detachRetirement = () => undefined;
    const order = [
      "connect-tool-request-workers",
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
      "connectWorkspaces",
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
      await ctx.connectPersistence.state.expirePendingRuntimeInteractions();
      const handles: BindingRuntimeHandle[] = [];
      const closePromises = new WeakMap<BindingRuntimeHandle, Promise<void>>();
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
              stateStore: ctx.connectPersistence.state,
              workspaces: ctx.connectWorkspaces,
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
        const transports: ClawChatTransportModule = {
          activatedBindings,
          deviceId,
          handles,
          retireBindings: async (bindingIds) => {
            const retiringIds = new Set(bindingIds);
            const results = await closeBindingRuntimeHandles(handles, closePromises, (handle) =>
              retiringIds.has(handle.agentId),
            );
            throwRetirementFailures(results, "Agent Binding transport retirement failed");
          },
        };
        ctx.provide("connectClawChatTransports", transports);
        return async () => {
          const results = await closeBindingRuntimeHandles(handles, closePromises, () => true);
          for (const result of results) {
            if (result.status === "rejected") reportDisposalFailure(result.reason);
          }
        };
      } catch (error) {
        await closeBindingRuntimeHandles(handles, closePromises, () => true);
        throw error;
      }
    },
  } satisfies Plugin;

  const toolRequestWorkerPlugin = {
    name: "connect-tool-request-workers",
    inject: ["connectPersistence", "connectClawChatTransports"],
    provide: "connectToolRequestWorkers",
    apply: (ctx) => {
      const workers = startToolRequestWorkers(
        ctx.connectClawChatTransports.handles,
        ctx.connectPersistence.state,
        options.writeError,
      );
      ctx.provide("connectToolRequestWorkers", workers);
      return async () => {
        try {
          await workers.stop();
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
      "connectWorkspaces",
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
        stateStore: ctx.connectPersistence.state,
        runtimeAdapters: ctx.connectRuntimeAdapters,
        transcriptProjection: ctx.connectTranscriptProjection,
        runtimeInteractions: ctx.connectRuntimeInteractions,
        workspaces: ctx.connectWorkspaces,
        sessionContinuityModule: ctx.connectSessionContinuity,
        pluginManager: ctx.connectPluginHost,
        runtimes: ctx.connectClawChatTransports.handles,
        assetsPath: ctx.connectClientAssets.path,
      });
      const unbindPluginClient = await ctx.connectPluginHost.bindClientInterface(clientInterface);
      ctx.provide("connectClientInterface", clientInterface);
      options.writeOutput(`Connect Client is available at ${clientInterface.origin}.\n`);
      if (options.config.clientHost === "0.0.0.0") {
        options.writeOutput(
          `WARNING: Connect Client is exposed on all IPv4 interfaces without authentication; use port ${options.config.clientPort} only on a trusted LAN.\n`,
        );
      }
      return async () => {
        unbindPluginClient();
        try {
          await clientInterface.stop();
        } catch (error) {
          reportDisposalFailure(error);
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
    detachRetirement = bindingRuntimeLifecycle.attachRetirement(
      async (bindingIds) =>
        await retireBindingRuntimeSurfaces(bindingIds, [
          root.connectToolRequestWorkers,
          root.connectClientInterface,
          {
            retireBindings: async (retiredBindingIds) => {
              root.connectSessionQueue.retainBindings(retiredBindingIds);
            },
          },
          root.connectPluginHost,
          root.connectClawChatTransports,
        ]),
    );
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

async function closeBindingRuntimeHandles(
  handles: BindingRuntimeHandle[],
  closePromises: WeakMap<BindingRuntimeHandle, Promise<void>>,
  shouldClose: (handle: BindingRuntimeHandle) => boolean,
): Promise<PromiseSettledResult<void>[]> {
  const owned = handles.filter(shouldClose);
  const results = await Promise.allSettled(
    owned.map((handle) => {
      const existing = closePromises.get(handle);
      if (existing) return existing;
      const closing = Promise.resolve().then(async () => await handle.close());
      closePromises.set(handle, closing);
      return closing;
    }),
  );
  results.forEach((result, index) => {
    const handle = owned[index];
    if (!handle) return;
    if (result.status === "rejected") {
      closePromises.delete(handle);
      return;
    }
    const ownedIndex = handles.indexOf(handle);
    if (ownedIndex >= 0) handles.splice(ownedIndex, 1);
  });
  return results;
}
function throwRetirementFailures(results: readonly PromiseSettledResult<void>[], message: string): void {
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function startToolRequestWorkers(
  handles: BindingRuntimeHandle[],
  store: ConnectStateStore,
  writeError: (message: string) => void,
): ToolRequestWorkerModule {
  const workers = new Map<
    string,
    {
      stopping: boolean;
      completion: Promise<void>;
    }
  >();
  for (const handle of handles) {
    const worker = { stopping: false, completion: Promise.resolve() };
    worker.completion = (async () => {
      while (!worker.stopping) {
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
      while (!worker.stopping) {
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
          if (!worker.stopping) await Bun.sleep(100);
        }
      }
    })();
    workers.set(handle.agentId, worker);
  }

  const retireBindings = async (bindingIds: readonly string[]): Promise<void> => {
    const retiring = [...new Set(bindingIds)]
      .map((bindingId) => ({ bindingId, worker: workers.get(bindingId) }))
      .filter((entry): entry is { bindingId: string; worker: { stopping: boolean; completion: Promise<void> } } =>
        Boolean(entry.worker),
      );
    for (const { worker } of retiring) worker.stopping = true;
    const results = await Promise.allSettled(retiring.map(async ({ worker }) => await worker.completion));
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const retired = retiring[index];
      if (retired && workers.get(retired.bindingId) === retired.worker) workers.delete(retired.bindingId);
    });
    throwRetirementFailures(results, "Tool Request worker retirement failed");
  };
  return {
    active: true,
    retireBindings,
    stop: async () => await retireBindings([...workers.keys()]),
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
