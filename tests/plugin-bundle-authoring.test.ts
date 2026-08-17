import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectPluginAuthorManifestV1,
  RuntimeAdapterRegistry,
  writeConnectPluginBundle,
} from "../src/index";
import { runConnectPluginBuildCli } from "../src/plugin/build-cli";
import { ConnectPluginHost } from "../src/plugin/host";
import { readConnectPluginBundle } from "../src/plugin/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
  delete (globalThis as Record<string, unknown>).__externalPluginActivated;
});

function authorManifest(): ConnectPluginAuthorManifestV1 {
  return {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: "example.external",
    version: "1.2.3",
    dependencies: [
      {
        type: "host",
        id: "runtime-provider",
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      },
    ],
    installationConfigurationSchema: { type: "object", additionalProperties: false },
    capabilities: [
      {
        id: "runtime",
        type: "runtime",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        family: "example",
        configurationSchema: { type: "object", additionalProperties: false },
      },
    ],
  };
}

function integrity(content: string): string {
  return `sha256-${createHash("sha256").update(content).digest("base64")}`;
}

async function externalProject(): Promise<{
  root: string;
  manifestPath: string;
  artifactPath: string;
  outputPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "connect-external-plugin-"));
  temporaryDirectories.push(root);
  const dist = join(root, "dist");
  await mkdir(dist);
  const manifestPath = join(root, "connect-plugin.manifest.json");
  const artifactPath = join(dist, "plugin.mjs");
  const outputPath = join(dist, "example.connect-plugin");
  await writeFile(manifestPath, JSON.stringify(authorManifest()));
  await writeFile(
    artifactPath,
    `export default {
  activate(context) {
    globalThis.__externalPluginActivated = true;
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "runtime",
      family: "example",
      create() {
        return {
          modes: [],
          async start() {
            return { async *prompt() {}, async close() {} };
          }
        };
      }
    });
  }
};\n`,
  );
  return { root, manifestPath, artifactPath, outputPath };
}

describe("public Plugin Bundle authoring", () => {
  it("builds a target Bundle from an external project and loads it through the production host", async () => {
    const project = await externalProject();
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runConnectPluginBuildCli(
        [
          "build",
          "--manifest",
          project.manifestPath,
          "--target",
          "test-target",
          "--artifact",
          project.artifactPath,
          "--artifact-entry",
          "entry/plugin.mjs",
          "--output",
          project.outputPath,
        ],
        { writeStdout: (value) => stdout.push(value), writeStderr: (value) => stderr.push(value) },
      ),
    ).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`${project.outputPath}\n`]);

    const bundle = await readConnectPluginBundle(project.outputPath);
    expect(bundle.manifest.artifacts).toEqual([
      {
        target: "test-target",
        entry: "entry/plugin.mjs",
        integrity: expect.stringMatching(/^sha256-[A-Za-z0-9+/]{43}=$/u),
      },
    ]);
    expect(Object.keys(bundle.files)).toEqual(["entry/plugin.mjs"]);

    const host = new ConnectPluginHost(join(project.root, "connect.json"), new RuntimeAdapterRegistry([]), () => {});
    await expect(host.install({ source: project.outputPath, target: "test-target" })).resolves.toMatchObject({
      pluginId: "example.external",
      target: "test-target",
      status: "active",
    });
    expect((globalThis as Record<string, unknown>).__externalPluginActivated).toBe(true);
  });

  it("includes integrity-checked browser artifacts for public Client Extensions", async () => {
    const project = await externalProject();
    const browser = "export function activate() {}\n";
    const style = ".extension { display: block; }\n";
    const browserPath = join(project.root, "dist", "client.mjs");
    const stylePath = join(project.root, "dist", "client.css");
    await writeFile(browserPath, browser);
    await writeFile(stylePath, style);
    const manifest: ConnectPluginAuthorManifestV1 = {
      ...authorManifest(),
      dependencies: [],
      capabilities: [
        {
          id: "client",
          type: "client-extension",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
          browser: {
            entry: "browser/client.mjs",
            integrity: integrity(browser),
            styles: [{ entry: "browser/client.css", integrity: integrity(style) }],
            slots: [{ id: "kernel.root.after", interfaceVersion: "1", priority: 20 }],
          },
        },
      ],
    };

    const bundle = await writeConnectPluginBundle({
      manifest,
      target: "test-target",
      artifactPath: project.artifactPath,
      artifactEntry: "entry/plugin.mjs",
      browserArtifactPaths: {
        "browser/client.mjs": browserPath,
        "browser/client.css": stylePath,
      },
      outputPath: project.outputPath,
    });

    expect(Object.keys(bundle.files).sort()).toEqual(["browser/client.css", "browser/client.mjs", "entry/plugin.mjs"]);
    const schema = (await Bun.file(
      new URL("../src/plugin/connect-plugin-manifest.schema.json", import.meta.url),
    ).json()) as Record<string, unknown>;
    expect(new Ajv2020({ strict: true }).compile(schema)(manifest)).toBe(true);
  });

  it("packages declared browser artifacts through the public build CLI", async () => {
    const project = await externalProject();
    const browser = "export function activate() {}\n";
    const style = ".extension { display: block; }\n";
    const browserPath = join(project.root, "dist", "client.mjs");
    const stylePath = join(project.root, "dist", "client.css");
    await writeFile(browserPath, browser);
    await writeFile(stylePath, style);
    const manifest: ConnectPluginAuthorManifestV1 = {
      ...authorManifest(),
      dependencies: [],
      capabilities: [
        {
          id: "client",
          type: "client-extension",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
          browser: {
            entry: "browser/client.mjs",
            integrity: integrity(browser),
            styles: [{ entry: "browser/client.css", integrity: integrity(style) }],
            slots: [{ id: "kernel.root.after", interfaceVersion: "1", priority: 20 }],
          },
        },
      ],
    };
    await writeFile(project.manifestPath, JSON.stringify(manifest));

    await expect(
      runConnectPluginBuildCli([
        "build",
        "--manifest",
        project.manifestPath,
        "--target",
        "test-target",
        "--artifact",
        project.artifactPath,
        "--artifact-entry",
        "entry/plugin.mjs",
        "--browser-artifact",
        `browser/client.mjs=${browserPath}`,
        "--browser-artifact",
        `browser/client.css=${stylePath}`,
        "--output",
        project.outputPath,
      ]),
    ).resolves.toBe(0);
    const bundle = await readConnectPluginBundle(project.outputPath);
    expect(Object.keys(bundle.files).sort()).toEqual(["browser/client.css", "browser/client.mjs", "entry/plugin.mjs"]);
  });

  it("exports a machine-readable author manifest schema", async () => {
    const packageManifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      exports: Record<string, string | Record<string, string>>;
      bin: Record<string, string>;
      files: string[];
    };
    expect(packageManifest.exports["./plugin-manifest.schema.json"]).toBe(
      "./src/plugin/connect-plugin-manifest.schema.json",
    );
    expect(packageManifest.bin["clawchat-connect-plugin"]).toBe("./dist/src/plugin/build-cli.js");
    expect(packageManifest.files).toContain("src/plugin/connect-plugin-manifest.schema.json");

    const schema = (await Bun.file(
      new URL("../src/plugin/connect-plugin-manifest.schema.json", import.meta.url),
    ).json()) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(authorManifest())).toBe(true);
    expect(
      validate({
        ...authorManifest(),
        dependencies: [
          ...authorManifest().dependencies,
          {
            type: "host",
            id: "durable-state",
            interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
          },
        ],
        capabilities: [
          {
            ...authorManifest().capabilities[0],
            durableState: {
              schemaVersion: 1,
              lifetime: "binding",
              schema: {
                type: "object",
                properties: { count: { type: "integer" } },
                required: ["count"],
                additionalProperties: false,
              },
              migrations: [],
            },
          },
        ],
      }),
    ).toBe(true);
    expect(validate({ ...authorManifest(), pluginId: "Malformed Plugin ID" })).toBe(false);
    const exposureAuthorManifest = {
      ...authorManifest(),
      dependencies: [
        {
          type: "host",
          id: "exposure-provider",
          interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
        },
        {
          type: "host",
          id: "durable-state",
          interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
        },
      ],
      capabilities: [
        {
          id: "exposure",
          type: "exposure",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
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
      ],
    };
    expect(validate(exposureAuthorManifest)).toBe(true);
    expect(
      validate({
        ...exposureAuthorManifest,
        capabilities: exposureAuthorManifest.capabilities.map((capability) => ({
          ...capability,
          durableState: { ...capability.durableState, lifetime: "binding" },
        })),
      }),
    ).toBe(true);
  });

  it("rejects malformed manifests before writing output", async () => {
    const project = await externalProject();
    const malformed = { ...authorManifest(), pluginId: "Malformed Plugin ID" };

    await expect(
      writeConnectPluginBundle({
        manifest: malformed as ConnectPluginAuthorManifestV1,
        target: "test-target",
        artifactPath: project.artifactPath,
        artifactEntry: "entry/plugin.mjs",
        outputPath: project.outputPath,
      }),
    ).rejects.toThrow("Plugin ID must be a stable lowercase identifier");
    await expect(access(project.outputPath)).rejects.toBeDefined();
  });
});
