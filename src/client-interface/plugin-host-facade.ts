import type { ConnectPluginDisposer, RuntimeCapabilityRef } from "../plugin/sdk";
import type { ConnectClientApplicationPort } from "./server";

export interface ConnectClientHostFacadeScope {
  readonly managedWebApp: Readonly<RuntimeCapabilityRef>;
  readonly activationGeneration: number;
}

export interface ConnectClientHostFacade {
  readonly scope: Readonly<ConnectClientHostFacadeScope>;
  readonly applicationPort: ConnectClientApplicationPort;
}

const FACADE_REGISTRY_KEY = Symbol.for("clawchat.connect.client-host-facade.v1");

interface FacadeRegistry {
  readonly facades: Map<string, ConnectClientHostFacade>;
}

function registry(): FacadeRegistry {
  const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = global[FACADE_REGISTRY_KEY] as FacadeRegistry | undefined;
  if (existing) return existing;
  const created: FacadeRegistry = { facades: new Map() };
  global[FACADE_REGISTRY_KEY] = created;
  return created;
}

export function registerConnectClientHostFacade(facade: ConnectClientHostFacade): ConnectPluginDisposer {
  const key = facadeKey(facade.scope.managedWebApp, facade.scope.activationGeneration);
  const facades = registry().facades;
  if (facades.has(key))
    throw new Error("Connect Client Host facade is already registered for this Activation Generation");
  facades.set(key, facade);
  let current = true;
  return () => {
    if (!current) return;
    current = false;
    if (facades.get(key) === facade) facades.delete(key);
  };
}

export function requireConnectClientHostFacade(
  managedWebApp: Readonly<RuntimeCapabilityRef>,
  activationGeneration: number,
): ConnectClientHostFacade {
  const facade = registry().facades.get(facadeKey(managedWebApp, activationGeneration));
  if (!facade) throw new Error("Connect Client Host facade is unavailable for this Activation Generation");
  return facade;
}

function facadeKey(managedWebApp: Readonly<RuntimeCapabilityRef>, activationGeneration: number): string {
  if (!Number.isSafeInteger(activationGeneration) || activationGeneration < 1) {
    throw new Error("Connect Client Activation Generation must be a positive safe integer");
  }
  return `${managedWebApp.pluginId}\0${managedWebApp.capabilityId}\0${activationGeneration}`;
}
