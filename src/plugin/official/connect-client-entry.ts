import { fileURLToPath } from "node:url";
import { startClientInterface } from "../../client-interface/server";
import { verifyClientAssetGraph } from "../../client-interface/client-assets";
import {
  type ConnectClientHostFacade,
  requireConnectClientHostFacade,
} from "../../client-interface/plugin-host-facade";
import type {
  ConnectPluginDisposer,
  ConnectPluginEntry,
  ConnectPluginManagedWebAppAcquireContext,
  ConnectPluginManagedWebAppInstance,
  ManagedWebAppHealth,
} from "../sdk";
import {
  CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
  CONNECT_CLIENT_MANAGED_WEB_APP_REF,
  CONNECT_CLIENT_PLUGIN_ID,
} from "./connect-client-manifest";

export interface ConnectClientOfficialPluginEntryOptions {
  readonly assetsPath?: string;
  readonly assetIntegrityManifestPath?: string;
  readonly resolveHostFacade?: (activationGeneration: number) => ConnectClientHostFacade;
  readonly verifyAssets?: (assetsPath: string, integrityManifestPath: string) => Promise<void>;
  readonly startServer?: typeof startClientInterface;
}

export function createConnectClientOfficialPluginEntry(
  options: ConnectClientOfficialPluginEntryOptions = {},
): ConnectPluginEntry {
  return {
    activate(context) {
      context.hostCapabilities.get("managed-web-app-provider").register({
        capabilityId: CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
        instanceKey(instance) {
          return `${instance.pluginId}/${instance.capabilityId}/${instance.activationGeneration}`;
        },
        async acquire(acquireContext) {
          assertConnectClientContext(acquireContext);
          const assetsPath = options.assetsPath ?? fileURLToPath(new URL("../client/", import.meta.url));
          const integrityManifestPath =
            options.assetIntegrityManifestPath ?? fileURLToPath(new URL("../client-assets.json", import.meta.url));
          await (options.verifyAssets ?? verifyClientAssetGraph)(assetsPath, integrityManifestPath);
          const facade =
            options.resolveHostFacade?.(acquireContext.activationGeneration) ??
            requireConnectClientHostFacade(CONNECT_CLIENT_MANAGED_WEB_APP_REF, acquireContext.activationGeneration);
          assertFacadeScope(facade, acquireContext.activationGeneration);
          const listen = readListenPolicy(acquireContext.installationConfiguration);
          const server = await (options.startServer ?? startClientInterface)({
            applicationPort: facade.applicationPort,
            assetsPath,
            managedWebApp: CONNECT_CLIENT_MANAGED_WEB_APP_REF,
            hostname: listen.hostname,
            port: listen.port,
          });
          return new ConnectClientManagedWebAppInstance(loopbackUpstream(server.origin), async () => {
            await server.stop();
          });
        },
      });
    },
  };
}

function assertConnectClientContext(context: ConnectPluginManagedWebAppAcquireContext): void {
  if (
    context.pluginId !== CONNECT_CLIENT_PLUGIN_ID ||
    context.capabilityId !== CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID
  ) {
    throw new Error("Connect Client provider received a foreign Managed Web App context");
  }
}

function assertFacadeScope(facade: ConnectClientHostFacade, activationGeneration: number): void {
  const scope = facade.scope;
  if (
    scope.activationGeneration !== activationGeneration ||
    scope.managedWebApp.pluginId !== CONNECT_CLIENT_PLUGIN_ID ||
    scope.managedWebApp.capabilityId !== CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID
  ) {
    throw new Error("Connect Client Host facade scope does not match the active Managed Web App");
  }
}
function readListenPolicy(configuration: Readonly<Record<string, unknown>>): {
  hostname: "127.0.0.1" | "0.0.0.0";
  port: number;
} {
  const hostname = configuration.hostname ?? "127.0.0.1";
  const port = configuration.port ?? 47_823;
  if (hostname !== "127.0.0.1" && hostname !== "0.0.0.0") {
    throw new Error("Connect Client hostname must be 127.0.0.1 or 0.0.0.0");
  }
  if (!Number.isInteger(port) || Number(port) < 1_024 || Number(port) > 65_535) {
    throw new Error("Connect Client port must be an integer from 1024 through 65535");
  }
  return Object.freeze({ hostname, port: Number(port) });
}


class ConnectClientManagedWebAppInstance implements ConnectPluginManagedWebAppInstance {
  private releaseOperation: Promise<void> | null = null;
  private currentHealth: ManagedWebAppHealth = "ready";
  private readonly healthListeners = new Set<(health: ManagedWebAppHealth) => void>();
  private readonly exitListeners = new Set<(error?: unknown) => void>();
  private released = false;

  constructor(
    readonly upstream: string,
    private readonly releaseLease: () => Promise<void>,
  ) {
    const url = new URL(upstream);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" &&
        url.hostname !== "::1" &&
        url.hostname !== "[::1]" &&
        url.hostname !== "localhost")
    ) {
      throw new Error("Connect Client Host facade returned a non-loopback upstream");
    }
  }

  async waitUntilReady(): Promise<void> {
    if (this.currentHealth !== "ready") throw new Error("Connect Client server is not ready");
  }

  health(): ManagedWebAppHealth {
    return this.currentHealth;
  }

  onHealthChange(listener: (health: ManagedWebAppHealth) => void): ConnectPluginDisposer {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  onExit(listener: (error?: unknown) => void): ConnectPluginDisposer {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async release(): Promise<void> {
    if (this.released) return;
    if (this.releaseOperation) return await this.releaseOperation;
    const operation = this.releaseLease().then(() => {
      this.released = true;
      this.currentHealth = "stopped";
      for (const listener of this.healthListeners) listener("stopped");
      this.healthListeners.clear();
      this.exitListeners.clear();
    });
    this.releaseOperation = operation;
    try {
      await operation;
    } finally {
      if (!this.released && this.releaseOperation === operation) this.releaseOperation = null;
    }
  }
}

function loopbackUpstream(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:") throw new Error("Connect Client upstream must use HTTP loopback");
  if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") {
    url.hostname = "127.0.0.1";
  }
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Connect Client upstream must resolve to loopback");
  }
  return url.origin;
}

export default createConnectClientOfficialPluginEntry();
