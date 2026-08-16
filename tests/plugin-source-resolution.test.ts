import { describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { defaultConfig, saveConfig } from "../src/config";
import {
  CONNECT_PLUGIN_CATALOG_FORMAT,
  discoverOfficialPlugins,
  fetchOfficialPluginCatalog,
  MAX_OFFICIAL_PLUGIN_CATALOG_BYTES,
  type OfficialPluginCatalogV1,
  type OfficialPluginDiscovery,
  officialCatalogSigningPayload,
} from "../src/plugin/catalog";
import { ConnectPluginHost } from "../src/plugin/host";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectPluginBundleV1,
} from "../src/plugin/sdk";
import {
  MAX_GITHUB_SOURCE_ASSET_ATTEMPTS,
  MAX_GITHUB_SOURCE_RELEASE_CANDIDATES,
  MAX_NPM_SOURCE_CANDIDATE_ATTEMPTS,
  MAX_PLUGIN_SOURCE_ARCHIVE_BYTES,
  MAX_PLUGIN_SOURCE_DOWNLOAD_BYTES,
  MAX_PLUGIN_SOURCE_METADATA_BYTES,
  resolvePluginSource,
} from "../src/plugin/source";
import {
  commitStagedPlugin,
  installPluginBundle,
  listInstalledPlugins,
  pluginInstallationPaths,
  stagePluginBundle,
} from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { runConnectCli } from "../src/service/cli";

function sri(source: string | Uint8Array): string {
  return `sha256-${createHash("sha256").update(source).digest("base64")}`;
}

function sourceBundle(pluginId: string, version: string, target: string, probeSource?: string): ConnectPluginBundleV1 {
  const entry = `export default { activate(context) { context.hostCapabilities.get("runtime-provider").register({ capabilityId: "runtime", family: "source-test", create() { return { modes: [], async start() { throw new Error("unused"); } }; } }); } };`;
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
          family: "source-test",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
      artifacts: [{ target, entry: "plugin.mjs", integrity: sri(entry) }],
      ...(probeSource ? { probe: { entry: "probe.mjs", integrity: sri(probeSource) } } : {}),
    },
    files: {
      "plugin.mjs": { encoding: "utf8", content: entry },
      ...(probeSource ? { "probe.mjs": { encoding: "utf8" as const, content: probeSource } } : {}),
    },
  };
}

function tarball(bundle: ConnectPluginBundleV1): Uint8Array {
  const files: Array<[string, Uint8Array]> = [
    [
      "package/package.json",
      new TextEncoder().encode(
        JSON.stringify({ name: "source-plugin", clawchatConnectPlugin: "plugin.connect-plugin" }),
      ),
    ],
    ["package/plugin.connect-plugin", new TextEncoder().encode(JSON.stringify(bundle))],
  ];
  const blocks: Uint8Array[] = [];
  for (const [path, bytes] of files) {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(path), 0);
    header.set(new TextEncoder().encode(`${bytes.length.toString(8).padStart(11, "0")}\0`), 124);
    header[156] = "0".charCodeAt(0);
    blocks.push(header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks.map((block) => Buffer.from(block)))));
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function signedCatalogFixture(): { catalog: OfficialPluginCatalogV1; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned: Omit<OfficialPluginCatalogV1, "signature"> = {
    format: CONNECT_PLUGIN_CATALOG_FORMAT,
    generatedAt: "2026-08-16T00:00:00.000Z",
    plugins: [],
  };
  return {
    catalog: {
      ...unsigned,
      signature: sign(null, officialCatalogSigningPayload(unsigned), privateKey).toString("base64"),
    },
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("Plugin source resolution", () => {
  it("resolves compatible stable and exact npm/GitHub assets, pins them, and rejects source switching", async () => {
    const target = "source-test-target";
    const pluginId = "test.source-plugin";
    const npmV1 = sourceBundle(pluginId, "1.0.0", target);
    const npmArtifact = npmV1.manifest.artifacts[0];
    if (!npmArtifact) throw new Error("Expected npm fixture artifact");
    const npmV2Incompatible = sourceBundle(pluginId, "2.0.0", "other-target");
    const npmV1Tarball = tarball(npmV1);
    const npmV2Tarball = tarball(npmV2Incompatible);
    const githubV1 = sourceBundle(pluginId, "1.0.0", target);
    const githubV2 = sourceBundle(pluginId, "2.0.0", target);
    let origin = "";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        origin ||= url.origin;
        if (url.pathname === "/registry/source-plugin") {
          return json({
            "dist-tags": { latest: "2.0.0" },
            versions: {
              "1.0.0": {
                version: "1.0.0",
                dist: {
                  tarball: `${origin}/tarballs/1.0.0.tgz`,
                  integrity: `sha512-${createHash("sha512").update(npmV1Tarball).digest("base64")}`,
                },
              },
              "1.5.0-beta.1": {
                version: "1.5.0-beta.1",
                dist: { tarball: `${origin}/tarballs/beta.tgz` },
              },
              "2.0.0": {
                version: "2.0.0",
                dist: {
                  tarball: `${origin}/tarballs/2.0.0.tgz`,
                  integrity: `sha512-${createHash("sha512").update(npmV2Tarball).digest("base64")}`,
                },
              },
            },
          });
        }
        if (url.pathname === "/tarballs/1.0.0.tgz") return new Response(new Uint8Array(npmV1Tarball));
        if (url.pathname === "/tarballs/2.0.0.tgz") return new Response(new Uint8Array(npmV2Tarball));
        const release = (tag: string, asset: string, bytes: Uint8Array | ConnectPluginBundleV1) => {
          const assetBytes = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(JSON.stringify(bytes));
          return {
            tag_name: tag,
            draft: false,
            prerelease: tag.includes("beta"),
            assets: [
              {
                name: `source-plugin-${target}.connect-plugin`,
                browser_download_url: `${origin}${asset}`,
                digest: `sha256:${createHash("sha256").update(assetBytes).digest("hex")}`,
              },
            ],
          };
        };
        if (url.pathname === "/github/repos/acme/source-plugin/releases") {
          return json([
            release("v3.0.0-beta.1", "/assets/beta", githubV2),
            release("v2.0.0", "/assets/v2", githubV2),
            release("v1.0.0", "/assets/v1", githubV1),
          ]);
        }
        if (url.pathname === "/github/repos/acme/source-plugin/releases/tags/1.0.0") return json({}, 404);
        if (url.pathname === "/github/repos/acme/source-plugin/releases/tags/v1.0.0")
          return json(release("v1.0.0", "/assets/v1", githubV1));
        if (url.pathname === "/assets/v1") return new Response(JSON.stringify(githubV1));
        if (url.pathname === "/assets/v2") return new Response(JSON.stringify(githubV2));
        return json({ error: "not found" }, 404);
      },
    });
    origin = server.url.origin;
    try {
      const options = {
        fetch,
        target,
        npmRegistry: `${origin}/registry`,
        githubApiBase: `${origin}/github`,
      };
      const npmLatest = await resolvePluginSource("npm:source-plugin", options);
      expect(npmLatest.source).toMatchObject({ type: "npm", package: "source-plugin", version: "1.0.0" });
      expect(npmLatest.bundle.manifest.version).toBe("1.0.0");
      await expect(resolvePluginSource("npm:source-plugin@2.0.0", options)).rejects.toThrow(
        "has no compatible source-test-target Bundle",
      );
      const githubLatest = await resolvePluginSource("github:acme/source-plugin", options);
      expect(githubLatest.source).toMatchObject({ type: "github", release: "v2.0.0", version: "2.0.0" });
      const githubExact = await resolvePluginSource("github:acme/source-plugin@1.0.0", options);
      expect(githubExact.source).toMatchObject({ type: "github", release: "v1.0.0", version: "1.0.0" });

      const directory = await mkdtemp(join(tmpdir(), "connect-plugin-sources-"));
      const configPath = join(directory, "config.json");
      const installed = await installPluginBundle({ configPath, ...npmLatest });
      expect(installed).toMatchObject({
        source: { type: "npm", package: "source-plugin", version: "1.0.0" },
        version: "1.0.0",
        target,
        integrity: npmArtifact.integrity,
      });
      const switched = await stagePluginBundle({ configPath, ...githubExact });
      await expect(commitStagedPlugin(configPath, switched, "update")).rejects.toThrow("source is immutable");
      await expect(listInstalledPlugins(configPath)).resolves.toEqual([
        expect.objectContaining({ source: expect.objectContaining({ type: "npm", package: "source-plugin" }) }),
      ]);

      const localPath = join(directory, "local.connect-plugin");
      const localConfigPath = join(directory, "local-config.json");
      await writeFile(localPath, JSON.stringify(sourceBundle("test.local-source", "1.0.0", target)));
      const local = await resolvePluginSource(localPath, { target });
      await expect(installPluginBundle({ configPath: localConfigPath, ...local })).resolves.toMatchObject({
        source: { type: "local", path: localPath },
        target,
      });
    } finally {
      server.stop(true);
    }
  });

  it("requires the GitHub Release digest and verifies it before parsing the asset", async () => {
    const target = "source-test-target";
    const bundle = sourceBundle("test.github-digest", "1.0.0", target);
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const resolveWithDigest = async (digest?: string, downloadedBytes = bytes) =>
      await resolvePluginSource("github:acme/github-digest@v1.0.0", {
        target,
        githubApiBase: "https://api.example.test",
        fetch: (async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.hostname === "assets.example.test") return new Response(downloadedBytes);
          return json({
            tag_name: "v1.0.0",
            draft: false,
            prerelease: false,
            assets: [
              {
                name: `github-digest-${target}.connect-plugin`,
                browser_download_url: "https://assets.example.test/github-digest.connect-plugin",
                ...(digest === undefined ? {} : { digest }),
              },
            ],
          });
        }) as typeof fetch,
      });

    await expect(resolveWithDigest(expectedDigest)).resolves.toMatchObject({
      source: { type: "github", release: "v1.0.0" },
      bundle: { manifest: { pluginId: "test.github-digest" } },
    });
    await expect(resolveWithDigest()).rejects.toThrow("metadata does not provide a valid sha256 digest");
    await expect(
      resolveWithDigest(`sha256:${"0".repeat(64)}`, new TextEncoder().encode("not a Plugin Bundle")),
    ).rejects.toThrow("sha256 digest mismatch");
  });

  it("bounds unpinned npm downloads and decompressions while preserving latest-first fallback", async () => {
    const target = "source-test-target";
    const versions = Array.from({ length: 100 }, (_, index) => `${100 - index}.0.0`);
    const candidateOrder = ["1.0.0", ...versions.filter((version) => version !== "1.0.0")];
    const compatibleWithinBudget = candidateOrder[MAX_NPM_SOURCE_CANDIDATE_ATTEMPTS - 1];
    const compatibleBeyondBudget = candidateOrder[MAX_NPM_SOURCE_CANDIDATE_ATTEMPTS];
    if (!compatibleWithinBudget || !compatibleBeyondBudget) throw new Error("Invalid npm attempt-budget fixture");
    const artifacts = new Map<string, Uint8Array>();
    const metadataFor = (packageName: string, compatibleVersion: string) => ({
      "dist-tags": { latest: "1.0.0" },
      versions: Object.fromEntries(
        versions.map((version) => {
          const bytes = tarball(
            sourceBundle(`test.${packageName}`, version, version === compatibleVersion ? target : "other-target"),
          );
          artifacts.set(`${packageName}/${version}`, bytes);
          return [
            version,
            {
              version,
              dist: {
                tarball: `https://registry.example.test/tarballs/${packageName}/${version}.tgz`,
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
              },
            },
          ];
        }),
      ),
    });
    const metadata: Record<string, unknown> = {
      "npm-within-budget": metadataFor("npm-within-budget", compatibleWithinBudget),
      "npm-beyond-budget": metadataFor("npm-beyond-budget", compatibleBeyondBudget),
    };
    const downloads: string[] = [];
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const tarballMatch = url.pathname.match(/^\/tarballs\/([^/]+)\/([^/]+)\.tgz$/u);
      if (tarballMatch?.[1] && tarballMatch[2]) {
        downloads.push(`${tarballMatch[1]}/${tarballMatch[2]}`);
        const bytes = artifacts.get(`${tarballMatch[1]}/${tarballMatch[2]}`);
        return bytes ? new Response(new Uint8Array(bytes)) : json({ error: "not found" }, 404);
      }
      const packageName = url.pathname.slice(1);
      const value = metadata[packageName];
      return value ? json(value) : json({ error: "not found" }, 404);
    }) as typeof fetch;
    const options = {
      fetch: fetchSource,
      npmRegistry: "https://registry.example.test",
      target,
    };

    await expect(resolvePluginSource("npm:npm-within-budget", options)).resolves.toMatchObject({
      source: { type: "npm", version: compatibleWithinBudget },
    });
    expect(downloads.filter((value) => value.startsWith("npm-within-budget/"))).toEqual(
      candidateOrder.slice(0, MAX_NPM_SOURCE_CANDIDATE_ATTEMPTS).map((version) => `npm-within-budget/${version}`),
    );

    await expect(resolvePluginSource("npm:npm-beyond-budget", options)).rejects.toThrow(
      `at most ${MAX_NPM_SOURCE_CANDIDATE_ATTEMPTS} candidate attempts`,
    );
    const beyondDownloads = downloads.filter((value) => value.startsWith("npm-beyond-budget/"));
    expect(beyondDownloads).toHaveLength(MAX_NPM_SOURCE_CANDIDATE_ATTEMPTS);
    expect(beyondDownloads).not.toContain(`npm-beyond-budget/${compatibleBeyondBudget}`);
  });

  it("bounds sorted GitHub Releases and aggregate asset downloads with large metadata", async () => {
    const target = "source-test-target";
    const releaseVersions = Array.from({ length: 100 }, (_, index) => `${100 - index}.0.0`);
    const effectiveBudget = Math.min(MAX_GITHUB_SOURCE_RELEASE_CANDIDATES, MAX_GITHUB_SOURCE_ASSET_ATTEMPTS);
    const compatibleWithinBudget = releaseVersions[effectiveBudget - 1];
    const compatibleBeyondBudget = releaseVersions[effectiveBudget];
    if (!compatibleWithinBudget || !compatibleBeyondBudget) {
      throw new Error("Invalid GitHub attempt-budget fixture");
    }
    const assets = new Map<string, Uint8Array>();
    const releasesFor = (repository: string, compatibleVersion: string) =>
      [...releaseVersions].reverse().map((version) => {
        const bytes = new TextEncoder().encode(
          JSON.stringify(
            sourceBundle(`test.${repository}`, version, version === compatibleVersion ? target : "other-target"),
          ),
        );
        const assetPath = `${repository}/${version}`;
        assets.set(assetPath, bytes);
        return {
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          assets: [
            {
              name: `${repository}-${target}.connect-plugin`,
              browser_download_url: `https://assets.example.test/${assetPath}`,
              digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            },
          ],
        };
      });
    const metadata: Record<string, unknown> = {
      "github-within-budget": releasesFor("github-within-budget", compatibleWithinBudget),
      "github-beyond-budget": releasesFor("github-beyond-budget", compatibleBeyondBudget),
    };
    const downloads: string[] = [];
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "assets.example.test") {
        const assetPath = url.pathname.slice(1);
        downloads.push(assetPath);
        const bytes = assets.get(assetPath);
        return bytes ? new Response(new Uint8Array(bytes)) : json({ error: "not found" }, 404);
      }
      const match = url.pathname.match(/^\/repos\/acme\/([^/]+)\/releases$/u);
      const value = match?.[1] ? metadata[match[1]] : undefined;
      return value ? json(value) : json({ error: "not found" }, 404);
    }) as typeof fetch;
    const options = {
      fetch: fetchSource,
      githubApiBase: "https://api.example.test",
      target,
    };

    await expect(resolvePluginSource("github:acme/github-within-budget", options)).resolves.toMatchObject({
      source: { type: "github", version: compatibleWithinBudget },
    });
    expect(downloads.filter((value) => value.startsWith("github-within-budget/"))).toEqual(
      releaseVersions.slice(0, effectiveBudget).map((version) => `github-within-budget/${version}`),
    );

    await expect(resolvePluginSource("github:acme/github-beyond-budget", options)).rejects.toThrow(
      `at most ${MAX_GITHUB_SOURCE_ASSET_ATTEMPTS} asset attempts`,
    );
    const beyondDownloads = downloads.filter((value) => value.startsWith("github-beyond-budget/"));
    expect(beyondDownloads.length).toBeLessThanOrEqual(MAX_GITHUB_SOURCE_ASSET_ATTEMPTS);
    expect(beyondDownloads.length).toBeLessThanOrEqual(MAX_GITHUB_SOURCE_RELEASE_CANDIDATES);
    expect(beyondDownloads).not.toContain(`github-beyond-budget/${compatibleBeyondBudget}`);
  });

  it("shares one GitHub asset-attempt budget across Releases", async () => {
    const target = "source-test-target";
    const assets = new Map<string, Uint8Array>();
    const release = (version: string, count: number, compatible: boolean) => ({
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: Array.from({ length: count }, (_, index) => {
        const path = `${version}/${index}`;
        const bytes = new TextEncoder().encode(
          JSON.stringify(sourceBundle("test.github-aggregate-budget", version, compatible ? target : "other-target")),
        );
        assets.set(path, bytes);
        return {
          name: `aggregate-${target}-${String(index).padStart(3, "0")}.connect-plugin`,
          browser_download_url: `https://assets.example.test/${path}`,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      }),
    });
    const downloads: string[] = [];
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "assets.example.test") {
        const path = url.pathname.slice(1);
        downloads.push(path);
        const bytes = assets.get(path);
        return bytes ? new Response(new Uint8Array(bytes)) : json({ error: "not found" }, 404);
      }
      return json([release("2.0.0", MAX_GITHUB_SOURCE_ASSET_ATTEMPTS, false), release("1.0.0", 1, true)]);
    }) as typeof fetch;

    await expect(
      resolvePluginSource("github:acme/github-aggregate-budget", {
        fetch: fetchSource,
        githubApiBase: "https://api.example.test",
        target,
      }),
    ).rejects.toThrow(`at most ${MAX_GITHUB_SOURCE_ASSET_ATTEMPTS} asset attempts`);
    expect(downloads).toHaveLength(MAX_GITHUB_SOURCE_ASSET_ATTEMPTS);
    expect(downloads).not.toContain("1.0.0/0");
  });

  it("rejects oversized declared registry metadata before reading it", async () => {
    const target = "source-test-target";
    const fetchSource = (async () =>
      new Response("{}", {
        headers: { "content-length": String(MAX_PLUGIN_SOURCE_METADATA_BYTES + 1) },
      })) as unknown as typeof fetch;

    await expect(
      resolvePluginSource("npm:declared-limit@1.0.0", {
        fetch: fetchSource,
        npmRegistry: "https://registry.example.test",
        target,
      }),
    ).rejects.toThrow(`${MAX_PLUGIN_SOURCE_METADATA_BYTES}-byte download limit`);
  });

  it("cancels a lengthless remote stream as soon as its observed body exceeds the download limit", async () => {
    const target = "source-test-target";
    const chunk = new Uint8Array(1024 * 1024);
    const chunksSent = MAX_PLUGIN_SOURCE_DOWNLOAD_BYTES / chunk.byteLength + 1;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < chunksSent; index += 1) controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/streamed.tgz") return new Response(body);
      return json({
        versions: {
          "1.0.0": {
            version: "1.0.0",
            dist: {
              tarball: "https://registry.example.test/streamed.tgz",
              integrity: `sha512-${createHash("sha512").update("unreached").digest("base64")}`,
            },
          },
        },
      });
    }) as typeof fetch;

    await expect(
      resolvePluginSource("npm:stream-limit@1.0.0", {
        fetch: fetchSource,
        npmRegistry: "https://registry.example.test",
        target,
      }),
    ).rejects.toThrow(`${MAX_PLUGIN_SOURCE_DOWNLOAD_BYTES}-byte download limit`);
    expect(cancelled).toBe(true);
  });

  it("rejects gzip output beyond the decompressed archive limit", async () => {
    const target = "source-test-target";
    const bomb = gzipSync(new Uint8Array(MAX_PLUGIN_SOURCE_ARCHIVE_BYTES + 1));
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/bomb.tgz") return new Response(bomb);
      return json({
        versions: {
          "1.0.0": {
            version: "1.0.0",
            dist: {
              tarball: "https://registry.example.test/bomb.tgz",
              integrity: `sha512-${createHash("sha512").update(bomb).digest("base64")}`,
            },
          },
        },
      });
    }) as typeof fetch;

    await expect(
      resolvePluginSource("npm:gzip-bomb@1.0.0", {
        fetch: fetchSource,
        npmRegistry: "https://registry.example.test",
        target,
      }),
    ).rejects.toThrow(`${MAX_PLUGIN_SOURCE_ARCHIVE_BYTES}-byte decompressed limit`);
  });
});

describe("official Plugin Catalog setup", () => {
  it("authenticates and caches the Catalog, isolates probes, cleans staging, and supports both CLI selection modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-catalog-"));
    const configPath = join(directory, "config.json");
    await saveConfig(defaultConfig(), configPath);
    const target = "catalog-test-target";
    const definitions = [
      [
        "test.detected",
        `export default { async probe(context) { return { detected: (await context.findExecutable("detected")) !== null, compatible: true, version: "1.0.0" }; } };`,
      ],
      [
        "test.undetected",
        `export default { async probe(context) { return { detected: (await context.findExecutable("missing")) !== null, compatible: false }; } };`,
      ],
      ["test.failed", `export default { probe() { throw new Error("isolated probe boom"); } };`],
    ] as const;
    const catalogEntries: OfficialPluginCatalogV1["plugins"] = [];
    for (const [pluginId, probe] of definitions) {
      const path = join(directory, `${pluginId}.connect-plugin`);
      await writeFile(path, JSON.stringify(sourceBundle(pluginId, "1.0.0", target, probe)));
      catalogEntries.push({ pluginId, name: pluginId, source: `local:${path}` });
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const unsigned: Omit<OfficialPluginCatalogV1, "signature"> = {
      format: CONNECT_PLUGIN_CATALOG_FORMAT,
      generatedAt: "2026-08-16T00:00:00.000Z",
      plugins: catalogEntries,
    };
    const catalog: OfficialPluginCatalogV1 = {
      ...unsigned,
      signature: sign(null, officialCatalogSigningPayload(unsigned), privateKey).toString("base64"),
    };
    const server = Bun.serve({ port: 0, fetch: () => json(catalog) });
    const catalogUrl = new URL("/catalog.json", server.url).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const options = {
      target,
      catalogUrl,
      catalogPublicKey: publicKeyPem,
      findExecutable: async (command: string) => (command === "detected" ? "/fake/bin/detected" : null),
    };
    const remote = await discoverOfficialPlugins(configPath, options);
    expect(remote.catalogOrigin).toBe("remote");
    expect(remote.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: "test.detected", detected: true, compatible: true, selected: true }),
        expect.objectContaining({ pluginId: "test.undetected", detected: false, selected: false, selectable: true }),
        expect.objectContaining({
          pluginId: "test.failed",
          selected: false,
          diagnostic: expect.stringContaining("isolated probe boom"),
        }),
      ]),
    );
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, undefined, options);
    const managedDiscovery = await host.discoverOfficial();
    expect(managedDiscovery.candidates.find((candidate) => candidate.pluginId === "test.detected")?.selected).toBe(
      true,
    );
    await expect(host.installOfficial(["test.detected"])).resolves.toEqual([
      expect.objectContaining({ pluginId: "test.detected", version: "1.0.0", status: "active" }),
    ]);
    await host.close();
    await expect(access(join(pluginInstallationPaths(configPath).store, ".official-staging"))).rejects.toThrow();
    const offlineSetupConfigPath = join(directory, "offline-setup", "config.json");
    await saveConfig(defaultConfig(), offlineSetupConfigPath);
    const offlineOutput: string[] = [];
    await expect(
      runConnectCli(
        ["plugin", "setup", "--non-interactive", "--select", "test.detected", "--config", offlineSetupConfigPath],
        {
          pluginSourceOptions: options,
          pluginManagementFetch: async () => {
            throw new TypeError("Plugin Manager Service is offline");
          },
          writeStdout: (value) => offlineOutput.push(value),
          writeStderr: (value) => offlineOutput.push(value),
        },
      ),
    ).resolves.toBe(0);
    await expect(listInstalledPlugins(offlineSetupConfigPath)).resolves.toEqual([
      expect.objectContaining({ pluginId: "test.detected", version: "1.0.0", status: "active" }),
    ]);
    expect(offlineOutput.join(" ")).toContain("Installed Plugin test.detected@1.0.0");
    server.stop(true);

    const cached = await fetchOfficialPluginCatalog(configPath, {
      ...options,
      catalogFetch: async () => {
        throw new Error("catalog offline");
      },
    });
    expect(cached.origin).toBe("cache");
    expect(cached.diagnostics.join(" ")).toContain("continuing with the last authenticated Catalog cache");
    const unavailableConfigPath = join(directory, "no-cache", "config.json");
    const unavailable = await fetchOfficialPluginCatalog(unavailableConfigPath, {
      ...options,
      catalogFetch: async () => {
        throw new Error("catalog offline");
      },
    });
    expect(unavailable.catalog).toBeNull();
    expect(unavailable.diagnostics.join(" ")).toContain("Direct npm, GitHub, and local installation remain available");

    const discovery: OfficialPluginDiscovery = remote;
    const setupSelections: string[][] = [];
    const cliFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith("/plugins/official")) return json(discovery);
      if (path.endsWith("/plugins/official/setup")) {
        setupSelections.push((JSON.parse(String(init?.body)) as { pluginIds: string[] }).pluginIds);
        return json([]);
      }
      return json({ error: { message: "unexpected route" } }, 404);
    };
    const output: string[] = [];
    await expect(
      runConnectCli(["plugin", "setup", "--config", configPath], {
        pluginManagementFetch: cliFetch,
        readStdin: async () => "test.undetected\n",
        writeStdout: (value) => output.push(value),
        writeStderr: (value) => output.push(value),
      }),
    ).resolves.toBe(0);
    await expect(
      runConnectCli(
        [
          "plugin",
          "setup",
          "--non-interactive",
          "--select",
          "test.detected,test.undetected",
          "--deselect",
          "test.detected",
          "--config",
          configPath,
        ],
        {
          pluginManagementFetch: cliFetch,
          writeStdout: (value) => output.push(value),
          writeStderr: (value) => output.push(value),
        },
      ),
    ).resolves.toBe(0);
    expect(setupSelections).toEqual([["test.undetected"], ["test.undetected"]]);
    expect(output.join(" ")).toContain("[x] test.detected@1.0.0");
  });

  it("rejects an oversized declared Catalog body before reading and retains the authenticated cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-catalog-declared-limit-"));
    const configPath = join(directory, "config.json");
    await saveConfig(defaultConfig(), configPath);
    const { catalog, publicKey } = signedCatalogFixture();
    const options = {
      catalogUrl: "https://plugins.example.test/catalog.json",
      catalogPublicKey: publicKey,
    };
    await expect(
      fetchOfficialPluginCatalog(configPath, {
        ...options,
        catalogFetch: async () => json(catalog),
      }),
    ).resolves.toMatchObject({ origin: "remote", catalog });

    const oversized = await fetchOfficialPluginCatalog(configPath, {
      ...options,
      catalogFetch: async () =>
        new Response("not valid JSON", {
          headers: { "content-length": String(MAX_OFFICIAL_PLUGIN_CATALOG_BYTES + 1) },
        }),
    });

    expect(oversized).toMatchObject({ origin: "cache", catalog });
    expect(oversized.diagnostics.join(" ")).toContain(`${MAX_OFFICIAL_PLUGIN_CATALOG_BYTES}-byte download limit`);
  });

  it("cancels a lengthless Catalog stream when observed bytes cross the limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-catalog-stream-limit-"));
    const configPath = join(directory, "config.json");
    await saveConfig(defaultConfig(), configPath);
    const { publicKey } = signedCatalogFixture();
    const chunk = new Uint8Array(1024 * 1024);
    let cancelled = false;
    const result = await fetchOfficialPluginCatalog(configPath, {
      catalogUrl: "https://plugins.example.test/catalog.json",
      catalogPublicKey: publicKey,
      catalogFetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let sent = 0; sent <= MAX_OFFICIAL_PLUGIN_CATALOG_BYTES; sent += chunk.byteLength) {
                controller.enqueue(chunk);
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });

    expect(cancelled).toBe(true);
    expect(result.catalog).toBeNull();
    expect(result.origin).toBeNull();
    expect(result.diagnostics.join(" ")).toContain(`${MAX_OFFICIAL_PLUGIN_CATALOG_BYTES}-byte download limit`);
  });
});
