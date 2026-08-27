import type { RuntimeCapabilityRef } from "../plugin/sdk";
import type { BindingRuntimeHandle } from "../service/binding-runtime";
import type { ConnectClientHostFacade, ConnectClientHostFacadeScope } from "./plugin-host-facade";
import {
  createCoreConnectClientApplicationPort,
  type ConnectClientApplicationServices,
} from "./server";

export interface ConnectClientCoreServices extends Omit<ConnectClientApplicationServices, "runtimes"> {
  readonly runtimes: () => readonly BindingRuntimeHandle[];
}

/**
 * Implements the narrow generation-scoped Host authority granted to the
 * installed Connect Client Plugin. Core services remain closure-private.
 */
export function createConnectClientHostFacade(
  scope: Readonly<ConnectClientHostFacadeScope>,
  services: ConnectClientCoreServices,
): ConnectClientHostFacade {
  return Object.freeze({
    scope: Object.freeze({
      managedWebApp: Object.freeze({ ...scope.managedWebApp }),
      activationGeneration: scope.activationGeneration,
    }),
    applicationPort: createCoreConnectClientApplicationPort(() => ({
      ...services,
      runtimes: [...services.runtimes()],
    })),
  });
}



export function connectClientFacadeScope(
  managedWebApp: Readonly<RuntimeCapabilityRef>,
  activationGeneration: number,
): ConnectClientHostFacadeScope {
  return Object.freeze({
    managedWebApp: Object.freeze({ ...managedWebApp }),
    activationGeneration,
  });
}
