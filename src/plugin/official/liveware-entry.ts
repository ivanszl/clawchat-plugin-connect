import type { ConnectPluginExposureActivation, ManagedConnectPluginEntry } from "../official-sdk";
import type { ConnectPluginDisposer } from "../sdk";
import { OFFICIAL_LIVEWARE_CAPABILITY_ID, type OfficialLivewareAccessPolicy } from "./liveware-manifest";
import {
  BindingLivewarePublicationLifecycle,
  type BindingLivewarePublicationStateStore,
  type BindingLivewarePublicationTarget,
  type LivewarePublicationControlPlane,
  type LivewarePublicationRegistrationPort,
} from "./liveware-publication";

export interface OfficialLivewareGatewayLease {
  readonly upstream: string;
  release(): Promise<void>;
}
export interface OfficialLivewareManagedDisposer extends ConnectPluginDisposer {
  retire(): Promise<void>;
  retireBindings(bindingIds: readonly string[]): Promise<void>;
}

/**
 * Privileged Core services granted only to the release-verified official
 * Liveware capability. This interface is intentionally absent from the public
 * Plugin SDK and contains no Binding credential or mutable Core domain object.
 */
export interface OfficialLivewareExposureServices {
  listBindings(): Promise<readonly BindingLivewarePublicationTarget[]>;
  readonly state: BindingLivewarePublicationStateStore;
  readonly controlPlane: LivewarePublicationControlPlane;
  readonly registrations: LivewarePublicationRegistrationPort;
  acquireGateway(activationGeneration: number): Promise<OfficialLivewareGatewayLease>;
}

interface PrivilegedLivewareActivation extends ConnectPluginExposureActivation {
  readonly officialLiveware: OfficialLivewareExposureServices;
}

export function createOfficialLivewarePluginEntry(): ManagedConnectPluginEntry {
  return {
    activate(context) {
      const exposures = context.hostCapabilities.get("exposure-provider");
      exposures.register({
        capabilityId: OFFICIAL_LIVEWARE_CAPABILITY_ID,
        async activate(publicActivation) {
          const activation = requirePrivilegedActivation(publicActivation);
          const accessPolicy = readAccessPolicy(activation.configuration);
          const initialTargets = await activation.officialLiveware.listBindings();
          const lease =
            accessPolicy === "private"
              ? await activation.officialLiveware.acquireGateway(activation.activationGeneration)
              : undefined;
          const lifecycle = new BindingLivewarePublicationLifecycle({
            activationGeneration: activation.activationGeneration,
            upstream: lease?.upstream ?? "http://127.0.0.1:1",
            state: activation.officialLiveware.state,
            controlPlane: activation.officialLiveware.controlPlane,
            registrations: activation.officialLiveware.registrations,
          });
          const targets = new Map(initialTargets.map((target) => [target.bindingId, target]));
          const remainingBindings = new Set(targets.keys());
          const retiredBindings = new Set<string>();
          let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
          let reconciliation = Promise.resolve();
          let stopping = false;
          const reconcileBindings = async (): Promise<void> => {
            const listedTargets = await activation.officialLiveware.listBindings();
            const listedBindingIds = new Set(listedTargets.map((target) => target.bindingId));
            for (const bindingId of retiredBindings) {
              if (listedBindingIds.has(bindingId)) continue;
              retiredBindings.delete(bindingId);
              targets.delete(bindingId);
            }
            const reconcilableTargets = listedTargets.filter((target) => !retiredBindings.has(target.bindingId));
            for (const target of reconcilableTargets) {
              targets.set(target.bindingId, target);
              remainingBindings.add(target.bindingId);
            }
            if (accessPolicy === "private") {
              await Promise.allSettled(
                reconcilableTargets.map(async (target) => await lifecycle.ensurePrivate(target)),
              );
            } else {
              await Promise.allSettled(reconcilableTargets.map(async (target) => await lifecycle.retire(target)));
            }
          };
          const scheduleReconciliation = (): void => {
            if (stopping) return;
            reconcileTimer = setTimeout(() => {
              reconciliation = reconcileBindings()
                .catch(() => undefined)
                .finally(() => scheduleReconciliation());
            }, 1_000);
            reconcileTimer.unref();
          };
          const stopReconciliation = async (): Promise<void> => {
            stopping = true;
            if (reconcileTimer) clearTimeout(reconcileTimer);
            await reconciliation;
          };
          let leaseReleased = false;
          const releaseLease = async (): Promise<void> => {
            if (leaseReleased) return;
            leaseReleased = true;
            await lease?.release();
          };
          try {
            if (accessPolicy === "private") {
              await Promise.allSettled(
                [...targets.values()].map(async (target) => await lifecycle.ensurePrivate(target)),
              );
            } else {
              await Promise.all([...targets.values()].map(async (target) => await lifecycle.retire(target)));
            }
          } catch (error) {
            await lifecycle.dispose();
            await releaseLease().catch(() => undefined);
            throw error;
          }
          scheduleReconciliation();
          const dispose = Object.assign(
            async () => {
              await stopReconciliation();
              await lifecycle.dispose();
              await releaseLease();
            },
            {
              retire: async () => {
                await stopReconciliation();
                await retireTargets(lifecycle, [...targets.values()]);
                remainingBindings.clear();
                await lifecycle.dispose();
                await releaseLease();
              },
              retireBindings: async (bindingIds: readonly string[]) => {
                await reconciliation;
                const selected = new Set(bindingIds);
                for (const target of targets.values()) {
                  if (!selected.has(target.bindingId) || !remainingBindings.has(target.bindingId)) continue;
                  await lifecycle.retire(target);
                  remainingBindings.delete(target.bindingId);
                  retiredBindings.add(target.bindingId);
                }
                if (remainingBindings.size === 0) {
                  await stopReconciliation();
                  await lifecycle.dispose();
                  await releaseLease();
                }
              },
            },
          ) satisfies OfficialLivewareManagedDisposer;
          return dispose;
        },
      });
    },
  };
}

async function retireTargets(
  lifecycle: BindingLivewarePublicationLifecycle,
  targets: readonly BindingLivewarePublicationTarget[],
): Promise<void> {
  for (const target of targets) await lifecycle.retire(target);
}

function requirePrivilegedActivation(activation: ConnectPluginExposureActivation): PrivilegedLivewareActivation {
  const privileged = activation as Partial<PrivilegedLivewareActivation>;
  const services = privileged.officialLiveware;
  if (
    !services ||
    typeof services.listBindings !== "function" ||
    typeof services.acquireGateway !== "function" ||
    !services.state ||
    !services.controlPlane ||
    !services.registrations
  ) {
    throw new Error("The official Liveware capability requires its release-verified Core grant");
  }
  return privileged as PrivilegedLivewareActivation;
}

function readAccessPolicy(configuration: Readonly<Record<string, unknown>>): OfficialLivewareAccessPolicy {
  const value = configuration.accessPolicy ?? "private";
  if (value !== "private" && value !== "off") {
    throw new Error("Official Liveware accessPolicy must be private or off");
  }
  return value;
}

export {
  LIVEWARE_EXPOSURE_CONFIGURATION_SCHEMA,
  LIVEWARE_INSTALLATION_CONFIGURATION_SCHEMA,
  OFFICIAL_LIVEWARE_CAPABILITY_ID,
  OFFICIAL_LIVEWARE_PLUGIN_ID,
} from "./liveware-manifest";

export default createOfficialLivewarePluginEntry();
