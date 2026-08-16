import type { Context, Plugin } from "cordis";
import type { PersistenceService } from "../persistence/service";
import type { ActivationCredentials, ConnectConfig, RuntimeStatus } from "../types";
import { createSessionContinuityModule, type SessionContinuityModule } from "../workspaces/session-continuity";
import { WorkspaceCatalog } from "../workspaces/workspaces";

export interface ActivatedAgentBinding {
  readonly agentId: string;
  readonly activation: ActivationCredentials;
}

export interface AgentBindingModule {
  prepareService(config: ConnectConfig): Promise<{
    activatedBindings: ActivatedAgentBinding[];
    deviceId: string;
  }>;
  setRuntimeAvailability(
    agentId: string,
    availability: RuntimeStatus["runtimeAvailability"],
    recentError: string | null,
  ): Promise<void>;
}

export interface ConnectDurableModules {
  readonly stateStore: PersistenceService["state"];
  readonly agentBindings: AgentBindingModule;
  readonly workspaces: WorkspaceCatalog;
  readonly sessions: SessionContinuityModule;
}

declare module "cordis" {
  interface Context {
    connectPersistence: PersistenceService;
    connectAgentBindings: AgentBindingModule;
    connectWorkspaces: WorkspaceCatalog;
    connectSessionContinuity: SessionContinuityModule;
  }
}

export async function mountMandatoryDurableModules(
  root: Context,
  persistence: PersistenceService,
  reportDisposalFailure: (error: unknown) => void,
): Promise<ConnectDurableModules> {
  let persistenceModule!: PersistenceService;
  let agentBindingModule!: AgentBindingModule;
  let workspaceModule!: WorkspaceCatalog;
  let sessionContinuityModule!: SessionContinuityModule;
  const persistencePlugin = {
    name: "connect-persistence",
    provide: "connectPersistence",
    apply: async (ctx) => {
      await persistence.initialize();
      persistenceModule = persistence;
      ctx.provide("connectPersistence", persistenceModule);
      return async () => {
        try {
          await persistence.close();
        } catch (error) {
          reportDisposalFailure(error);
        }
      };
    },
  } satisfies Plugin;

  const agentBindingPlugin = {
    name: "connect-agent-binding",
    inject: ["connectPersistence"],
    provide: "connectAgentBindings",
    apply: (ctx) => {
      const store = ctx.connectPersistence.state;
      agentBindingModule = {
        async prepareService(config) {
          const activatedBindings = (
            await Promise.all(
              Object.keys(config.agents).map(async (agentId) => ({
                agentId,
                activation: await store.getActivation(agentId),
              })),
            )
          ).flatMap(({ agentId, activation }) => (activation ? [{ agentId, activation }] : []));
          if (activatedBindings.length === 0) {
            throw new Error(
              "no activated Agent Bindings are configured; activate at least one Binding before starting Connect",
            );
          }
          return {
            activatedBindings,
            deviceId: await store.getOrCreateDeviceId(),
          };
        },
        async setRuntimeAvailability(agentId, availability, recentError) {
          await store.setRuntimeAvailability(agentId, availability, recentError);
        },
      };
      ctx.provide("connectAgentBindings", agentBindingModule);
    },
  } satisfies Plugin;

  const workspacePlugin = {
    name: "connect-workspaces",
    inject: ["connectPersistence"],
    provide: "connectWorkspaces",
    apply: (ctx) => {
      workspaceModule = new WorkspaceCatalog(ctx.connectPersistence.state);
      ctx.provide("connectWorkspaces", workspaceModule);
    },
  } satisfies Plugin;

  const sessionContinuityPlugin = {
    name: "connect-session-continuity",
    inject: ["connectPersistence", "connectAgentBindings", "connectWorkspaces"],
    provide: "connectSessionContinuity",
    apply: (ctx) => {
      sessionContinuityModule = createSessionContinuityModule(ctx.connectPersistence.state);
      ctx.provide("connectSessionContinuity", sessionContinuityModule);
    },
  } satisfies Plugin;

  await root.plugin(persistencePlugin);
  await Promise.all([root.plugin(agentBindingPlugin), root.plugin(workspacePlugin)]);
  await root.plugin(sessionContinuityPlugin);

  return {
    stateStore: persistenceModule.state,
    agentBindings: agentBindingModule,
    workspaces: workspaceModule,
    sessions: sessionContinuityModule,
  };
}
