import type { Context, Plugin } from "cordis";
import type { ConnectStateStore } from "../persistence/state";
import { ProjectCatalog } from "../projects/projects";
import { createSessionContinuityModule, type SessionContinuityModule } from "../projects/session-continuity";
import type { ActivationCredentials, ConnectConfig, RuntimeStatus } from "../types";

interface ConnectPersistenceModule {
  readonly stateStore: ConnectStateStore;
}

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
  readonly stateStore: ConnectStateStore;
  readonly agentBindings: AgentBindingModule;
  readonly projects: ProjectCatalog;
  readonly sessions: SessionContinuityModule;
}

declare module "cordis" {
  interface Context {
    connectPersistence: ConnectPersistenceModule;
    connectAgentBindings: AgentBindingModule;
    connectProjects: ProjectCatalog;
    connectSessionContinuity: SessionContinuityModule;
  }
}

export async function mountMandatoryDurableModules(
  root: Context,
  stateStore: ConnectStateStore,
  reportDisposalFailure: (error: unknown) => void,
): Promise<ConnectDurableModules> {
  let persistenceModule!: ConnectPersistenceModule;
  let agentBindingModule!: AgentBindingModule;
  let projectModule!: ProjectCatalog;
  let sessionContinuityModule!: SessionContinuityModule;
  const persistencePlugin = {
    name: "connect-persistence",
    provide: "connectPersistence",
    apply: async (ctx) => {
      await stateStore.initialize();
      persistenceModule = { stateStore };
      ctx.provide("connectPersistence", persistenceModule);
      return async () => {
        try {
          await stateStore.close();
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
      const store = ctx.connectPersistence.stateStore;
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

  const projectPlugin = {
    name: "connect-projects",
    inject: ["connectPersistence"],
    provide: "connectProjects",
    apply: (ctx) => {
      projectModule = new ProjectCatalog(ctx.connectPersistence.stateStore);
      ctx.provide("connectProjects", projectModule);
    },
  } satisfies Plugin;

  const sessionContinuityPlugin = {
    name: "connect-session-continuity",
    inject: ["connectPersistence", "connectAgentBindings", "connectProjects"],
    provide: "connectSessionContinuity",
    apply: (ctx) => {
      sessionContinuityModule = createSessionContinuityModule(ctx.connectPersistence.stateStore);
      ctx.provide("connectSessionContinuity", sessionContinuityModule);
    },
  } satisfies Plugin;

  await root.plugin(persistencePlugin);
  await Promise.all([root.plugin(agentBindingPlugin), root.plugin(projectPlugin)]);
  await root.plugin(sessionContinuityPlugin);

  return {
    stateStore: persistenceModule.stateStore,
    agentBindings: agentBindingModule,
    projects: projectModule,
    sessions: sessionContinuityModule,
  };
}
