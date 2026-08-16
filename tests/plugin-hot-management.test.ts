import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { createAgentBinding, identifyAgentBinding } from "../src/plugin/binding";
import { ConnectPluginHost, MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS } from "../src/plugin/host";
import type { ManagedConnectPluginBundleV1 } from "../src/plugin/official-sdk";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../src/plugin/sdk";
import {
  currentConnectPluginTarget,
  installPluginBundle,
  listInstalledPlugins,
  managedPluginUploadRoot,
  pluginInstallationPaths,
  revalidateInstalledPlugin,
  stagePluginBundle,
} from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { SessionQueue } from "../src/runtime/session-queue";
import { SessionTurnExecutor } from "../src/runtime/session-turn-executor";
import type { TurnTarget } from "../src/workspaces/session-continuity";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

function hotBundle(pluginId: string, version: string, failExposure = false): ManagedConnectPluginBundleV1 {
  const source = `
const log = globalThis.__connectHotPluginLog ??= [];
export default {
  async activate(context) {
    const runtime = context.hostCapabilities.get("runtime-provider");
    const exposure = context.hostCapabilities.get("exposure-provider");
    runtime.register({
      capabilityId: "runtime",
      family: "hot",
      create() {
        return {
          modes: ["managed"],
          async prepare() { log.push("prepare:${pluginId}@${version}"); },
          async start() { throw new Error("not exercised"); },
          async close() { log.push("runtime-close:${pluginId}@${version}"); }
        };
      }
    });
    exposure.register({
      capabilityId: "exposure",
      async activate() {
        log.push("exposure-activate:${pluginId}@${version}");
        return async () => { log.push("exposure-dispose:${pluginId}@${version}"); };
      }
    });
    ${failExposure ? `throw new Error("candidate exposure failed");` : ""}
    return async () => { log.push("bundle-dispose:${pluginId}@${version}"); };
  }
};
`.trim();
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId,
      version,
      dependencies: [
        { type: "host", id: "runtime-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
        { type: "host", id: "exposure-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "runtime",
          type: "runtime",
          family: "hot",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
        {
          id: "exposure",
          type: "exposure",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}

function assetBundle(
  pluginId: string,
  version: string,
  asset: string,
  auxiliary = "auxiliary-v1",
  failActivation = false,
): ManagedConnectPluginBundleV1 {
  const source = `
import { value } from "./asset.mjs";
export default {
  activate(context) {
    (globalThis.__connectHotAssetLog ??= []).push(value);
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "asset",
      create() {
        return {
          modes: [],
          async start() { throw new Error("not exercised"); }
        };
      }
    });
    ${failActivation ? 'throw new Error("candidate activation failed");' : ""}
  }
};`.trim();
  const auxiliarySource = `export const auxiliary = ${JSON.stringify(auxiliary)};`;
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId,
      version,
      dependencies: [
        { type: "host", id: "runtime-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "runtime",
          type: "runtime",
          family: "asset",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: {
      "plugin.mjs": { encoding: "utf8", content: source },
      "asset.mjs": { encoding: "utf8", content: `export const value = ${JSON.stringify(asset)};` },
      "auxiliary.mjs": { encoding: "utf8", content: auxiliarySource },
    },
  };
}

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeyOrder(child)]),
  );
}
function officialCapabilityGrants(bundle: ManagedConnectPluginBundleV1) {
  const artifact = bundle.manifest.artifacts.find(({ target }) => target === currentConnectPluginTarget());
  if (!artifact) throw new Error(`Bundle ${bundle.manifest.pluginId} has no current target artifact`);
  return bundle.manifest.capabilities
    .filter(({ type }) => type === "exposure")
    .map(({ id }) => ({ type: "exposure" as const, capabilityId: id, artifactIntegrity: artifact.integrity }));
}

async function installOfficialBundle(host: ConnectPluginHost, sourcePath: string) {
  const bundle = JSON.parse(await readFile(sourcePath, "utf8")) as ManagedConnectPluginBundleV1;
  return await host.install({
    source: `local:${sourcePath}`,
    officialCapabilityGrants: officialCapabilityGrants(bundle),
  });
}
async function updateOfficialBundle(host: ConnectPluginHost, pluginId: string, sourcePath: string) {
  const bundle = JSON.parse(await readFile(sourcePath, "utf8")) as ManagedConnectPluginBundleV1;
  return await host.update(pluginId, {
    officialCapabilityGrants: officialCapabilityGrants(bundle),
  });
}
interface LifecycleBundleOptions {
  runtimeSchema?: Record<string, unknown>;
  includeRuntime?: boolean;
  failAdapterClose?: boolean;
  exposureFailure?: boolean;
  captureExposureClient?: boolean;
}

function lifecycleBundle(
  pluginId: string,
  version: string,
  options: LifecycleBundleOptions = {},
): ManagedConnectPluginBundleV1 {
  const includeRuntime = options.includeRuntime ?? true;
  const source = `
const log = globalThis.__connectPluginLifecycleLog ??= [];
export default {
  async activate(context) {
    log.push("bundle-activate:${version}:generation-" + context.activationGeneration);
    ${
      includeRuntime
        ? `context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "hot",
      create() {
        log.push("adapter-create:${version}");
        return {
          modes: [],
          async prepare() { log.push("adapter-prepare:${version}"); },
          async start() {
            log.push("session-start:${version}");
            return {
              async *prompt() {
                log.push("session-prompt:${version}");
                const gate = globalThis.__connectPluginTurnGate;
                if (gate) {
                  gate.started();
                  await gate.wait;
                }
                log.push("session-prompt-complete:${version}");
              },
              async close() { log.push("session-close:${version}"); }
            };
          },
          async close() {
            log.push("adapter-close:${version}");
            ${options.failAdapterClose ? `throw new Error("v1 adapter disposal failed");` : ""}
          }
        };
      }
    });`
        : `context.hostCapabilities.get("exposure-provider").register({
      capabilityId: "replacement-exposure",
      async activate(activation) {
        log.push("exposure-activate:${version}:generation-" + activation.activationGeneration);
        return async () => { log.push("exposure-dispose:${version}"); };
      }
    });`
    }
    ${
      includeRuntime && options.exposureFailure !== undefined
        ? `context.hostCapabilities.get("exposure-provider").register({
      capabilityId: "exposure",
      async activate(activation) {
        ${options.captureExposureClient ? `(globalThis.__connectPluginExposureClients ??= []).push(activation.client);` : ""}
        log.push("exposure-activate:${version}:generation-" + activation.activationGeneration);
        ${options.exposureFailure ? `throw new Error("candidate exposure activation failed");` : ""}
        return async () => { log.push("exposure-dispose:${version}"); };
      }
    });`
        : ""
    }
    return async () => { log.push("bundle-dispose:${version}"); };
  }
};`.trim();
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId,
      version,
      dependencies: [
        {
          type: "host",
          id: includeRuntime ? "runtime-provider" : "exposure-provider",
          interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
        },
        ...(includeRuntime && options.exposureFailure !== undefined
          ? [
              {
                type: "host" as const,
                id: "exposure-provider" as const,
                interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
              },
            ]
          : []),
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        ...(includeRuntime
          ? [
              {
                id: "runtime",
                type: "runtime" as const,
                family: "hot",
                interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
                configurationSchema: options.runtimeSchema ?? {
                  type: "object",
                  additionalProperties: false,
                  properties: { instance: { type: "string" } },
                },
              },
            ]
          : [
              {
                id: "replacement-exposure",
                type: "exposure" as const,
                interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
                configurationSchema: { type: "object", additionalProperties: false },
              },
            ]),
        ...(includeRuntime && options.exposureFailure !== undefined
          ? [
              {
                id: "exposure",
                type: "exposure" as const,
                interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
                configurationSchema: { type: "object", additionalProperties: false },
              },
            ]
          : []),
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}
function durableStateBundle(
  pluginId: string,
  version: string,
  schemaVersion: 1 | 2,
  migrationFailure = false,
): ManagedConnectPluginBundleV1 {
  const source = `
export default {
  migrateDurableState(migration) {
    if (migration.fromSchemaVersion !== 1 || migration.toSchemaVersion !== 2) {
      throw new Error("unexpected Durable State migration");
    }
    ${migrationFailure ? 'throw new Error("candidate migration failed");' : 'return { count: migration.value.count, label: "migrated" };'}
  },
  activate(context) {
    context.hostCapabilities.get("durable-state");
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "stateful",
      create(configuration, instance) {
        globalThis.__connectDurableStateTest = instance.durableState;
        return {
          modes: [],
          async start() { throw new Error("not exercised"); }
        };
      }
    });
  }
};`.trim();
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  const stateSchema =
    schemaVersion === 1
      ? {
          type: "object",
          additionalProperties: false,
          properties: { count: { type: "integer" } },
          required: ["count"],
        }
      : {
          type: "object",
          additionalProperties: false,
          properties: { count: { type: "integer" }, label: { type: "string" } },
          required: ["count", "label"],
        };
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId,
      version,
      dependencies: [
        { type: "host", id: "runtime-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
        { type: "host", id: "durable-state", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "runtime",
          type: "runtime",
          family: "stateful",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
          durableState: {
            schemaVersion,
            lifetime: "binding",
            schema: stateSchema,
            migrations: schemaVersion === 1 ? [] : [{ from: 1, to: 2 }],
          },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}

async function writeBundle(directory: string, bundle: ManagedConnectPluginBundleV1): Promise<string> {
  const path = join(directory, `${bundle.manifest.pluginId}-${bundle.manifest.version}.connect-plugin`);
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return path;
}

function binding(pluginId: string, bindingId: string) {
  return identifyAgentBinding(
    createAgentBinding({
      pluginId,
      capabilityId: "runtime",
      configuration: {},
    }),
    bindingId,
  );
}

describe("hot Plugin management service", () => {
  it("keys immutable locations by complete canonical Bundle content and revalidates every installed file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-content-identity-"));
    const configPath = join(directory, "config.json");
    const source = { type: "local" as const, path: join(directory, "source.connect-plugin") };
    const original = assetBundle("test.content-identity", "1.0.0", "asset-v1");
    const reordered = reverseObjectKeyOrder(original) as ManagedConnectPluginBundleV1;

    const first = await stagePluginBundle({ configPath, source, bundle: original });
    const identical = await stagePluginBundle({ configPath, source, bundle: reordered });
    expect(identical.artifactRoot).toBe(first.artifactRoot);
    expect(identical.createdArtifact).toBe(false);
    await expect(revalidateInstalledPlugin(first.entry)).resolves.toBeUndefined();

    const changedAsset = await stagePluginBundle({
      configPath,
      source,
      bundle: assetBundle("test.content-identity", "1.0.0", "asset-v2"),
    });
    const changedAuxiliary = await stagePluginBundle({
      configPath,
      source,
      bundle: assetBundle("test.content-identity", "1.0.0", "asset-v1", "auxiliary-v2"),
    });
    expect(changedAsset.artifactRoot).not.toBe(first.artifactRoot);
    expect(changedAuxiliary.artifactRoot).not.toBe(first.artifactRoot);

    const assetPath = join(first.artifactRoot, "asset.mjs");
    const originalAsset = await readFile(assetPath);
    await writeFile(assetPath, "export const value = 'tampered';");
    await expect(revalidateInstalledPlugin(first.entry)).rejects.toThrow("content changed after installation");
    await writeFile(assetPath, originalAsset);
    await expect(revalidateInstalledPlugin(first.entry)).resolves.toBeUndefined();
    await rm(assetPath);
    await expect(revalidateInstalledPlugin(first.entry)).rejects.toThrow("content changed after installation");
  });

  it("activates a browser-only Client Extension Bundle without a server provider registration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-extension-host-"));
    const hostSource = "export default { activate() {} };";
    const browserSource = "export default { activate() {} };";
    const browserIntegrity = `sha256-${createHash("sha256").update(browserSource).digest("base64")}`;
    const bundle: ManagedConnectPluginBundleV1 = {
      format: CONNECT_PLUGIN_BUNDLE_FORMAT,
      manifest: {
        manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
        interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
        pluginId: "test.client-extension-only",
        version: "1.0.0",
        dependencies: [],
        installationConfigurationSchema: { type: "object", additionalProperties: false },
        capabilities: [
          {
            id: "client",
            type: "client-extension",
            interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
            configurationSchema: { type: "object", additionalProperties: false },
            browser: {
              entry: "browser/client.mjs",
              integrity: browserIntegrity,
              styles: [],
              slots: [{ id: "kernel.root.after", interfaceVersion: "1", priority: 0 }],
            },
          },
        ],
        artifacts: [
          {
            target: currentConnectPluginTarget(),
            entry: "plugin.mjs",
            integrity: `sha256-${createHash("sha256").update(hostSource).digest("base64")}`,
          },
        ],
      },
      files: {
        "plugin.mjs": { encoding: "utf8", content: hostSource },
        "browser/client.mjs": { encoding: "utf8", content: browserSource },
      },
    };
    const sourcePath = await writeBundle(directory, bundle);
    const host = new ConnectPluginHost(join(directory, "config.json"), new RuntimeAdapterRegistry([]), () => undefined);

    await expect(host.install({ source: `local:${sourcePath}` })).resolves.toMatchObject({
      pluginId: "test.client-extension-only",
      status: "active",
    });
    await host.close();
  });

  it("publishes a Client Extension generation only after its server contribution starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-extension-publication-"));
    const pluginId = "test.client-extension-publication";
    const browserSource = "export default { activate() {} };";
    const hostSource = `
export default {
  activate(context) {
    context.hostCapabilities.get("exposure-provider").register({
      capabilityId: "exposure",
      async activate() {
        const gate = globalThis.__connectClientExtensionPublicationGate;
        gate.started();
        await gate.wait;
        return async () => {};
      }
    });
  }
};`.trim();
    const bundle: ManagedConnectPluginBundleV1 = {
      format: CONNECT_PLUGIN_BUNDLE_FORMAT,
      manifest: {
        manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
        interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
        pluginId,
        version: "1.0.0",
        dependencies: [
          {
            type: "host",
            id: "exposure-provider",
            interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
          },
        ],
        installationConfigurationSchema: { type: "object", additionalProperties: false },
        capabilities: [
          {
            id: "client",
            type: "client-extension",
            interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
            configurationSchema: { type: "object", additionalProperties: false },
            browser: {
              entry: "browser/client.mjs",
              integrity: `sha256-${createHash("sha256").update(browserSource).digest("base64")}`,
              styles: [],
              slots: [{ id: "kernel.root.after", interfaceVersion: "1", priority: 0 }],
            },
          },
          {
            id: "exposure",
            type: "exposure",
            interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
            configurationSchema: { type: "object", additionalProperties: false },
          },
        ],
        artifacts: [
          {
            target: currentConnectPluginTarget(),
            entry: "plugin.mjs",
            integrity: `sha256-${createHash("sha256").update(hostSource).digest("base64")}`,
          },
        ],
      },
      files: {
        "plugin.mjs": { encoding: "utf8", content: hostSource },
        "browser/client.mjs": { encoding: "utf8", content: browserSource },
      },
    };
    const sourcePath = await writeBundle(directory, bundle);
    const host = new ConnectPluginHost(join(directory, "config.json"), new RuntimeAdapterRegistry([]), () => undefined);
    const unbindClient = await host.bindClientInterface({
      origin: "http://127.0.0.1:47890",
      async fetch() {
        return new Response(null, { status: 204 });
      },
    });
    let releaseStart: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    Reflect.set(globalThis, "__connectClientExtensionPublicationGate", { started: markStarted, wait });
    const installing = installOfficialBundle(host, sourcePath);
    try {
      await started;
      expect((await listInstalledPlugins(join(directory, "config.json")))[0]).toMatchObject({
        pluginId,
        status: "active",
      });
      expect(await host.listPublishedClientExtensions()).toEqual([]);
      releaseStart();
      await installing;
      expect(await host.listPublishedClientExtensions()).toEqual([
        expect.objectContaining({ pluginId, activationGeneration: 1 }),
      ]);
    } finally {
      releaseStart();
      await installing.catch(() => undefined);
      Reflect.deleteProperty(globalThis, "__connectClientExtensionPublicationGate");
      unbindClient();
      await host.close();
    }
  });

  it("retains authenticated official capability grants when an update resolves the same artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-official-grant-update-"));
    const pluginId = "test.official-grant-update";
    const bundle = hotBundle(pluginId, "1.0.0");
    const sourcePath = await writeBundle(directory, bundle);
    const host = new ConnectPluginHost(join(directory, "config.json"), new RuntimeAdapterRegistry([]), () => undefined);
    const installed = await installOfficialBundle(host, sourcePath);

    const updated = await host.update(pluginId);

    expect(updated.officialCapabilityGrants).toEqual(installed.officialCapabilityGrants);
    await host.close();
  });

  it("injects fenced Binding Durable State and migrates a staged copy during update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-durable-state-host-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.durable-state-host";
    const bindingId = "stateful-binding";
    const agentBinding = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: agentBinding },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const runtimeAdapters = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, runtimeAdapters, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    const sourcePath = join(directory, "stateful.connect-plugin");
    await writeFile(sourcePath, `${JSON.stringify(durableStateBundle(pluginId, "1.0.0", 1), null, 2)}\n`);
    await host.install({ source: `local:${sourcePath}` });
    await runtimeAdapters.prepare(agentBinding);
    const firstState = (
      globalThis as typeof globalThis & {
        __connectDurableStateTest: {
          read(): Promise<{ schemaVersion: number; revision: number; value: unknown } | null>;
          compareAndSwap(revision: number | null, value: Record<string, unknown>): Promise<unknown>;
        };
      }
    ).__connectDurableStateTest;
    await firstState.compareAndSwap(null, { count: 4 });

    await writeFile(sourcePath, `${JSON.stringify(durableStateBundle(pluginId, "2.0.0", 2), null, 2)}\n`);
    await host.update(pluginId);
    await runtimeAdapters.prepare(agentBinding);
    const secondState = (
      globalThis as typeof globalThis & {
        __connectDurableStateTest: {
          read(): Promise<{ schemaVersion: number; revision: number; value: unknown } | null>;
          compareAndSwap(revision: number | null, value: Record<string, unknown>): Promise<unknown>;
        };
      }
    ).__connectDurableStateTest;

    await expect(secondState.read()).resolves.toMatchObject({
      schemaVersion: 2,
      revision: 2,
      value: { count: 4, label: "migrated" },
    });
    await expect(firstState.compareAndSwap(1, { count: 5 })).rejects.toThrow("stale Activation Generation 1");
    await host.close();
    const restartedRuntimeAdapters = new RuntimeAdapterRegistry([]);
    const restartedHost = new ConnectPluginHost(configPath, restartedRuntimeAdapters, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    await restartedHost.activateInstalled();
    await restartedRuntimeAdapters.prepare(agentBinding);
    const restartedState = (
      globalThis as typeof globalThis & {
        __connectDurableStateTest: {
          read(): Promise<{ schemaVersion: number; revision: number; value: unknown } | null>;
        };
      }
    ).__connectDurableStateTest;
    await expect(restartedState.read()).resolves.toMatchObject({
      schemaVersion: 2,
      revision: 2,
      value: { count: 4, label: "migrated" },
    });
    await restartedHost.close();
    await store.close();
  });

  it("rejects an old-generation Client Exposure callback after update commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-exposure-generation-"));
    const configPath = join(directory, "config.json");
    const pluginId = "test.client-exposure-generation";
    const sourcePath = await writeBundle(
      directory,
      lifecycleBundle(pluginId, "1.0.0", { exposureFailure: false, captureExposureClient: true }),
    );
    Reflect.deleteProperty(globalThis, "__connectPluginExposureClients");
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined);
    let dispatches = 0;
    const unbindClient = await host.bindClientInterface({
      origin: "http://127.0.0.1:47823",
      fetch: async () => {
        dispatches += 1;
        return new Response(null, { status: 204 });
      },
    });
    await installOfficialBundle(host, sourcePath);
    const clients = Reflect.get(globalThis, "__connectPluginExposureClients") as Array<{
      fetch(request: Request): Promise<Response>;
    }>;
    const first = clients[0];
    if (!first) throw new Error("Expected first-generation Client Exposure");

    await writeFile(
      sourcePath,
      `${JSON.stringify(
        lifecycleBundle(pluginId, "2.0.0", { exposureFailure: false, captureExposureClient: true }),
        null,
        2,
      )}\n`,
    );
    await updateOfficialBundle(host, pluginId, sourcePath);
    const second = clients[1];
    if (!second) throw new Error("Expected second-generation Client Exposure");

    await expect(first.fetch(new Request("https://exposure.example/client/v1/bootstrap"))).rejects.toThrow(
      "stale Activation Generation 1",
    );
    await expect(second.fetch(new Request("https://exposure.example/client/v1/bootstrap"))).resolves.toMatchObject({
      status: 204,
    });
    expect(dispatches).toBe(1);

    unbindClient();
    await host.close();
    Reflect.deleteProperty(globalThis, "__connectPluginExposureClients");
  });

  it("keeps the selected generation and original Durable State when candidate migration fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-durable-state-migration-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.durable-state-migration-failure";
    const bindingId = "stateful-binding";
    const agentBinding = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: agentBinding },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const runtimeAdapters = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, runtimeAdapters, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    const sourcePath = join(directory, "stateful.connect-plugin");
    await writeFile(sourcePath, `${JSON.stringify(durableStateBundle(pluginId, "1.0.0", 1), null, 2)}\n`);
    const installed = await host.install({ source: `local:${sourcePath}` });
    await runtimeAdapters.prepare(agentBinding);
    const state = (
      globalThis as typeof globalThis & {
        __connectDurableStateTest: {
          read(): Promise<{ schemaVersion: number; revision: number; value: unknown } | null>;
          compareAndSwap(revision: number | null, value: Record<string, unknown>): Promise<unknown>;
        };
      }
    ).__connectDurableStateTest;
    await state.compareAndSwap(null, { count: 7 });

    await writeFile(sourcePath, `${JSON.stringify(durableStateBundle(pluginId, "2.0.0", 2, true), null, 2)}\n`);
    await expect(host.update(pluginId)).rejects.toThrow("candidate migration failed");

    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        version: "1.0.0",
        activationGeneration: installed.activationGeneration,
        status: "active",
      }),
    ]);
    await expect(state.read()).resolves.toMatchObject({
      schemaVersion: 1,
      revision: 1,
      value: { count: 7 },
    });
    await host.close();
    await store.close();
  });

  it("keeps the selected generation and original Durable State when staged-state persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-durable-state-commit-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.durable-state-commit-failure";
    const bindingId = "stateful-binding";
    const agentBinding = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: agentBinding },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const runtimeAdapters = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, runtimeAdapters, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    const sourcePath = join(directory, "stateful.connect-plugin");
    await writeFile(sourcePath, `${JSON.stringify(durableStateBundle(pluginId, "1.0.0", 1), null, 2)}\n`);
    await host.install({ source: `local:${sourcePath}` });
    await runtimeAdapters.prepare(agentBinding);
    const state = (
      globalThis as typeof globalThis & {
        __connectDurableStateTest: {
          read(): Promise<{ schemaVersion: number; revision: number; value: unknown } | null>;
          compareAndSwap(revision: number | null, value: Record<string, unknown>): Promise<unknown>;
        };
      }
    ).__connectDurableStateTest;
    await state.compareAndSwap(null, { count: 9 });
    await writeFile(sourcePath, `${JSON.stringify(durableStateBundle(pluginId, "2.0.0", 2), null, 2)}\n`);
    const commit = store.commitPluginDurableStateMigrations.bind(store);
    store.commitPluginDurableStateMigrations = async () => {
      throw new Error("staged state persistence failed");
    };

    await expect(host.update(pluginId)).rejects.toThrow("staged state persistence failed");
    store.commitPluginDurableStateMigrations = commit;

    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        version: "1.0.0",
        activationGeneration: 1,
        status: "active",
      }),
    ]);
    await expect(state.read()).resolves.toMatchObject({
      schemaVersion: 1,
      revision: 1,
      value: { count: 9 },
    });
    await host.close();
    await store.close();
  });

  it("serializes concurrent exact Binding provider upserts without dropping either successful change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-binding-upsert-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.binding-upsert";
    const config = { ...defaultConfig(), stateDbPath };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    const sourcePath = await writeBundle(directory, hotBundle(pluginId, "1.0.0"));
    await installOfficialBundle(host, sourcePath);

    const first = { ...binding(pluginId, "first-binding"), displayName: "First Binding" };
    const second = { ...binding(pluginId, "second-binding"), displayName: "Second Binding" };
    await Promise.all([
      host.upsertBindingProvider("first-binding", first),
      host.upsertBindingProvider("second-binding", second),
    ]);

    expect(config.defaultAgent).toBe("first-binding");
    expect(config.agents).toEqual({
      "first-binding": first,
      "second-binding": second,
    });
    await expect(loadConfig(configPath)).resolves.toMatchObject({
      defaultAgent: "first-binding",
      agents: {
        "first-binding": first,
        "second-binding": second,
      },
    });

    await host.close();
    await store.close();
  });

  it("keeps live, persisted, and Binding state unchanged when forced purge config persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-purge-save-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.purge-save-failure";
    const bindingId = "purge-save-failure-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    await store.setRuntimeAvailability(bindingId, "startup-unavailable", "fixture state");
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
      retireRuntimeBindings: async () => undefined,
    });
    const sourcePath = await writeBundle(directory, hotBundle(pluginId, "1.0.0"));
    await installOfficialBundle(host, sourcePath);
    const liveBefore = structuredClone(config);
    const persistedBefore = await readFile(configPath, "utf8");
    await rm(configPath);
    await mkdir(configPath);

    await expect(host.remove(pluginId, true)).rejects.toThrow();

    expect(config).toEqual(liveBefore);
    await rm(configPath, { recursive: true });
    await writeFile(configPath, persistedBefore);
    await expect(readFile(configPath, "utf8")).resolves.toBe(persistedBefore);
    await expect(store.getRuntimeStatus(bindingId)).resolves.toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: "fixture state",
    });

    await host.close();
    await store.close();
  });

  it("restores every not-yet-purged dependent Binding after forced removal fails so a retry can finish", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-purge-retry-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.purge-retry";
    const purgedBindingId = "a-purged-before-failure";
    const retryBindingId = "z-purge-retry-binding";
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: {
        [purgedBindingId]: binding(pluginId, purgedBindingId),
        [retryBindingId]: binding(pluginId, retryBindingId),
      },
      defaultAgent: retryBindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    await store.setRuntimeAvailability(purgedBindingId, "startup-unavailable", "first fixture state");
    await store.setRuntimeAvailability(retryBindingId, "startup-unavailable", "retry fixture state");
    const workspaces = new WorkspaceCatalog(store);
    const purgeBindingWorkspaces = workspaces.purgeBindingCatalog.bind(workspaces);
    let rejectRetryBindingPurge = true;
    workspaces.purgeBindingCatalog = async (bindingId) => {
      if (bindingId === retryBindingId && rejectRetryBindingPurge) {
        rejectRetryBindingPurge = false;
        throw new Error("dependent Binding purge failed");
      }
      await purgeBindingWorkspaces(bindingId);
    };
    const retiredBindings: string[][] = [];
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore: store,
      workspaces,
      retireRuntimeBindings: async (bindingIds) => {
        retiredBindings.push([...bindingIds]);
      },
    });
    const sourcePath = await writeBundle(directory, hotBundle(pluginId, "1.0.0"));
    const installed = await installOfficialBundle(host, sourcePath);

    await expect(host.remove(pluginId, true)).rejects.toThrow("dependent Binding purge failed");

    await expect(host.list()).resolves.toEqual([expect.objectContaining({ pluginId, status: "disabled" })]);
    await expect(readFile(installed.activeArtifact, "utf8")).resolves.toContain("test.purge-retry@1.0.0");
    expect(config.agents[purgedBindingId]).toBeUndefined();
    expect(config.agents[retryBindingId]).toEqual(binding(pluginId, retryBindingId));
    await expect(loadConfig(configPath)).resolves.toMatchObject({
      agents: { [retryBindingId]: binding(pluginId, retryBindingId) },
      defaultAgent: retryBindingId,
    });
    await expect(store.getRuntimeStatus(purgedBindingId)).resolves.toBeNull();
    await expect(store.getRuntimeStatus(retryBindingId)).resolves.toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: "retry fixture state",
    });

    await expect(host.remove(pluginId, true)).resolves.toMatchObject({ pluginId });

    expect(retiredBindings).toEqual([[purgedBindingId, retryBindingId], [retryBindingId]]);
    expect(config.agents[retryBindingId]).toBeUndefined();
    await expect(loadConfig(configPath)).resolves.toMatchObject({ agents: {}, defaultAgent: null });
    await expect(store.getRuntimeStatus(retryBindingId)).resolves.toBeNull();
    await expect(host.list()).resolves.toEqual([]);

    await host.close();
    await store.close();
  });

  it("hot-replaces identical entry bytes when a relative asset changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-plugin-asset-"));
    const configPath = join(directory, "config.json");
    const pluginId = "test.hot-asset";
    const sourcePath = await writeBundle(directory, assetBundle(pluginId, "1.0.0", "asset-v1"));
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined);
    Reflect.set(globalThis, "__connectHotAssetLog", []);

    const first = await host.install({ source: `local:${sourcePath}` });
    await writeFile(sourcePath, `${JSON.stringify(assetBundle(pluginId, "1.0.0", "asset-v2"), null, 2)}\n`);
    const second = await host.update(pluginId);

    expect(second.activeArtifact).not.toBe(first.activeArtifact);
    expect(second.integrity).toBe(first.integrity);
    expect(second.retainedVersions).toEqual([expect.objectContaining({ activeArtifact: first.activeArtifact })]);
    await expect(readFile(join(second.activeArtifact, "..", "asset.mjs"), "utf8")).resolves.toContain("asset-v2");
    expect(Reflect.get(globalThis, "__connectHotAssetLog")).toEqual(["asset-v1", "asset-v2"]);
    await host.close();
  });

  it("switches coherent Bundles, rolls failed candidates back, disables/enables, retains/selects, and force-purges exact Bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-plugin-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.hot-plugin";
    const bindingId = "hot-binding";
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: binding(pluginId, bindingId) },
      defaultAgent: bindingId,
    };
    const configuredBinding = config.agents[bindingId];
    if (!configuredBinding) throw new Error("Expected configured hot Plugin Binding");
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const workspaces = new WorkspaceCatalog(store);
    const registry = new RuntimeAdapterRegistry([]);
    const diagnostics: string[] = [];
    const retiredBindings: string[] = [];
    const host = new ConnectPluginHost(
      configPath,
      registry,
      (_id, error) => diagnostics.push(error instanceof Error ? error.message : String(error)),
      {
        config,
        stateStore: store,
        workspaces,
        retireRuntimeBindings: async (bindingIds) => {
          expect(config.agents[bindingId]).toBeDefined();
          retiredBindings.push(...bindingIds);
        },
      },
    );
    Reflect.set(globalThis, "__connectHotPluginLog", []);

    const v1 = hotBundle(pluginId, "1.0.0");
    const v2 = hotBundle(pluginId, "2.0.0");
    const v3 = hotBundle(pluginId, "3.0.0", true);
    const unrelated = hotBundle("test.unrelated-plugin", "1.0.0");
    const [sourcePath, unrelatedPath] = await Promise.all([
      writeBundle(directory, v1),
      writeBundle(directory, unrelated),
    ]);

    await expect(installOfficialBundle(host, sourcePath)).resolves.toMatchObject({
      version: "1.0.0",
      status: "active",
    });
    await registry.prepare(configuredBinding);
    await expect(installOfficialBundle(host, unrelatedPath)).resolves.toMatchObject({ status: "active" });
    await registry.prepare(binding("test.unrelated-plugin", "unrelated-binding"));

    await writeFile(sourcePath, `${JSON.stringify(v2, null, 2)}\n`);
    await expect(updateOfficialBundle(host, pluginId, sourcePath)).resolves.toMatchObject({
      version: "2.0.0",
      status: "active",
      retainedVersions: [{ version: "1.0.0" }],
    });
    await registry.prepare(configuredBinding);
    expect(Reflect.get(globalThis, "__connectHotPluginLog")).toContain("runtime-close:test.hot-plugin@1.0.0");

    await writeFile(sourcePath, `${JSON.stringify(v3, null, 2)}\n`);
    await expect(updateOfficialBundle(host, pluginId, sourcePath)).rejects.toThrow("candidate exposure failed");
    await expect(host.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId, version: "2.0.0", status: "active", error: "candidate exposure failed" }),
        expect.objectContaining({ pluginId: "test.unrelated-plugin", version: "1.0.0", status: "active" }),
      ]),
    );
    await registry.prepare(configuredBinding);
    await registry.prepare(binding("test.unrelated-plugin", "unrelated-binding"));
    const failedVersionRoot = join(
      pluginInstallationPaths(configPath).store,
      createHash("sha256").update(pluginId).digest("hex"),
      encodeURIComponent("3.0.0"),
    );
    await expect(readdir(failedVersionRoot).catch(() => [])).resolves.toEqual([]);

    await expect(host.disable(pluginId)).resolves.toMatchObject({ version: "2.0.0", status: "disabled" });
    await expect(registry.prepare(configuredBinding)).rejects.toThrow("is not active");
    await expect(store.getRuntimeStatus(bindingId)).resolves.toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: expect.stringContaining("disabled"),
    });
    await expect(host.enable(pluginId)).resolves.toMatchObject({ version: "2.0.0", status: "active" });
    await registry.prepare(configuredBinding);

    await expect(host.select(pluginId, "1.0.0")).resolves.toMatchObject({
      version: "1.0.0",
      status: "active",
      retainedVersions: [expect.objectContaining({ version: "2.0.0" })],
    });
    await expect(host.remove(pluginId)).rejects.toThrow("required by Agent Bindings");
    await expect(host.remove(pluginId, true)).resolves.toMatchObject({ pluginId, version: "1.0.0" });
    expect(retiredBindings).toEqual([bindingId]);
    expect(config.agents[bindingId]).toBeUndefined();
    await expect(store.getRuntimeStatus(bindingId)).resolves.toBeNull();
    await expect(host.list()).resolves.toEqual([expect.objectContaining({ pluginId: "test.unrelated-plugin" })]);
    expect(diagnostics).toContain("candidate exposure failed");

    await host.close();
    await store.close();
  });

  it("rejects removed or narrowed dependent Runtime capabilities before activating a candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-dependent-validation-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.dependent-validation";
    const bindingId = "dependent-binding";
    const dependent = { ...binding(pluginId, bindingId), runtimeConfig: { instance: "configured" } };
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0"));
    await installOfficialBundle(host, sourcePath);
    await registry.prepare(dependent);

    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0", { includeRuntime: false }))}\n`);
    await expect(updateOfficialBundle(host, pluginId, sourcePath)).rejects.toThrow(
      "requires missing Runtime capability",
    );
    expect(host.activePluginIds()).toEqual([pluginId]);
    await expect(registry.prepare(dependent)).resolves.toBeUndefined();

    const narrowedSchema = {
      type: "object",
      additionalProperties: false,
      required: ["workspace"],
      properties: { workspace: { type: "string" } },
    };
    await writeFile(
      sourcePath,
      `${JSON.stringify(lifecycleBundle(pluginId, "3.0.0", { runtimeSchema: narrowedSchema }))}\n`,
    );
    await expect(updateOfficialBundle(host, pluginId, sourcePath)).rejects.toThrow("Runtime configuration");
    expect(host.activePluginIds()).toEqual([pluginId]);
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({ pluginId, version: "1.0.0", status: "active" }),
    ]);
    await expect(registry.prepare(dependent)).resolves.toBeUndefined();

    await host.close();
    await store.close();
  });

  it("rolls candidate effects back and keeps v2 Runtime unpublished when the staged lock commit fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-lock-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.lock-failure";
    const bindingId = "lock-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const lockfile = pluginInstallationPaths(configPath).lockfile;
    let sabotageCommit = false;
    let originalLockfile: string | undefined;
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
      quiesceRuntimeBindings: async (_bindingIds, criticalSection) => {
        await registry.prepare(dependent);
        if (!sabotageCommit) return await criticalSection();
        originalLockfile = await readFile(lockfile, "utf8");
        await rm(lockfile);
        await mkdir(lockfile);
        return await criticalSection();
      },
    });
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0", { exposureFailure: false }));
    await installOfficialBundle(host, sourcePath);
    await registry.prepare(dependent);
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0", { exposureFailure: false }))}\n`);

    sabotageCommit = true;
    try {
      await expect(updateOfficialBundle(host, pluginId, sourcePath)).rejects.toThrow();
    } finally {
      if (originalLockfile !== undefined) {
        await rm(lockfile, { recursive: true });
        await writeFile(lockfile, originalLockfile);
      }
    }
    expect(host.activePluginIds()).toEqual([pluginId]);
    await expect(registry.prepare(dependent)).resolves.toBeUndefined();
    const lockFailureLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(lockFailureLog).not.toContain("adapter-prepare:2.0.0");
    expect(lockFailureLog).not.toContain("exposure-activate:2.0.0:generation-2");
    expect(lockFailureLog).not.toContain("exposure-dispose:2.0.0");

    await host.close();
    await store.close();
  });

  it("releases cached Session handles before disposing v1 and opens v2 on the next Turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-session-release-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.session-release";
    const bindingId = "session-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const executor = new SessionTurnExecutor({
      configPath,
      stateDbPath,
      bindingFor: () => dependent,
      start: async (runtimeBinding, context) => await registry.start(runtimeBinding, context),
      attachRuntimeThread: async () => undefined,
    });
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
      quiesceRuntimeBindings: async (bindingIds, criticalSection) => {
        await executor.releaseBindings(new Set(bindingIds));
        return await criticalSection();
      },
    });
    const target: TurnTarget = {
      chatId: "chat",
      bindingId,
      sessionId: "session",
      sessionRef: "SESSION1",
      runtimeThreadId: null,
      workspaceRef: "WSDEFALT",
      name: null,
      mode: null,
      model: null,
      reasoningEffort: null,
      turnOrigin: "client",
    };
    const input = {
      prompt: "hello",
      workspace: { workspaceRef: "WSDEFALT", workingDirectory: directory, skipGitRepoCheck: true },
    };
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0"));
    await installOfficialBundle(host, sourcePath);
    await Array.fromAsync(executor.execute(target, input));
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0"))}\n`);

    await updateOfficialBundle(host, pluginId, sourcePath);
    await Array.fromAsync(executor.execute(target, input));
    const lifecycleLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(lifecycleLog.indexOf("session-close:1.0.0")).toBeLessThan(lifecycleLog.indexOf("adapter-close:1.0.0"));
    expect(lifecycleLog.filter((entry) => entry.startsWith("session-start:"))).toEqual([
      "session-start:1.0.0",
      "session-start:2.0.0",
    ]);

    await executor.close();
    await host.close();
    await store.close();
  });

  it("quiesces dependent Turns across replacement, failure, disable, enable, and removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-quiescence-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.quiescent-plugin";
    const bindingId = "quiescent-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const executor = new SessionTurnExecutor({
      configPath,
      stateDbPath,
      bindingFor: () => dependent,
      start: async (runtimeBinding, context) => await registry.start(runtimeBinding, context),
      attachRuntimeThread: async () => undefined,
    });
    const queue = new SessionQueue({ maxConcurrentTurns: 2 });
    let failQuiescence = false;
    let afterRelease: (() => void) | undefined;
    let quiescenceReached: (() => void) | undefined;
    let quiescenceHold: Promise<void> | undefined;
    const retiredBindings: string[] = [];
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
      retireRuntimeBindings: async (bindingIds) => {
        expect(() => queue.submit("retirement-intake", async () => undefined)).toThrow("lifecycle operation");
        retiredBindings.push(...bindingIds);
      },
      quiesceRuntimeBindings: async (bindingIds, criticalSection) => {
        const release = await queue.acquireBindingQuiescence(`Agent Binding ${bindingIds.join(", ")}`);
        try {
          await executor.releaseBindings(new Set(bindingIds));
          afterRelease?.();
          quiescenceReached?.();
          await quiescenceHold;
          if (failQuiescence) throw new Error("quiescence release failed");
          return await criticalSection();
        } finally {
          await release();
        }
      },
    });
    const target: TurnTarget = {
      chatId: "chat",
      bindingId,
      sessionId: "session",
      sessionRef: "SESSION-QUIESCENT",
      runtimeThreadId: null,
      workspaceRef: "WSDEFALT",
      name: null,
      mode: null,
      model: null,
      reasoningEffort: null,
      turnOrigin: "client",
    };
    const input = {
      prompt: "hello",
      workspace: { workspaceRef: "WSDEFALT", workingDirectory: directory, skipGitRepoCheck: true },
    };
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0"));
    await installOfficialBundle(host, sourcePath);

    let markTurnStarted: () => void = () => undefined;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    let finishTurn: () => void = () => undefined;
    const turnWait = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    Reflect.set(globalThis, "__connectPluginTurnGate", { started: markTurnStarted, wait: turnWait });
    const active = queue.submit("session", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await turnStarted;
    const queued = queue.submit("session", async () => {
      throw new Error("queued v1 Turn must not run");
    });
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0"))}\n`);
    let admissionFailure: unknown;
    afterRelease = () => {
      try {
        queue.submit("between-release-and-swap", async () => {
          await Array.fromAsync(executor.execute(target, input));
        });
      } catch (error) {
        admissionFailure = error;
      }
    };

    const updating = updateOfficialBundle(host, pluginId, sourcePath);
    await expect(queued.completion).rejects.toThrow("Agent Binding");
    expect(() => queue.submit("concurrent", async () => undefined)).toThrow("lifecycle operation");
    expect(Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[]).not.toContain("session-close:1.0.0");
    finishTurn();
    await active.completion;
    await updating;
    expect(admissionFailure).toMatchObject({ message: expect.stringContaining("lifecycle operation") });
    const replacementLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(replacementLog.indexOf("session-prompt-complete:1.0.0")).toBeLessThan(
      replacementLog.indexOf("session-close:1.0.0"),
    );
    expect(replacementLog.indexOf("session-close:1.0.0")).toBeLessThan(replacementLog.indexOf("adapter-close:1.0.0"));
    expect(replacementLog.filter((entry) => entry === "session-start:1.0.0")).toHaveLength(1);

    Reflect.deleteProperty(globalThis, "__connectPluginTurnGate");
    afterRelease = undefined;
    await queue.enqueue("resumed-success", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "3.0.0"))}\n`);
    failQuiescence = true;
    await expect(updateOfficialBundle(host, pluginId, sourcePath)).rejects.toThrow("quiescence release failed");
    failQuiescence = false;
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({ pluginId, version: "2.0.0", status: "active" }),
    ]);
    await queue.enqueue("resumed-failure", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    expect((Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[]).at(-2)).toBe("session-prompt:2.0.0");

    await host.disable(pluginId);
    const disableLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(disableLog.lastIndexOf("session-close:2.0.0")).toBeLessThan(disableLog.lastIndexOf("adapter-close:2.0.0"));
    const disabledTurn = queue.submit("resumed-disabled", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await expect(disabledTurn.completion).rejects.toThrow("is not active");

    let markEnableGateReached: () => void = () => undefined;
    const enableGateReached = new Promise<void>((resolve) => {
      markEnableGateReached = resolve;
    });
    let continueEnable: () => void = () => undefined;
    quiescenceHold = new Promise<void>((resolve) => {
      continueEnable = resolve;
    });
    quiescenceReached = markEnableGateReached;
    const enabling = host.enable(pluginId);
    await enableGateReached;
    expect(() => queue.submit("concurrent-enable", async () => undefined)).toThrow("lifecycle operation");
    continueEnable();
    await enabling;
    quiescenceReached = undefined;
    quiescenceHold = undefined;
    await queue.enqueue("before-remove", async () => {
      await Array.fromAsync(executor.execute(target, input));
    });
    await host.remove(pluginId, true);
    expect(retiredBindings).toEqual([bindingId]);
    const removeLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(removeLog.lastIndexOf("session-close:2.0.0")).toBeLessThan(removeLog.lastIndexOf("adapter-close:2.0.0"));
    expect(config.agents[bindingId]).toBeUndefined();

    await executor.close();
    await host.close();
    await store.close();
  });

  it("keeps a post-commit failing generation selected and unavailable without reactivating v1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-exposure-commit-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.exposure-commit-failure";
    const bindingId = "exposure-failure-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(configPath, registry, () => undefined, {
      config,
      stateStore: store,
      workspaces: new WorkspaceCatalog(store),
    });
    const unbindClient = await host.bindClientInterface({
      origin: "http://127.0.0.1:47823",
      fetch: async () => new Response(null, { status: 204 }),
    });
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0", { exposureFailure: false }));
    await installOfficialBundle(host, sourcePath);
    await registry.prepare(dependent);
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0", { exposureFailure: true }))}\n`);

    await expect(updateOfficialBundle(host, pluginId, sourcePath)).rejects.toThrow(
      "candidate exposure activation failed",
    );
    expect(host.activePluginIds()).toEqual([]);
    await expect(registry.prepare(dependent)).rejects.toThrow("is not active");
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        version: "2.0.0",
        activationGeneration: 2,
        status: "error",
        error: "candidate exposure activation failed",
      }),
    ]);
    const exposureFailureLog = Reflect.get(globalThis, "__connectPluginLifecycleLog") as string[];
    expect(exposureFailureLog).toContain("bundle-dispose:2.0.0");
    expect(exposureFailureLog).not.toContain("adapter-create:2.0.0");
    expect(exposureFailureLog).toContain("bundle-activate:2.0.0:generation-2");
    expect(exposureFailureLog).toContain("exposure-activate:2.0.0:generation-2");
    expect(exposureFailureLog.indexOf("bundle-dispose:1.0.0")).toBeLessThan(
      exposureFailureLog.indexOf("exposure-activate:2.0.0:generation-2"),
    );

    unbindClient();
    await host.close();
    await store.close();
  });

  it("removes v2 and marks the committed Bundle unavailable when post-commit disposal fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-hot-post-commit-failure-"));
    const configPath = join(directory, "config.json");
    const stateDbPath = join(directory, "state.sqlite");
    const pluginId = "test.post-commit-failure";
    const bindingId = "failure-binding";
    const dependent = binding(pluginId, bindingId);
    const config = {
      ...defaultConfig(),
      stateDbPath,
      agents: { [bindingId]: dependent },
      defaultAgent: bindingId,
    };
    await saveConfig(config, configPath);
    const store = createStateStore({ dbPath: stateDbPath });
    await store.initialize();
    const registry = new RuntimeAdapterRegistry([]);
    const diagnostics: string[] = [];
    const host = new ConnectPluginHost(
      configPath,
      registry,
      (_id, error) => diagnostics.push(error instanceof Error ? error.message : String(error)),
      { config, stateStore: store, workspaces: new WorkspaceCatalog(store) },
    );
    Reflect.set(globalThis, "__connectPluginLifecycleLog", []);
    const sourcePath = await writeBundle(directory, lifecycleBundle(pluginId, "1.0.0", { failAdapterClose: true }));
    await installOfficialBundle(host, sourcePath);
    await registry.prepare(dependent);
    await writeFile(sourcePath, `${JSON.stringify(lifecycleBundle(pluginId, "2.0.0"))}\n`);

    await expect(updateOfficialBundle(host, pluginId, sourcePath)).rejects.toThrow("v1 adapter disposal failed");
    expect(host.activePluginIds()).toEqual([]);
    await expect(registry.prepare(dependent)).rejects.toThrow("is not active");
    await expect(host.list()).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        version: "2.0.0",
        status: "error",
        error: "v1 adapter disposal failed",
      }),
    ]);
    await expect(store.getRuntimeStatus(bindingId)).resolves.toMatchObject({
      runtimeAvailability: "startup-unavailable",
      recentError: expect.stringContaining("v1 adapter disposal failed"),
    });
    expect(diagnostics).toContain("v1 adapter disposal failed");

    await host.close();
    await store.close();
  });
  it("collects only unreferenced managed uploads after failed installs and final removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-managed-plugin-uploads-"));
    const configPath = join(directory, "config.json");
    await saveConfig(defaultConfig(), configPath);
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined);
    Reflect.set(globalThis, "__connectHotPluginLog", []);

    const localBundle = hotBundle("test.unmanaged-local", "1.0.0");
    const localPath = await writeBundle(directory, localBundle);
    await installOfficialBundle(host, localPath);
    await host.remove(localBundle.manifest.pluginId);
    await expect(readFile(localPath, "utf8")).resolves.toContain(localBundle.manifest.pluginId);

    const managedBundle = assetBundle("test.managed-upload", "1.0.0", "managed");
    const installed = await host.installUpload(
      "managed.connect-plugin",
      new TextEncoder().encode(JSON.stringify(managedBundle)),
    );
    if (installed.source.type !== "local") throw new Error("Expected uploaded Plugin to use a local managed source");
    const managedPath = installed.source.path;
    await expect(readFile(managedPath, "utf8")).resolves.toContain(managedBundle.manifest.pluginId);

    const failedBytes = new TextEncoder().encode(
      JSON.stringify(assetBundle("test.failed-upload", "1.0.0", "failed", "auxiliary-v1", true)),
    );
    await expect(host.installUpload("failed.connect-plugin", failedBytes)).rejects.toThrow(
      "candidate activation failed",
    );
    await expect(host.installUpload("failed.connect-plugin", failedBytes)).rejects.toThrow(
      "candidate activation failed",
    );
    expect(await readdir(managedPluginUploadRoot(configPath))).toEqual([basename(managedPath)]);
    await expect(readFile(managedPath, "utf8")).resolves.toContain(managedBundle.manifest.pluginId);

    await host.remove(managedBundle.manifest.pluginId);
    expect(await readdir(managedPluginUploadRoot(configPath))).toEqual([]);
    await expect(readFile(localPath, "utf8")).resolves.toContain(localBundle.manifest.pluginId);
    await host.close();
  });

  it("bounds concurrent update resolvers while returning sorted isolated diagnostics for every Plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-update-concurrency-"));
    const configPath = join(directory, "config.json");
    await saveConfig(defaultConfig(), configPath);
    const target = currentConnectPluginTarget();
    const pluginIds = Array.from(
      { length: MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS * 3 + 2 },
      (_, index) => `test.update-${String(index).padStart(3, "0")}`,
    );
    const updatedBundles = new Map<string, Uint8Array>();
    for (const pluginId of pluginIds) {
      const repository = `acme/${pluginId.slice("test.".length)}`;
      await installPluginBundle({
        configPath,
        source: {
          type: "github",
          repository,
          apiBase: "https://api.example.test",
          version: "1.0.0",
          release: "v1.0.0",
          asset: `https://assets.example.test/${repository}/v1.connect-plugin`,
        },
        bundle: assetBundle(pluginId, "1.0.0", "update-v1"),
        target,
        installationConfiguration: {},
        exposureConfigurations: {},
      });
      updatedBundles.set(
        repository,
        new TextEncoder().encode(JSON.stringify(assetBundle(pluginId, "2.0.0", "update-v2"))),
      );
    }

    let activeResolvers = 0;
    let peakResolvers = 0;
    let releaseFirstWave: () => void = () => undefined;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const failedRepository = "acme/update-005";
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "api.example.test") {
        const repository = url.pathname.split("/").slice(2, 4).join("/");
        activeResolvers += 1;
        peakResolvers = Math.max(peakResolvers, activeResolvers);
        if (activeResolvers === MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS) releaseFirstWave();
        await firstWave;
        activeResolvers -= 1;
        if (repository === failedRepository) return Response.json({ message: "isolated failure" }, { status: 503 });
        const bytes = updatedBundles.get(repository);
        if (!bytes) return Response.json({ message: "unknown repository" }, { status: 404 });
        return Response.json([
          {
            tag_name: "v2.0.0",
            draft: false,
            prerelease: false,
            assets: [
              {
                name: `${repository.slice("acme/".length)}-${target}.connect-plugin`,
                browser_download_url: `https://assets.example.test/${repository}/v2.connect-plugin`,
                digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
              },
            ],
          },
        ]);
      }
      const repository = url.pathname.split("/").slice(1, 3).join("/");
      const bytes = updatedBundles.get(repository);
      return bytes ? new Response(new Uint8Array(bytes)) : Response.json({ message: "unknown asset" }, { status: 404 });
    }) as typeof fetch;
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, undefined, {
      fetch: fetchSource,
      githubApiBase: "https://api.example.test",
    });

    const checks = await host.checkUpdates();

    expect(peakResolvers).toBe(MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS);
    expect(Object.keys(checks)).toEqual(pluginIds);
    expect(checks["test.update-005"]).toEqual({
      status: "check-failed",
      version: null,
      integrity: null,
      diagnostic: expect.stringContaining("HTTP 503"),
    });
    for (const pluginId of pluginIds.filter((candidate) => candidate !== "test.update-005")) {
      expect(checks[pluginId]).toMatchObject({ status: "available", version: "2.0.0", diagnostic: null });
    }
    await host.close();
  });
});
