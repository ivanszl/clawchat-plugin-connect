import type { ConnectStateStore } from "../../persistence/state";
import {
  createLivewareControlDependencies,
  type LivewareApp,
  type LivewareControlDependencies,
  type LivewareControlSession,
  resolveLivewareExecutablePath,
} from "../../service/liveware-control";
import type { ActivationCredentials } from "../../types";
import {
  BindingLivewarePublicationLifecycle,
  type BindingLivewarePublicationTarget,
  type LivewarePublicationApp,
} from "./liveware-publication";
import { ConnectBindingLivewarePublicationStateStore } from "./liveware-publication-state";

export interface RetireOfficialLivewarePublicationsOptions {
  readonly bindingIds: readonly string[];
  readonly clawChatBaseUrl: string;
  readonly stateStore: ConnectStateStore;
  readonly dependencies?: LivewareControlDependencies;
}

export async function retireOfficialLivewarePublications(
  options: RetireOfficialLivewarePublicationsOptions,
): Promise<void> {
  const state = new ConnectBindingLivewarePublicationStateStore(options.stateStore);
  const activations = new Map(
    (await options.stateStore.listActivations()).map((activation) => [activation.localAgentId, activation]),
  );
  const dependencies =
    options.dependencies ??
    createLivewareControlDependencies({
      livewarePath: await resolveLivewareExecutablePath(),
      clawChatBaseUrl: options.clawChatBaseUrl,
    });
  const deviceId = await options.stateStore.getOrCreateDeviceId();

  for (const bindingId of options.bindingIds) {
    const record = await state.read(bindingId);
    if (!record || record.value.status === "retired") continue;
    const activation = activations.get(bindingId);
    if (!activation) {
      throw new Error(`Binding Liveware Publication ${bindingId} cannot be retired because its activation is missing`);
    }
    const lifecycle = createRetirementLifecycle(
      record.value.activationGeneration,
      activation,
      deviceId,
      state,
      dependencies,
    );
    try {
      await lifecycle.retire({ bindingId, deviceId });
    } finally {
      await lifecycle.dispose();
    }
  }
}

function createRetirementLifecycle(
  activationGeneration: number,
  activation: ActivationCredentials,
  deviceId: string,
  state: ConnectBindingLivewarePublicationStateStore,
  dependencies: LivewareControlDependencies,
): BindingLivewarePublicationLifecycle {
  const target: BindingLivewarePublicationTarget = { bindingId: activation.localAgentId, deviceId };
  return new BindingLivewarePublicationLifecycle({
    activationGeneration,
    upstream: "http://127.0.0.1:1",
    state,
    controlPlane: {
      connect: async (bindingId) => {
        if (bindingId !== target.bindingId) throw new Error(`Unknown Agent Binding: ${bindingId}`);
        const session = await dependencies.controlPlane.connect(activation.accessToken);
        return {
          listApps: async () => (await session.listApps()).map(toPublicationApp),
          inspectApp: async (appId) => toPublicationApp(await requireInspectApp(session, appId)),
          createApp: async (correlationKey) => toPublicationApp(await session.createApp(correlationKey, "private")),
          bindTunnel: async (appId, upstream) => await session.bindTunnel(appId, upstream),
          deleteApp: async (appId) => await session.deleteApp(appId),
        };
      },
    },
    registrations: {
      list: async (bindingId, requestedDeviceId) => {
        assertTarget(target, bindingId, requestedDeviceId);
        return await dependencies.clawChat.list(activation, requestedDeviceId);
      },
      register: async (bindingId, requestedDeviceId, registration) => {
        assertTarget(target, bindingId, requestedDeviceId);
        await dependencies.clawChat.register(activation, requestedDeviceId, registration);
      },
      unregister: async (bindingId, requestedDeviceId, livewareId) => {
        assertTarget(target, bindingId, requestedDeviceId);
        await dependencies.clawChat.unregister(activation, requestedDeviceId, livewareId);
      },
    },
  });
}

async function requireInspectApp(session: LivewareControlSession, appId: string): Promise<LivewareApp> {
  if (!session.inspectApp) throw new Error("Liveware App inspection is unavailable");
  return await session.inspectApp(appId);
}

function assertTarget(target: BindingLivewarePublicationTarget, bindingId: string, deviceId: string): void {
  if (bindingId !== target.bindingId || deviceId !== target.deviceId) {
    throw new Error(`Unknown Agent Binding publication target: ${bindingId}`);
  }
}

function toPublicationApp(app: LivewareApp): LivewarePublicationApp {
  return { appId: app.appId, name: app.name, publicUrl: app.publicUrl || null };
}
