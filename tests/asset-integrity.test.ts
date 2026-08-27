import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import { verifyClientAssetGraph } from "../src/client-interface/client-assets";
import {
  type ConnectPluginAuthorManifestV1,
  buildConnectPluginBundle,
} from "../src/plugin/builder";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../src/plugin/sdk";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
});

function manifest(): ConnectPluginAuthorManifestV1 {
  return {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: "example.asset-graph",
    version: "1.0.0",
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

async function assetFixture(): Promise<{
  root: string;
  artifactPath: string;
  assetsRoot: string;
  integrityManifestPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "connect-asset-integrity-"));
  temporaryDirectories.push(root);
  const artifactPath = join(root, "plugin.mjs");
  const assetsRoot = join(root, "client");
  const integrityManifestPath = join(root, "client-assets.json");
  await mkdir(join(assetsRoot, "nested"), { recursive: true });
  await writeFile(artifactPath, "export default { activate() {} };\n");
  await writeFile(join(assetsRoot, "z.txt"), "z");
  await writeFile(join(assetsRoot, "nested", "b.txt"), "b");
  await writeFile(join(assetsRoot, "a.txt"), "a");
  return { root, artifactPath, assetsRoot, integrityManifestPath };
}

describe("Plugin asset integrity graphs", () => {
  it("packages the same complete deterministic regular-file graph through public and official builders", async () => {
    const fixture = await assetFixture();
    const bundle = await buildConnectPluginBundle({
      manifest: manifest(),
      target: "test-target",
      artifactPath: fixture.artifactPath,
      artifactEntry: "artifacts/test-target.mjs",
      assetDirectories: [
        {
          sourceDirectory: fixture.assetsRoot,
          entryPrefix: "client",
          integrityManifestEntry: "client-assets.json",
        },
      ],
    });

    expect(Object.keys(bundle.files)).toEqual([
      "artifacts/test-target.mjs",
      "client/a.txt",
      "client/nested/b.txt",
      "client/z.txt",
      "client-assets.json",
    ]);
    const integrityFile = bundle.files["client-assets.json"];
    if (!integrityFile || integrityFile.encoding !== "utf8") {
      throw new Error("Generated Client asset integrity manifest is missing");
    }
    const expectedIntegrities = {
      "client/a.txt": integrity("a"),
      "client/nested/b.txt": integrity("b"),
      "client/z.txt": integrity("z"),
    };
    expect(JSON.parse(integrityFile.content)).toEqual(expectedIntegrities);
    expect(integrityFile.content).toBe(`${JSON.stringify(expectedIntegrities, null, 2)}\n`);

    const official = await buildOfficialPlugin(
      {
        manifest: manifest(),
        entrypoint: fixture.artifactPath,
        assetDirectories: [
          {
            sourceDirectory: fixture.assetsRoot,
            entryPrefix: "client",
            integrityManifestEntry: "client-assets.json",
          },
        ],
      },
      { target: "test-target", write: false },
    );
    expect(Object.keys(official.bundle.files)).toEqual([
      "artifacts/test-target.mjs",
      "client/a.txt",
      "client/nested/b.txt",
      "client/z.txt",
      "client-assets.json",
    ]);
    const officialIntegrityFile = official.bundle.files["client-assets.json"];
    if (!officialIntegrityFile || officialIntegrityFile.encoding !== "utf8") {
      throw new Error("Official Plugin generated Client asset integrity manifest is missing");
    }
    expect(officialIntegrityFile.content).toBe(integrityFile.content);
    await writeFile(fixture.integrityManifestPath, integrityFile.content);

    await expect(
      verifyClientAssetGraph(fixture.assetsRoot, fixture.integrityManifestPath),
    ).resolves.toBeUndefined();
    await writeFile(join(fixture.assetsRoot, "uncovered.txt"), "uncovered");
    await expect(
      verifyClientAssetGraph(fixture.assetsRoot, fixture.integrityManifestPath),
    ).rejects.toThrow("Connect Client asset graph does not match its integrity manifest");
  });

  it("rejects symbolic links through official, public-authoring, and runtime asset paths", async () => {
    const fixture = await assetFixture();
    const outsidePath = join(fixture.root, "outside.txt");
    await writeFile(outsidePath, "outside");
    const linkedPath = join(fixture.assetsRoot, "linked.txt");
    const linked = await symlink(outsidePath, linkedPath, "file")
      .then(() => true)
      .catch(() => false);
    if (!linked) return;

    await expect(
      buildOfficialPlugin(
        {
          manifest: manifest(),
          entrypoint: fixture.artifactPath,
          assetDirectories: [
            {
              sourceDirectory: fixture.assetsRoot,
              entryPrefix: "client",
              integrityManifestEntry: "client-assets.json",
            },
          ],
        },
        { target: "test-target", write: false },
      ),
    ).rejects.toThrow(`Official Plugin asset directories cannot contain symbolic links: ${linkedPath}`);

    await expect(
      buildConnectPluginBundle({
        manifest: manifest(),
        target: "test-target",
        artifactPath: fixture.artifactPath,
        artifactEntry: "artifacts/test-target.mjs",
        assetDirectories: [
          {
            sourceDirectory: fixture.assetsRoot,
            entryPrefix: "client",
            integrityManifestEntry: "client-assets.json",
          },
        ],
      }),
    ).rejects.toThrow(`Plugin asset directories cannot contain symbolic links: ${linkedPath}`);

    await writeFile(fixture.integrityManifestPath, "{}\n");
    await expect(
      verifyClientAssetGraph(fixture.assetsRoot, fixture.integrityManifestPath),
    ).rejects.toThrow(`Connect Client asset graph contains a symbolic link: ${linkedPath}`);
  });
});
