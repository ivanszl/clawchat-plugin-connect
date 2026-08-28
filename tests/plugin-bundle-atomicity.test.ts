import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { createAgentBinding } from "../src/plugin/binding";
import { ConnectPluginHost } from "../src/plugin/host";
import type { ConnectPluginBundleV1, ConnectPluginManifestV1 } from "../src/plugin/sdk";
import {
  commitStagedPlugin,
  installLocalPlugin,
  listInstalledPlugins,
  MAX_PLUGIN_CONFIGURATION_BYTES,
  readConnectPluginBundle,
  stagePluginBundle,
} from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

const fixturePath = join(import.meta.dir, "fixtures", "reference-runtime.connect-plugin");

type MutableBundle = ConnectPluginBundleV1 & { manifest: ConnectPluginManifestV1 };
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

async function bundleFixture(
  directory: string,
  name: string,
  mutate: (bundle: MutableBundle) => void,
  source?: string,
): Promise<string> {
  const bundle = JSON.parse(await readFile(fixturePath, "utf8")) as MutableBundle;
  mutate(bundle);
  if (source !== undefined) {
    bundle.files["runtime.mjs"] = { encoding: "utf8", content: source };
    const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
    bundle.manifest.artifacts = bundle.manifest.artifacts.map((artifact) => ({ ...artifact, integrity }));
  }
  const path = join(directory, `${name}.connect-plugin`);
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return path;
}
async function installOfficialFixture(
  configPath: string,
  bundlePath = fixturePath,
  capabilityConfigurations: Record<string, Record<string, unknown>> = {
    "reference-exposure": { channel: "private" },
  },
) {
  const bundle = await readConnectPluginBundle(bundlePath);
  const staged = await stagePluginBundle({
    configPath,
    source: { type: "local", path: bundlePath },
    bundle,
    capabilityConfigurations,
  });
  return await commitStagedPlugin(configPath, staged, "install");
}

function runtimeBinding(pluginId: string, configuration: Record<string, unknown>) {
  return createAgentBinding({
    pluginId,
    capabilityId: "reference-runtime",
    configuration,
  });
}

function readGlobalEffects(key: string): string[] | undefined {
  return Reflect.get(globalThis, key) as string[] | undefined;
}

interface ReferenceManagedWebAppFixture {
  readonly contextKeys: string[];
  readonly contextFrozen: boolean;
  readonly configurationFrozen: boolean;
  readonly runtimeFrozen: boolean;
  readonly acquireKeys: string[];
}

function referenceManagedWebApp(): ReferenceManagedWebAppFixture {
  const app = Reflect.get(globalThis, "__connectReferenceManagedWebApp") as ReferenceManagedWebAppFixture | undefined;
  if (!app) throw new Error("Reference Managed Web App fixture is not active");
  return app;
}

describe("atomic multi-capability Plugin Bundles", () => {
  it("atomically activates Runtime and Managed Web App providers from one Bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-multi-"));
    const configPath = join(directory, "config.json");
    Reflect.deleteProperty(globalThis, "__connectReferenceManagedWebApp");
    const source = `export default {
      activate(context) {
        context.hostCapabilities.get("runtime-provider").register({
          capabilityId: "reference-runtime",
          family: "reference",
          create() {
            return {
              modes: [],
              async start() { throw new Error("unused"); }
            };
          }
        });
        context.hostCapabilities.get("managed-web-app-provider").register({
          capabilityId: "reference-web",
          instanceKey(activation) {
            globalThis.__connectReferenceManagedWebApp = {
              contextKeys: Object.keys(activation).sort(),
              contextFrozen: Object.isFrozen(activation),
              configurationFrozen: Object.isFrozen(activation.configuration),
              runtimeFrozen: Object.isFrozen(activation.runtime),
              acquireKeys: []
            };
            return activation.bindingId;
          },
          async acquire(activation) {
            globalThis.__connectReferenceManagedWebApp.acquireKeys = Object.keys(activation).sort();
            return {
              upstream: "http://127.0.0.1:47823",
              async waitUntilReady() {},
              health() { return "ready"; },
              onHealthChange() { return () => {}; },
              onExit() { return () => {}; },
              async release() {}
            };
          }
        });
      }
    };`;
    const bundlePath = await bundleFixture(
      directory,
      "runtime-with-managed-web-app",
      (bundle) => {
        bundle.manifest.dependencies = [
          required(bundle.manifest.dependencies[0], "fixture Runtime dependency"),
          {
            type: "host",
            id: "managed-web-app-provider",
            interfaceVersion: "1",
          },
        ];
        bundle.manifest.capabilities = [
          required(bundle.manifest.capabilities[0], "fixture Runtime capability"),
          {
            id: "reference-web",
            type: "managed-web-app",
            interfaceVersion: "1",
            configurationSchema: {
              type: "object",
              properties: { channel: { type: "string", enum: ["private"] } },
              additionalProperties: false,
            },
            displayName: "Reference Web",
            description: "Reference browser interface",
            nativeRuntimeCapabilityIds: ["reference-runtime"],
            compatibleRuntimes: [],
          },
        ];
      },
      source,
    );
    const installed = await installOfficialFixture(configPath, bundlePath, {
      "reference-web": { channel: "private" },
    });
    expect(installed.manifest.capabilities.map(({ id, type }) => [id, type])).toEqual([
      ["reference-runtime", "runtime"],
      ["reference-web", "managed-web-app"],
    ]);
    expect(installed.capabilityConfigurations).toEqual({ "reference-web": { channel: "private" } });

    const diagnostics: string[] = [];
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, (_pluginId, error) => diagnostics.push(String(error)));
    await host.activateInstalled();
    await expect(registry.prepare(runtimeBinding(installed.pluginId, { instance: "alpha" }))).resolves.toBeUndefined();
    await expect(registry.prepare(runtimeBinding(installed.pluginId, { instance: "beta" }))).resolves.toBeUndefined();
    expect(host.managedWebApps.select({ pluginId: installed.pluginId, capabilityId: "reference-runtime" })).toEqual({
      pluginId: installed.pluginId,
      capabilityId: "reference-web",
      activationGeneration: 1,
      kind: "native",
      displayName: "Reference Web",
      description: "Reference browser interface",
    });
    const lease = await host.managedWebApps.acquire({
      bindingId: "alpha",
      runtime: { pluginId: installed.pluginId, capabilityId: "reference-runtime" },
      runtimeConfiguration: { instance: "alpha" },
    });
    expect(lease).toMatchObject({
      instanceKey: "alpha",
      upstream: "http://127.0.0.1:47823",
      selection: {
        pluginId: installed.pluginId,
        capabilityId: "reference-web",
        activationGeneration: 1,
      },
    });
    expect(referenceManagedWebApp()).toEqual({
      contextKeys: [
        "activationGeneration",
        "bindingId",
        "capabilityId",
        "configuration",
        "installationConfiguration",
        "pluginId",
        "runtime",
        "runtimeConfiguration",
      ],
      contextFrozen: true,
      configurationFrozen: true,
      runtimeFrozen: true,
      acquireKeys: [
        "activationGeneration",
        "bindingId",
        "capabilityId",
        "configuration",
        "installationConfiguration",
        "instanceKey",
        "pluginId",
        "runtime",
        "runtimeConfiguration",
      ],
    });
    await lease?.release();
    expect(diagnostics).toEqual([]);
    expect(host.activePluginIds()).toEqual([installed.pluginId]);

    await host.close();
    await expect(registry.prepare(runtimeBinding(installed.pluginId, { instance: "gamma" }))).rejects.toThrow(
      `Runtime Plugin capability ${installed.pluginId}/reference-runtime is not active`,
    );
    expect(host.managedWebApps.select({ pluginId: installed.pluginId, capabilityId: "reference-runtime" })).toBeNull();
    Reflect.deleteProperty(globalThis, "__connectReferenceManagedWebApp");
  });

  it("installs a local Bundle that declares an Exposure without official admission metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-public-exposure-"));
    const installed = await installLocalPlugin({
      configPath: join(directory, "config.json"),
      bundlePath: fixturePath,
      capabilityConfigurations: { "reference-exposure": { channel: "private" } },
    });

    expect(installed.manifest.capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "reference-exposure", type: "exposure" })]),
    );
  });

  it("never grants Liveware-only services to an arbitrary Exposure named liveware", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-liveware-spoof-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    await saveConfig(config, configPath);
    const source = `export default { activate(context) { context.hostCapabilities.get("exposure-provider").register({ capabilityId: "liveware", activate(activation) { globalThis.__connectSpoofedLivewareActivationKeys = Object.keys(activation).sort(); } }); } };`;
    const bundlePath = await bundleFixture(
      directory,
      "liveware-spoof",
      (bundle) => {
        bundle.manifest.pluginId = "test.liveware-spoof";
        bundle.manifest.dependencies = [required(bundle.manifest.dependencies[1], "fixture Exposure dependency")];
        bundle.manifest.capabilities = [
          {
            id: "liveware",
            type: "exposure",
            interfaceVersion: "1",
            configurationSchema: { type: "object", additionalProperties: false },
          },
        ];
      },
      source,
    );
    await installLocalPlugin({ configPath, bundlePath });
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
    });
    await host.activateInstalled();
    await host.activateOptionalSurfaces([]);

    expect(Reflect.get(globalThis, "__connectSpoofedLivewareActivationKeys")).toEqual([
      "activationGeneration",
      "configuration",
    ]);
    Reflect.deleteProperty(globalThis, "__connectSpoofedLivewareActivationKeys");
    await host.close();
    await stateStore.close();
  });

  it("provides declared installation-scoped Durable State to a public Exposure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-exposure-state-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    await saveConfig(config, configPath);
    const source = `export default { activate(context) { context.hostCapabilities.get("exposure-provider").register({ capabilityId: "stateful-exposure", async activate(activation) { globalThis.__connectExposureStateActivationKeys = Object.keys(activation).sort(); globalThis.__connectExposureStateRecord = await activation.durableState.compareAndSwap(null, { count: 1 }); } }); } };`;
    const bundlePath = await bundleFixture(
      directory,
      "stateful-exposure",
      (bundle) => {
        bundle.manifest.pluginId = "test.stateful-exposure";
        bundle.manifest.dependencies = [
          required(bundle.manifest.dependencies[1], "fixture Exposure dependency"),
          { type: "host", id: "durable-state", interfaceVersion: "1" },
        ];
        bundle.manifest.capabilities = [
          {
            id: "stateful-exposure",
            type: "exposure",
            interfaceVersion: "1",
            configurationSchema: { type: "object", additionalProperties: false },
            durableState: {
              schemaVersion: 1,
              lifetime: "installation",
              schema: {
                type: "object",
                properties: { count: { type: "integer" } },
                required: ["count"],
                additionalProperties: false,
              },
              migrations: [],
            },
          },
        ];
      },
      source,
    );
    await installLocalPlugin({ configPath, bundlePath });
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
    });
    await host.activateInstalled();
    await host.activateOptionalSurfaces([]);

    expect(Reflect.get(globalThis, "__connectExposureStateActivationKeys")).toEqual([
      "activationGeneration",
      "configuration",
      "durableState",
    ]);
    expect(Reflect.get(globalThis, "__connectExposureStateRecord")).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      value: { count: 1 },
    });
    Reflect.deleteProperty(globalThis, "__connectExposureStateActivationKeys");
    Reflect.deleteProperty(globalThis, "__connectExposureStateRecord");
    await host.close();
    await stateStore.close();
  });

  it("rejects duplicate Plugin identities without replacing the locked Bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-duplicate-id-"));
    const configPath = join(directory, "config.json");
    await installOfficialFixture(configPath);
    await expect(installOfficialFixture(configPath)).rejects.toThrow("Plugin identity is already installed");
    await expect(listInstalledPlugins(configPath)).resolves.toHaveLength(1);
  });

  const manifestRejections: Array<{
    name: string;
    mutate(bundle: MutableBundle): void;
    message: string;
    target?: string;
  }> = [
    {
      name: "duplicate-capability",
      mutate: (bundle) =>
        bundle.manifest.capabilities.push(
          structuredClone(required(bundle.manifest.capabilities[0], "fixture Runtime capability")),
        ),
      message: "Duplicate Plugin capability ID",
    },
    {
      name: "plugin-dependency",
      mutate: (bundle) => {
        bundle.manifest.dependencies = [{ type: "plugin", id: "other", interfaceVersion: "1" } as never];
      },
      message: "user-plugin dependencies are prohibited",
    },
    {
      name: "unsupported-capability",
      mutate: (bundle) => {
        bundle.manifest.capabilities[0] = {
          ...required(bundle.manifest.capabilities[0], "fixture Runtime capability"),
          type: "persistence",
        } as never;
      },
      message: "unsupported capability type",
    },
    {
      name: "unsupported-plugin-interface",
      mutate: (bundle) => {
        bundle.manifest.interfaceVersion = "2" as never;
      },
      message: "Unsupported Connect Plugin interface version",
    },
    {
      name: "unsupported-capability-interface",
      mutate: (bundle) => {
        required(bundle.manifest.capabilities[0], "fixture Runtime capability").interfaceVersion = "2" as never;
      },
      message: "unsupported runtime capability interface version",
    },
    {
      name: "unsupported-host-capability",
      mutate: (bundle) => {
        required(bundle.manifest.dependencies[0], "fixture Host Capability dependency").id = "persistence" as never;
      },
      message: "unsupported Host Capability",
    },
    {
      name: "malformed-schema",
      mutate: (bundle) => {
        bundle.manifest.installationConfigurationSchema = { type: "not-a-json-schema-type" };
      },
      message: "not a valid JSON Schema",
    },
    {
      name: "unsupported-schema-keyword",
      mutate: (bundle) => {
        bundle.manifest.installationConfigurationSchema = {
          type: "object",
          additionalProperties: false,
          properties: { nested: { $ref: "#/$defs/nested" } },
          $defs: { nested: { type: "string" } },
        };
      },
      message: "unsupported JSON Schema keyword",
    },
    {
      name: "open-nested-object-schema",
      mutate: (bundle) => {
        bundle.manifest.installationConfigurationSchema = {
          type: "object",
          additionalProperties: false,
          properties: { nested: { type: "object", properties: {} } },
        };
      },
      message: "additionalProperties: false",
    },
    {
      name: "secret-shaped-configuration",
      mutate: (bundle) => {
        bundle.manifest.installationConfigurationSchema = {
          type: "object",
          additionalProperties: false,
          properties: { accessToken: { type: "string" } },
        };
      },
      message: "secret-free",
    },
    {
      name: "unsupported-client-extension-slot",
      mutate: (bundle) => {
        bundle.manifest.capabilities.push({
          id: "unsupported-slot",
          type: "client-extension",
          managedWebApp: { pluginId: "clawling.web.connect-client", capabilityId: "connect-client" },
          interfaceVersion: "1",
          configurationSchema: { type: "object", additionalProperties: false },
          browser: {
            entry: "client.mjs",
            integrity: required(bundle.manifest.artifacts[0], "fixture artifact").integrity,
            styles: [],
            slots: [{ id: "unknown.slot" as never, interfaceVersion: "1", priority: 10 }],
          },
        });
      },
      message: "unsupported Client Extension slot unknown.slot",
    },
    {
      name: "unsupported-target",
      mutate: () => undefined,
      message: "does not support Connect target test-unsupported",
      target: "test-unsupported",
    },
  ];

  for (const rejection of manifestRejections) {
    it(`rejects ${rejection.name} before activation`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `connect-plugin-${rejection.name}-`));
      const bundlePath = await bundleFixture(directory, rejection.name, rejection.mutate);
      await expect(
        installLocalPlugin({ configPath: join(directory, "config.json"), bundlePath, target: rejection.target }),
      ).rejects.toThrow(rejection.message);
    });
  }

  it("keeps defaults as suggestions and enforces the exact serialized configuration limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-config-contract-"));
    const bundlePath = await bundleFixture(directory, "configuration-contract", (bundle) => {
      bundle.manifest.dependencies = bundle.manifest.dependencies.filter(({ id }) => id === "runtime-provider");
      bundle.manifest.capabilities = bundle.manifest.capabilities.filter(({ type }) => type === "runtime");
      bundle.manifest.installationConfigurationSchema = {
        type: "object",
        additionalProperties: false,
        properties: {
          payload: { type: "string" },
          suggestion: { type: "string", default: "suggested-only" },
        },
      };
    });
    const empty = await installLocalPlugin({
      configPath: join(directory, "empty", "config.json"),
      bundlePath,
      installationConfiguration: {},
    });
    expect(empty.installationConfiguration).toEqual({});

    const envelopeBytes = Buffer.byteLength(JSON.stringify({ payload: "" }));
    const exact = { payload: "x".repeat(MAX_PLUGIN_CONFIGURATION_BYTES - envelopeBytes) };
    await expect(
      installLocalPlugin({
        configPath: join(directory, "exact", "config.json"),
        bundlePath,
        installationConfiguration: exact,
      }),
    ).resolves.toMatchObject({ installationConfiguration: exact });
    await expect(
      installLocalPlugin({
        configPath: join(directory, "overflow", "config.json"),
        bundlePath,
        installationConfiguration: { payload: `${exact.payload}x` },
      }),
    ).rejects.toThrow("exceeds 256 KiB");
  });

  it("rejects installation and Exposure values against their independent schemas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-invalid-config-"));
    const installationBundle = await bundleFixture(directory, "installation-schema", (bundle) => {
      bundle.manifest.installationConfigurationSchema = {
        type: "object",
        additionalProperties: false,
        required: ["endpoint"],
        properties: { endpoint: { type: "string", pattern: "^https?://" } },
      };
    });
    await expect(
      installLocalPlugin({
        configPath: join(directory, "installation.json"),
        bundlePath: installationBundle,
        installationConfiguration: { endpoint: "not a URI" },
      }),
    ).rejects.toThrow("installation configuration is invalid");
    await expect(
      installOfficialFixture(join(directory, "exposure.json"), fixturePath, {
        "reference-exposure": { channel: "public" },
      }),
    ).rejects.toThrow("Exposure configuration is invalid");
  });

  it("rejects undeclared Host Capability use and duplicate provider registration as one Bundle error", async () => {
    const cases = [
      {
        name: "undeclared-host-use",
        source: `export default { activate(context) { context.hostCapabilities.get("exposure-provider"); } };`,
        message: "used undeclared Host Capability exposure-provider",
      },
      {
        name: "duplicate-provider",
        source: `export default { activate(context) { const host = context.hostCapabilities.get("runtime-provider"); const provider = { capabilityId: "reference-runtime", family: "reference", create() { return { modes: [], async start() { throw new Error("unused"); } }; } }; host.register(provider); host.register(provider); } };`,
        message: "registered capability reference-runtime more than once",
      },
    ];
    for (const scenario of cases) {
      const directory = await mkdtemp(join(tmpdir(), `connect-plugin-${scenario.name}-`));
      const configPath = join(directory, "config.json");
      const bundlePath = await bundleFixture(
        directory,
        scenario.name,
        (bundle) => {
          bundle.manifest.pluginId = `test.${scenario.name}`;
          bundle.manifest.dependencies = [
            required(bundle.manifest.dependencies[0], "fixture Host Capability dependency"),
          ];
          bundle.manifest.capabilities = [required(bundle.manifest.capabilities[0], "fixture Runtime capability")];
        },
        scenario.source,
      );
      await installLocalPlugin({ configPath, bundlePath });
      const diagnostics: string[] = [];
      const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), (_id, error) =>
        diagnostics.push(error instanceof Error ? error.message : String(error)),
      );
      await host.activateInstalled();
      expect(host.activePluginIds()).toEqual([]);
      expect(diagnostics).toEqual([expect.stringContaining(scenario.message)]);
      await expect(listInstalledPlugins(configPath)).resolves.toEqual([
        expect.objectContaining({ status: "error", error: expect.stringContaining(scenario.message) }),
      ]);
    }
  });

  it("marks dependent Runtime Bindings unavailable when startup activation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-startup-failure-"));
    const configPath = join(directory, "config.json");
    const bundlePath = await bundleFixture(
      directory,
      "startup-failure",
      (bundle) => {
        bundle.manifest.pluginId = "test.startup-failure";
        bundle.manifest.dependencies = [
          required(bundle.manifest.dependencies[0], "fixture Host Capability dependency"),
        ];
        bundle.manifest.capabilities = [required(bundle.manifest.capabilities[0], "fixture Runtime capability")];
      },
      `export default { activate() { throw new Error("startup activation boom"); } };`,
    );
    await installLocalPlugin({ configPath, bundlePath });
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.agents.fixture = runtimeBinding("test.startup-failure", { instance: "fixture" });
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.initialize();
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });

    await host.activateInstalled();

    await expect(store.getRuntimeStatus("fixture")).resolves.toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: expect.stringContaining("startup activation boom"),
    });
    await host.close();
    await store.close();
  });

  it("rolls back every earlier contribution effect when a later contribution fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-rollback-"));
    const configPath = join(directory, "config.json");
    Reflect.deleteProperty(globalThis, "__connectAtomicEffects");
    const source = `export default { activate(context) {
      const runtime = context.hostCapabilities.get("runtime-provider");
      const exposure = context.hostCapabilities.get("exposure-provider");
      runtime.register({ capabilityId: "reference-runtime", family: "reference", create() { return { modes: [], async start() { throw new Error("unused"); } }; } });
      exposure.register({ capabilityId: "first-exposure", async activate(activation) { if (!Object.isFrozen(activation)) throw new Error("first activation input was mutable"); const effects = (globalThis.__connectAtomicEffects ??= []); effects.push("activate:first"); return () => effects.push("dispose:first"); } });
      exposure.register({ capabilityId: "failing-exposure", async activate(activation) { if (!Object.isFrozen(activation)) throw new Error("second activation input was mutable"); throw new Error("second contribution failed"); } });
    } };`;
    const bundlePath = await bundleFixture(
      directory,
      "rollback",
      (bundle) => {
        bundle.manifest.pluginId = "test.atomic-rollback";
        const exposureSchema = required(
          bundle.manifest.capabilities[1],
          "fixture Exposure capability",
        ).configurationSchema;
        bundle.manifest.capabilities = [
          required(bundle.manifest.capabilities[0], "fixture Runtime capability"),
          { id: "first-exposure", type: "exposure", interfaceVersion: "1", configurationSchema: exposureSchema },
          { id: "failing-exposure", type: "exposure", interfaceVersion: "1", configurationSchema: exposureSchema },
        ];
      },
      source,
    );
    const installed = await installOfficialFixture(configPath, bundlePath, {
      "first-exposure": {},
      "failing-exposure": {},
    });
    const diagnostics: string[] = [];
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, (_id, error) =>
      diagnostics.push(error instanceof Error ? error.message : String(error)),
    );
    await host.activateInstalled();
    await host.activateOptionalSurfaces([]);

    expect(host.activePluginIds()).toEqual([]);
    expect(readGlobalEffects("__connectAtomicEffects")).toEqual(["activate:first", "dispose:first"]);
    await expect(registry.prepare(runtimeBinding(installed.pluginId, {}))).rejects.toThrow(
      `Runtime Plugin capability ${installed.pluginId}/reference-runtime is not active`,
    );
    expect(diagnostics).toEqual(["second contribution failed"]);
    await expect(listInstalledPlugins(configPath)).resolves.toEqual([
      expect.objectContaining({ pluginId: installed.pluginId, status: "error", error: "second contribution failed" }),
    ]);
    await host.close();
  });

  it("rejects invalid per-Binding Runtime configuration before invoking Plugin code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-binding-schema-"));
    const configPath = join(directory, "config.json");
    const globals = globalThis as typeof globalThis & { __connectRuntimeCreates?: number };
    delete globals.__connectRuntimeCreates;
    const source = `export default { activate(context) { context.hostCapabilities.get("runtime-provider").register({ capabilityId: "reference-runtime", family: "reference", create() { globalThis.__connectRuntimeCreates = (globalThis.__connectRuntimeCreates ?? 0) + 1; return { modes: [], async start() { throw new Error("unused"); } }; } }); } };`;
    const bundlePath = await bundleFixture(
      directory,
      "binding-schema",
      (bundle) => {
        bundle.manifest.pluginId = "test.binding-schema";
        bundle.manifest.dependencies = [
          required(bundle.manifest.dependencies[0], "fixture Host Capability dependency"),
        ];
        bundle.manifest.capabilities = [required(bundle.manifest.capabilities[0], "fixture Runtime capability")];
      },
      source,
    );
    const installed = await installLocalPlugin({ configPath, bundlePath });
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, () => undefined);
    await host.activateInstalled();
    await expect(registry.prepare(runtimeBinding(installed.pluginId, { instance: 42 }))).rejects.toThrow(
      "Agent Binding Runtime configuration",
    );
    expect(globals.__connectRuntimeCreates).toBeUndefined();
    await host.close();
  });
});
