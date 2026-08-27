import { describe, expect, it } from "bun:test";
import { ManagedWebAppRegistry } from "../src/plugin/managed-web-app-registry";
import type {
  ConnectPluginManagedWebAppInstance,
  ConnectPluginManagedWebAppProvider,
} from "../src/plugin/sdk";

const runtime = { pluginId: "example.runtime", capabilityId: "runtime" } as const;

function activate(registry: ManagedWebAppRegistry, provider: ConnectPluginManagedWebAppProvider): void {
  registry.activate({
    pluginId: runtime.pluginId,
    activationGeneration: 1,
    manifest: {
      id: "web",
      type: "managed-web-app",
      interfaceVersion: "1",
      displayName: "Example Web",
      description: "Example browser interface",
      configurationSchema: { type: "object", additionalProperties: false },
      nativeRuntimeCapabilityIds: [runtime.capabilityId],
      compatibleRuntimes: [],
    },
    installationConfiguration: {},
    configuration: {},
    provider,
  });
}

function request(bindingId: string) {
  return { bindingId, runtime, runtimeConfiguration: {} };
}

function instance(upstream: string, release: () => Promise<void>): ConnectPluginManagedWebAppInstance {
  return {
    upstream,
    async waitUntilReady() {},
    health: () => "ready",
    onHealthChange: () => () => undefined,
    onExit: () => () => undefined,
    release,
  };
}

describe("Managed Web App cleanup recovery", () => {
  it("keeps the final lease and Instance retriable when Provider stop fails", async () => {
    let releases = 0;
    const registry = new ManagedWebAppRegistry();
    activate(registry, {
      capabilityId: "web",
      instanceKey: () => "shared",
      acquire: async () =>
        instance("http://127.0.0.1:41001", async () => {
          releases += 1;
          if (releases === 1) throw new Error("stop failed");
        }),
    });
    const lease = await registry.acquire(request("one"));
    if (!lease) throw new Error("Managed Web App lease was not acquired");

    await expect(lease.release()).rejects.toThrow("stop failed");
    expect(registry.snapshots()).toEqual([
      expect.objectContaining({ instanceKey: "shared", leaseCount: 1, bindingIds: ["one"] }),
    ]);

    await expect(lease.release()).resolves.toBeUndefined();
    expect(releases).toBe(2);
    expect(registry.snapshots()).toEqual([]);
  });

  it("records and retires a post-readiness upstream change before retrying the same selection", async () => {
    let acquisitions = 0;
    let releases = 0;
    const registry = new ManagedWebAppRegistry();
    activate(registry, {
      capabilityId: "web",
      instanceKey: () => "shared",
      async acquire() {
        acquisitions += 1;
        if (acquisitions > 1) {
          return instance("http://127.0.0.1:41002", async () => {
            releases += 1;
          });
        }
        let reads = 0;
        const acquired = instance("http://127.0.0.1:41002", async () => {
          releases += 1;
        });
        return {
          ...acquired,
          get upstream() {
            reads += 1;
            return reads <= 3 ? "http://127.0.0.1:41002" : "http://127.0.0.1:41003";
          },
        };
      },
    });

    await expect(registry.acquire(request("one"))).rejects.toThrow("upstream changed");
    expect(releases).toBe(1);
    expect(registry.snapshots()).toEqual([
      expect.objectContaining({
        instanceKey: "shared",
        health: "error",
        diagnostic: "Managed Web App upstream changed during an active instance lease",
        leaseCount: 0,
        bindingIds: ["one"],
        upstream: null,
      }),
    ]);

    const retry = await registry.acquire(request("one"));
    expect(acquisitions).toBe(2);
    expect(retry?.health()).toBe("ready");
    await retry?.release();
  });

  it("retains failed zero-lease cleanup across Provider removal retries", async () => {
    let releases = 0;
    const registry = new ManagedWebAppRegistry();
    activate(registry, {
      capabilityId: "web",
      instanceKey: () => "failed",
      acquire: async () =>
        instance("https://invalid.example", async () => {
          releases += 1;
          if (releases < 3) throw new Error("cleanup still blocked");
        }),
    });

    await expect(registry.acquire(request("one"))).rejects.toThrow("opaque 127.0.0.1 HTTP origin");
    await expect(
      registry.remove({
        pluginId: runtime.pluginId,
        capabilityId: "web",
        activationGeneration: 1,
      }),
    ).rejects.toThrow("cleanup still blocked");
    expect(registry.snapshots()).toHaveLength(1);

    await expect(
      registry.remove({
        pluginId: runtime.pluginId,
        capabilityId: "web",
        activationGeneration: 1,
      }),
    ).resolves.toBeUndefined();
    expect(releases).toBe(3);
    expect(registry.snapshots()).toEqual([]);
  });

  it("retains failed Registry shutdown cleanup for a repeated close", async () => {
    let releases = 0;
    const registry = new ManagedWebAppRegistry();
    activate(registry, {
      capabilityId: "web",
      instanceKey: () => "closing",
      acquire: async () =>
        instance("http://127.0.0.1:41004", async () => {
          releases += 1;
          if (releases === 1) throw new Error("close blocked");
        }),
    });
    await registry.acquire(request("one"));

    await expect(registry.close()).rejects.toThrow(
      "Managed Web App Registry could not stop every Instance",
    );
    expect(registry.snapshots()).toHaveLength(1);
    await expect(registry.close()).resolves.toBeUndefined();
    expect(releases).toBe(2);
    expect(registry.snapshots()).toEqual([]);
  });
});
