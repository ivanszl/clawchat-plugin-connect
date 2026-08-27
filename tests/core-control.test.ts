import { describe, expect, it, mock } from "bun:test";
import type { ManagedWebAppLease } from "../src/plugin/managed-web-app-registry";
import type { ConnectPluginHost } from "../src/plugin/host";
import type { ManagedWebAppGenerationReference } from "../src/plugin/sdk";
import {
  CORE_CLIENT_PATH,
  CORE_CONTROL_CONFIG_HEADER,
  CORE_CONTROL_ORIGIN,
  type CoreControlServerFactoryOptions,
  startCoreControl,
} from "../src/service/core-control";

const configPath = "/tmp/connect-core-control-test.json";

function clientRequest(bindingId: string): Request {
  return new Request(`${CORE_CONTROL_ORIGIN}${CORE_CLIENT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [CORE_CONTROL_CONFIG_HEADER]: configPath,
    },
    body: JSON.stringify({ bindingId }),
  });
}

describe("Core control local Connect Client acquisition", () => {
  it("retains one local lease and releases it before matching Provider retirement", async () => {
    const release = mock(async () => undefined);
    const lease: ManagedWebAppLease = {
      selection: {
        pluginId: "clawling.web.connect-client",
        capabilityId: "connect-client",
        activationGeneration: 4,
        displayName: "ClawChat Connect Client",
        description: "ClawChat Connect's local browser client",
        kind: "compatible",
      },
      instanceKey: "client-generation-4",
      upstream: "http://127.0.0.1:47999",
      health: () => "ready",
      onHealthChange: () => () => undefined,
      release,
    };
    const acquireManagedWebApp = mock(async () => lease);
    let retireLease:
      | ((reference: ManagedWebAppGenerationReference) => Promise<void>)
      | undefined;
    const host = {
      acquireManagedWebApp,
      registerManagedWebAppLeaseRetirer(
        retire: (reference: ManagedWebAppGenerationReference) => Promise<void>,
      ) {
        retireLease = retire;
        return () => {
          retireLease = undefined;
        };
      },
    } as unknown as ConnectPluginHost;
    let serverOptions: CoreControlServerFactoryOptions | undefined;
    const stopServer = mock(async () => undefined);
    const control = await startCoreControl(configPath, host, (options) => {
      serverOptions = options;
      return { stop: stopServer };
    });
    if (!serverOptions) throw new Error("Core control server did not start");
    const context = { requestIP: () => ({ address: "127.0.0.1" }) };

    const first = await serverOptions.fetch(clientRequest("desktop"), context);
    const second = await serverOptions.fetch(clientRequest("desktop"), context);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ origin: lease.upstream });
    expect(acquireManagedWebApp).toHaveBeenCalledTimes(1);
    expect(acquireManagedWebApp).toHaveBeenCalledWith("desktop", {
      pluginId: "clawling.web.connect-client",
      capabilityId: "connect-client",
    });

    if (!retireLease) throw new Error("Core control did not register its lease retirement port");
    await retireLease({
      pluginId: "clawling.web.connect-client",
      capabilityId: "connect-client",
      activationGeneration: 4,
    });
    expect(release).toHaveBeenCalledTimes(1);
    await control.stop();
    expect(release).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledWith(true);
  });

  it("retains failed shutdown leases so Core control stop can be retried", async () => {
    let releaseAttempts = 0;
    const release = mock(async () => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) throw new Error("Client lease stop failed");
    });
    const lease: ManagedWebAppLease = {
      selection: {
        pluginId: "clawling.web.connect-client",
        capabilityId: "connect-client",
        activationGeneration: 4,
        displayName: "ClawChat Connect Client",
        description: "ClawChat Connect's local browser client",
        kind: "compatible",
      },
      instanceKey: "client-generation-4",
      upstream: "http://127.0.0.1:47999",
      health: () => "ready",
      onHealthChange: () => () => undefined,
      release,
    };
    const host = {
      acquireManagedWebApp: async () => lease,
      registerManagedWebAppLeaseRetirer: () => () => undefined,
    } as unknown as ConnectPluginHost;
    let serverOptions: CoreControlServerFactoryOptions | undefined;
    const stopServer = mock(async () => undefined);
    const control = await startCoreControl(configPath, host, (options) => {
      serverOptions = options;
      return { stop: stopServer };
    });
    if (!serverOptions) throw new Error("Core control server did not start");
    await serverOptions.fetch(clientRequest("desktop"), {
      requestIP: () => ({ address: "127.0.0.1" }),
    });

    await expect(control.stop()).rejects.toThrow(
      "Core control could not release every local Connect Client lease",
    );
    expect(stopServer).not.toHaveBeenCalled();
    await expect(control.stop()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
    expect(stopServer).toHaveBeenCalledWith(true);
  });

  it("returns absence without retaining a fake Client target", async () => {
    const acquireManagedWebApp = mock(async () => null);
    const host = {
      acquireManagedWebApp,
      registerManagedWebAppLeaseRetirer: () => () => undefined,
    } as unknown as ConnectPluginHost;
    let serverOptions: CoreControlServerFactoryOptions | undefined;
    const control = await startCoreControl(configPath, host, (options) => {
      serverOptions = options;
      return { stop: () => undefined };
    });
    if (!serverOptions) throw new Error("Core control server did not start");

    const response = await serverOptions.fetch(clientRequest("desktop"), {
      requestIP: () => ({ address: "127.0.0.1" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: "No active Connect Client supports Agent Binding desktop" },
    });
    await control.stop();
  });
});
