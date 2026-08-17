import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCurrentClientExtensionEpoch, deriveClientExtensionGraph } from "../src/plugin/client-extension";
import type { ConnectPluginBundleV1 } from "../src/plugin/sdk";
import {
  commitStagedPlugin,
  currentConnectPluginTarget,
  installLocalPlugin,
  listInstalledPlugins,
  readConnectPluginBundle,
  stagePluginBundle,
} from "../src/plugin/store";

const emptySchema = { type: "object", properties: {}, additionalProperties: false } as const;

function integrity(content: string): string {
  return `sha256-${createHash("sha256").update(content).digest("base64")}`;
}

function extensionBundle(version: string, priority: number): ConnectPluginBundleV1 {
  const host = "export default { activate() {} };\n";
  const browser =
    "export async function activate(context) { context.slots.register('session.header.after', () => null); }\n";
  const style = ".fixture { display: block; }\n";
  return {
    format: "clawchat-connect-plugin-bundle-v1",
    manifest: {
      manifestVersion: 1,
      interfaceVersion: "1",
      pluginId: "fixture.client-extension",
      version,
      dependencies: [],
      installationConfigurationSchema: emptySchema,
      capabilities: [
        {
          id: "client",
          type: "client-extension",
          interfaceVersion: "1",
          configurationSchema: {
            type: "object",
            properties: { label: { type: "string" } },
            additionalProperties: false,
          },
          browser: {
            entry: "browser.js",
            integrity: integrity(browser),
            styles: [{ entry: "browser.css", integrity: integrity(style) }],
            slots: [{ id: "kernel.root.after", interfaceVersion: "1", priority }],
          },
        },
      ],

      artifacts: [{ target: currentConnectPluginTarget(), entry: "host.js", integrity: integrity(host) }],
    },
    files: {
      "host.js": { encoding: "utf8", content: host },
      "browser.js": { encoding: "utf8", content: browser },
      "browser.css": { encoding: "utf8", content: style },
    },
  };
}
function browserManifest(bundle: ConnectPluginBundleV1) {
  const capability = bundle.manifest.capabilities[0];
  if (capability?.type !== "client-extension") throw new Error("Fixture Client Extension capability is missing");
  return capability.browser;
}

describe("Client Extension graph epochs", () => {
  it("derives the exact deterministic graph and changes epoch after selected configuration cutover", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-client-extension-"));
    const configPath = join(directory, "config.json");
    const bundlePath = join(directory, "extension.connect-plugin");
    await writeFile(bundlePath, `${JSON.stringify(extensionBundle("1.0.0", 20), null, 2)}\n`);

    const first = await installLocalPlugin({
      configPath,
      bundlePath,
      capabilityConfigurations: { client: { label: "Configured" } },
    });
    const firstGraph = deriveClientExtensionGraph([first]);
    expect(firstGraph.extensions).toEqual([
      {
        pluginId: "fixture.client-extension",
        capabilityId: "client",
        version: "1.0.0",
        activationGeneration: 1,
        configuration: { label: "Configured" },
        entry: "/client/v1/plugin-artifacts/fixture.client-extension/1/client/browser.js",
        integrity: browserManifest(extensionBundle("1.0.0", 20)).integrity,
        styles: [
          {
            href: "/client/v1/plugin-artifacts/fixture.client-extension/1/client/browser.css",
            integrity: browserManifest(extensionBundle("1.0.0", 20)).styles[0]?.integrity,
          },
        ],
        slots: [{ id: "kernel.root.after", interfaceVersion: "1", priority: 20 }],
      },
    ]);
    expect(firstGraph.epoch).toBe(firstGraph.hash);
    expect(() => assertCurrentClientExtensionEpoch(firstGraph, firstGraph.epoch)).not.toThrow();
    expect(
      deriveClientExtensionGraph([
        {
          ...first,
          installationConfiguration: { presentation: "compact" },
        },
      ]).hash,
    ).not.toBe(firstGraph.hash);

    const bundle = await readConnectPluginBundle(bundlePath);
    const staged = await stagePluginBundle({
      configPath,
      source: { type: "local", path: bundlePath },
      bundle,
      installationConfiguration: {},
    });
    const second = await commitStagedPlugin(configPath, staged, "update");
    const secondGraph = deriveClientExtensionGraph([second]);
    expect(secondGraph.hash).not.toBe(firstGraph.hash);
    expect(() => assertCurrentClientExtensionEpoch(secondGraph, firstGraph.epoch)).toThrow(
      "stale Client Extension graph epoch",
    );

    const lock = JSON.parse(await readFile(join(directory, "plugins.lock.json"), "utf8"));
    expect(lock.plugins["fixture.client-extension"].activationGeneration).toBe(2);
    expect(deriveClientExtensionGraph(await listInstalledPlugins(configPath))).toEqual(secondGraph);
  });

  it("orders slot survivors by priority, Plugin identity, and capability identity", () => {
    const high = extensionBundle("1.0.0", 5);
    const low = extensionBundle("1.0.0", 30);
    low.manifest.pluginId = "fixture.second-extension";
    const entries = [
      {
        pluginId: low.manifest.pluginId,
        activationGeneration: 4,
        source: { type: "local" as const, path: "/second" },
        version: low.manifest.version,
        target: currentConnectPluginTarget(),
        integrity: low.manifest.artifacts[0]?.integrity ?? "",
        activeArtifact: "/second/host.js",
        manifestPath: "/second/manifest.json",
        manifest: low.manifest,
        installationConfiguration: {},
        capabilityConfigurations: {},
        status: "active" as const,
        error: null,
        retainedVersions: [],
      },
      {
        pluginId: high.manifest.pluginId,
        activationGeneration: 3,
        source: { type: "local" as const, path: "/first" },
        version: high.manifest.version,
        target: currentConnectPluginTarget(),
        integrity: high.manifest.artifacts[0]?.integrity ?? "",
        activeArtifact: "/first/host.js",
        manifestPath: "/first/manifest.json",
        manifest: high.manifest,
        installationConfiguration: {},
        capabilityConfigurations: {},
        status: "active" as const,
        error: null,
        retainedVersions: [],
      },
    ];
    const graph = deriveClientExtensionGraph(entries);
    expect(graph.extensions.map((entry) => `${entry.slots[0]?.priority}:${entry.pluginId}`)).toEqual([
      "5:fixture.client-extension",
      "30:fixture.second-extension",
    ]);
  });
});
