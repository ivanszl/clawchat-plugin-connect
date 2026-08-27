import { describe, expect, it } from "bun:test";
import { ManagedWebAppRegistry, type ManagedWebAppProviderDefinition } from "../src/plugin/managed-web-app-registry";
import {
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  type ConnectPluginManagedWebAppInstance,
  type ConnectPluginManagedWebAppProvider,
  type ManagedWebAppHealth,
  type RuntimeCapabilityRef,
} from "../src/plugin/sdk";

const runtime: RuntimeCapabilityRef = { pluginId: "runtime.native", capabilityId: "runtime" };

function definition(options: {
  pluginId: string;
  generation?: number;
  native?: string[];
  compatible?: RuntimeCapabilityRef[];
  provider: ConnectPluginManagedWebAppProvider;
}): ManagedWebAppProviderDefinition {
  return {
    pluginId: options.pluginId,
    activationGeneration: options.generation ?? 1,
    manifest: {
      id: "web",
      type: "managed-web-app",
      interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
      configurationSchema: { type: "object" },
      displayName: `${options.pluginId} Web`,
      description: `${options.pluginId} browser interface`,
      nativeRuntimeCapabilityIds: options.native ?? [],
      compatibleRuntimes: options.compatible ?? [],
    },
    installationConfiguration: Object.freeze({}),
    configuration: Object.freeze({}),
    provider: options.provider,
  };
}

function provider(options: {
  key?: (runtimeConfiguration: Readonly<Record<string, unknown>>) => string;
  upstream?: string;
  acquire?: () => Promise<ConnectPluginManagedWebAppInstance>;
} = {}): {
  provider: ConnectPluginManagedWebAppProvider;
  acquired: () => number;
  released: () => number;
  exit: (error?: unknown) => void;
  setUpstream: (upstream: string) => void;
} {
  let acquireCount = 0;
  let releaseCount = 0;
  let upstream = options.upstream ?? "http://127.0.0.1:4123";
  let health: ManagedWebAppHealth = "ready";
  const healthListeners = new Set<(health: ManagedWebAppHealth) => void>();
  const exitListeners = new Set<(error?: unknown) => void>();
  return {
    provider: {
      capabilityId: "web",
      instanceKey(context) {
        return options.key?.(context.runtimeConfiguration) ?? "shared";
      },
      async acquire() {
        acquireCount += 1;
        if (options.acquire) return await options.acquire();
        return {
          get upstream() {
            return upstream;
          },
          async waitUntilReady() {},
          health: () => health,
          onHealthChange(listener) {
            healthListeners.add(listener);
            return () => {
              healthListeners.delete(listener);
            };
          },
          onExit(listener) {
            exitListeners.add(listener);
            return () => {
              exitListeners.delete(listener);
            };
          },
          async release() {
            releaseCount += 1;
          },
        };
      },
    },
    acquired: () => acquireCount,
    released: () => releaseCount,
    exit: (error) => {
      health = error ? "error" : "stopped";
      for (const listener of healthListeners) listener(health);
      for (const listener of exitListeners) listener(error);
    },
    setUpstream: (value) => {
      upstream = value;
    },
  };
}

function request(bindingId: string, key = "shared") {
  return { bindingId, runtime, runtimeConfiguration: { key } };
}

describe("ManagedWebAppRegistry", () => {
  it("selects same-Bundle native before exact compatible and reports conflicts or no App", () => {
    const registry = new ManagedWebAppRegistry();
    registry.activate(definition({ pluginId: "client.one", compatible: [runtime], provider: provider().provider }));
    registry.activate(definition({ pluginId: runtime.pluginId, native: [runtime.capabilityId], provider: provider().provider }));
    expect(registry.select(runtime)).toMatchObject({ pluginId: runtime.pluginId, capabilityId: "web", kind: "native" });
    expect(registry.select({ pluginId: "missing", capabilityId: "runtime" })).toBeNull();

    const ambiguous = new ManagedWebAppRegistry();
    ambiguous.activate(definition({ pluginId: "client.one", compatible: [runtime], provider: provider().provider }));
    ambiguous.activate(definition({ pluginId: "client.two", compatible: [runtime], provider: provider().provider }));
    expect(() => ambiguous.select(runtime)).toThrow("ambiguous compatible Managed Web Apps");
  });

  it("single-flights shared keys, isolates different keys, and stops only after each final lease", async () => {
    const fixture = provider({ key: (configuration) => String(configuration.key) });
    const registry = new ManagedWebAppRegistry();
    registry.activate(definition({ pluginId: runtime.pluginId, native: [runtime.capabilityId], provider: fixture.provider }));

    const [first, second] = await Promise.all([registry.acquire(request("one")), registry.acquire(request("two"))]);
    expect(first?.upstream).toBe(second?.upstream);
    expect(fixture.acquired()).toBe(1);
    expect(registry.snapshots()[0]?.leaseCount).toBe(2);
    expect(registry.snapshots()[0]?.bindingLeases).toEqual([
      { bindingId: "one", leaseCount: 1 },
      { bindingId: "two", leaseCount: 1 },
    ]);
    await first?.release();
    expect(fixture.released()).toBe(0);
    await second?.release();
    expect(fixture.released()).toBe(1);

    const isolatedOne = await registry.acquire(request("one", "one"));
    const isolatedTwo = await registry.acquire(request("two", "two"));
    expect(fixture.acquired()).toBe(3);
    await isolatedOne?.release();
    expect(fixture.released()).toBe(2);
    await isolatedTwo?.release();
    expect(fixture.released()).toBe(3);
  });

  it("rolls back failed acquisition and rejects malformed or changing upstreams", async () => {
    let attempts = 0;
    let released = 0;
    const registry = new ManagedWebAppRegistry();
    registry.activate(
      definition({
        pluginId: runtime.pluginId,
        native: [runtime.capabilityId],
        provider: {
          capabilityId: "web",
          instanceKey: () => "shared",
          async acquire() {
            attempts += 1;
            const upstream = attempts === 1 ? "https://example.com" : "http://127.0.0.1:4124";
            return {
              upstream,
              async waitUntilReady() {},
              health: () => "ready",
              onHealthChange: () => () => {},
              onExit: () => () => {},
              release: async () => {
                released += 1;
              },
            };
          },
        },
      }),
    );
    await expect(registry.acquire(request("one"))).rejects.toThrow("opaque 127.0.0.1 HTTP origin");
    expect(released).toBe(1);
    expect(registry.snapshots()).toEqual([
      expect.objectContaining({
        instanceKey: "shared",
        health: "error",
        diagnostic: "Managed Web App upstream must be an opaque 127.0.0.1 HTTP origin",
        bindingIds: ["one"],
        upstream: null,
        leaseCount: 0,
      }),
    ]);
    const lease = await registry.acquire(request("two"));
    expect(attempts).toBe(2);
    expect(registry.snapshots()).toEqual([
      expect.objectContaining({
        instanceKey: "shared",
        health: "ready",
        diagnostic: null,
        bindingIds: ["two"],
        upstream: "http://127.0.0.1:4124",
        leaseCount: 1,
      }),
    ]);
    await lease?.release();

    const changing = provider();
    const stableRegistry = new ManagedWebAppRegistry();
    stableRegistry.activate(definition({ pluginId: runtime.pluginId, native: [runtime.capabilityId], provider: changing.provider }));
    const stableLease = await stableRegistry.acquire(request("one"));
    changing.setUpstream("http://127.0.0.1:4999");
    expect(() => stableLease?.health()).toThrow("upstream changed");
  });

  it("observes App exit independently and rejects every stale-generation lease operation", async () => {
    const fixture = provider();
    const registry = new ManagedWebAppRegistry();
    registry.activate(definition({ pluginId: runtime.pluginId, generation: 1, native: [runtime.capabilityId], provider: fixture.provider }));
    const lease = await registry.acquire(request("one"));
    const runtimeHealth = "ready";
    fixture.exit(new Error("provider failed"));
    expect(lease?.health()).toBe("error");
    expect(runtimeHealth).toBe("ready");

    const generation = {
      pluginId: runtime.pluginId,
      capabilityId: "web",
      activationGeneration: 1,
    };
    registry.fence(generation);
    expect(() => lease?.health()).toThrow("stale Activation Generation 1");
    await expect(lease?.release()).resolves.toBeUndefined();
    expect(fixture.released()).toBe(1);
    await expect(registry.remove(generation)).resolves.toBeUndefined();

    const next = provider();
    registry.activate(definition({ pluginId: runtime.pluginId, generation: 2, native: [runtime.capabilityId], provider: next.provider }));
    expect(registry.select(runtime)).toMatchObject({ activationGeneration: 2 });
  });
});
