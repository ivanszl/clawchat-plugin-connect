import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  buildOfficialPlugin,
  buildOfficialPlugins,
  discoverOfficialPluginDescriptors,
} from "../scripts/build-official-plugins";
import { MAX_PLUGIN_BUNDLE_BYTES } from "../src/client-contract";
import { defaultConfig, saveConfig } from "../src/config";
import codexDescriptor from "../src/plugin/official/codex-descriptor";
import {
  discoverOfficialPlugins,
  loadBundledOfficialPlugins,
  resolveBundledOfficialPlugin,
} from "../src/plugin/official-registry";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectPluginBundleV1,
} from "../src/plugin/sdk";
import {
  MAX_GITHUB_ASSET_ATTEMPTS,
  MAX_GITHUB_RELEASE_PAGES,
  MAX_PLUGIN_SOURCE_ARCHIVE_BYTES,
  MAX_PLUGIN_SOURCE_DOWNLOAD_BYTES,
  MAX_PLUGIN_SOURCE_METADATA_BYTES,
  resolvePluginSource,
} from "../src/plugin/source";
import { commitStagedPlugin, installPluginBundle, listInstalledPlugins, stagePluginBundle } from "../src/plugin/store";
import { runConnectCli } from "../src/service/cli";

function sri(source: string | Uint8Array): string {
  return `sha256-${createHash("sha256").update(source).digest("base64")}`;
}

function sourceBundle(pluginId: string, version: string, target: string): ConnectPluginBundleV1 {
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
    },
    files: {
      "plugin.mjs": { encoding: "utf8", content: entry },
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
    const resolveWithDigest = async (digest?: string, downloadedBytes = bytes, declaredLength?: number) =>
      await resolvePluginSource("github:acme/github-digest@v1.0.0", {
        target,
        githubApiBase: "https://api.example.test",
        fetch: (async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.hostname === "assets.example.test") {
            return new Response(
              downloadedBytes,
              declaredLength === undefined ? undefined : { headers: { "content-length": String(declaredLength) } },
            );
          }
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
    const malformedBytes = new TextEncoder().encode("not a Plugin Bundle");
    await expect(
      resolveWithDigest(`sha256:${createHash("sha256").update(malformedBytes).digest("hex")}`, malformedBytes),
    ).rejects.toThrow("is not valid JSON");
    await expect(resolveWithDigest(expectedDigest, new Uint8Array(), MAX_PLUGIN_BUNDLE_BYTES + 1)).rejects.toThrow(
      `${MAX_PLUGIN_BUNDLE_BYTES}-byte download limit`,
    );
  });

  it("follows bounded GitHub Release pages and selects a generic filename by its manifest target", async () => {
    const target = "source-test-target";
    const compatibleBundle = sourceBundle("test.github-paginated", "100.0.0", target);
    const compatibleBytes = new TextEncoder().encode(JSON.stringify(compatibleBundle));
    const firstPage = Array.from({ length: 101 }, (_, index) => ({
      tag_name: `v${201 - index}.0.0`,
      draft: false,
      prerelease: false,
      assets: [],
    }));
    const secondPage = [
      {
        tag_name: "v100.0.0",
        draft: false,
        prerelease: false,
        assets: [
          {
            name: "bundle.connect-plugin",
            browser_download_url: "https://assets.example.test/generic",
            digest: `sha256:${createHash("sha256").update(compatibleBytes).digest("hex")}`,
          },
        ],
      },
    ];
    const metadataRequests: string[] = [];
    const assetRequests: string[] = [];
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "assets.example.test") {
        assetRequests.push(url.pathname);
        return new Response(compatibleBytes);
      }
      metadataRequests.push(url.toString());
      if (url.searchParams.get("page") === "2") return json(secondPage);
      return new Response(JSON.stringify(firstPage), {
        headers: {
          Link: `<${url.origin}${url.pathname}?per_page=100&page=2>; rel="next", <${url.origin}${url.pathname}?per_page=100&page=2>; rel="last"`,
        },
      });
    }) as typeof fetch;

    await expect(
      resolvePluginSource("github:acme/github-paginated", {
        fetch: fetchSource,
        githubApiBase: "https://api.example.test",
        target,
      }),
    ).resolves.toMatchObject({
      source: { type: "github", version: "100.0.0", release: "v100.0.0" },
      bundle: { manifest: { pluginId: "test.github-paginated" } },
    });
    expect(metadataRequests).toHaveLength(2);
    expect(assetRequests).toEqual(["/generic"]);
  });

  it("reports bounded GitHub search exhaustion instead of definitive incompatibility", async () => {
    let metadataRequests = 0;
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      metadataRequests += 1;
      const page = Number(url.searchParams.get("page") ?? "1");
      const nextPage = page + 1;
      return new Response("[]", {
        headers: {
          Link: `<${url.origin}${url.pathname}?per_page=100&page=${nextPage}>; rel="next"`,
        },
      });
    }) as typeof fetch;

    await expect(
      resolvePluginSource("github:acme/github-page-bound", {
        fetch: fetchSource,
        githubApiBase: "https://api.example.test",
        target: "source-test-target",
      }),
    ).rejects.toThrow(
      `search bound exhausted before compatibility could be determined: the ${MAX_GITHUB_RELEASE_PAGES}-page Release metadata limit was reached while another page remained`,
    );
    expect(metadataRequests).toBe(MAX_GITHUB_RELEASE_PAGES);
  });

  it("bounds exhaustive GitHub asset evaluation without issuing unbounded downloads", async () => {
    let assetRequests = 0;
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "assets.example.test") {
        assetRequests += 1;
        throw new Error("Asset without integrity must not be downloaded");
      }
      return json([
        {
          tag_name: "v1.0.0",
          draft: false,
          prerelease: false,
          assets: Array.from({ length: MAX_GITHUB_ASSET_ATTEMPTS + 1 }, (_, index) => ({
            name: `bundle-${String(index).padStart(3, "0")}.connect-plugin`,
            browser_download_url: `https://assets.example.test/${index}`,
          })),
        },
      ]);
    }) as typeof fetch;

    await expect(
      resolvePluginSource("github:acme/github-asset-bound", {
        fetch: fetchSource,
        githubApiBase: "https://api.example.test",
        target: "source-test-target",
      }),
    ).rejects.toThrow(
      `search bound exhausted before compatibility could be determined: the ${MAX_GITHUB_ASSET_ATTEMPTS}-asset attempt limit was reached`,
    );
    expect(assetRequests).toBe(0);
  });

  it("selects a fifth compatible stable npm Bundle and keeps exact versions to one candidate", async () => {
    const target = "source-test-target";
    const versions = ["5.0.0", "4.0.0", "3.0.0", "2.0.0", "1.0.0"];
    const compatibleVersion = versions[4];
    if (!compatibleVersion) throw new Error("Invalid npm compatibility fixture");
    const artifacts = new Map<string, Uint8Array>();
    const metadata = {
      "dist-tags": { latest: versions[0] },
      versions: Object.fromEntries(
        versions.map((version) => {
          const bytes = tarball(
            sourceBundle("test.npm-fifth-compatible", version, version === compatibleVersion ? target : "other-target"),
          );
          artifacts.set(version, bytes);
          return [
            version,
            {
              version,
              dist: {
                tarball: `https://registry.example.test/tarballs/${version}.tgz`,
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
              },
            },
          ];
        }),
      ),
    };
    const downloads: string[] = [];
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const match = url.pathname.match(/^\/tarballs\/([^/]+)\.tgz$/u);
      if (match?.[1]) {
        downloads.push(match[1]);
        const bytes = artifacts.get(match[1]);
        return bytes ? new Response(new Uint8Array(bytes)) : json({ error: "not found" }, 404);
      }
      return json(metadata);
    }) as typeof fetch;
    const options = {
      fetch: fetchSource,
      npmRegistry: "https://registry.example.test",
      target,
    };

    await expect(resolvePluginSource("npm:npm-fifth-compatible", options)).resolves.toMatchObject({
      source: { type: "npm", version: compatibleVersion },
    });
    expect(downloads).toEqual(versions);

    downloads.length = 0;
    await expect(resolvePluginSource("npm:npm-fifth-compatible@3.0.0", options)).rejects.toThrow(
      "after 1 candidate attempt",
    );
    expect(downloads).toEqual(["3.0.0"]);
  });

  it("evaluates every discovered GitHub Bundle by its authoritative manifest target", async () => {
    const target = "source-test-target";
    const versions = ["5.0.0", "4.0.0", "3.0.0", "2.0.0", "1.0.0"];
    const compatibleVersion = versions[4];
    if (!compatibleVersion) throw new Error("Invalid GitHub compatibility fixture");
    const assets = new Map<string, Uint8Array>();
    const releases = [...versions].reverse().map((version) => {
      const targetBytes = new TextEncoder().encode(
        JSON.stringify(
          sourceBundle(
            "test.github-fifth-compatible",
            version,
            version === compatibleVersion ? target : "other-target",
          ),
        ),
      );
      const nonTargetBytes = new TextEncoder().encode(
        JSON.stringify(sourceBundle("test.github-fifth-compatible", version, "linux-x64")),
      );
      assets.set(`${version}/target`, targetBytes);
      assets.set(`${version}/non-target`, nonTargetBytes);
      return {
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: "github-fifth-compatible-linux-x64.connect-plugin",
            browser_download_url: `https://assets.example.test/${version}/non-target`,
            digest: `sha256:${createHash("sha256").update(nonTargetBytes).digest("hex")}`,
          },
          {
            name: `github-fifth-compatible-${target}.connect-plugin`,
            browser_download_url: `https://assets.example.test/${version}/target`,
            digest: `sha256:${createHash("sha256").update(targetBytes).digest("hex")}`,
          },
        ],
      };
    });
    const downloads: string[] = [];
    const fetchSource = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "assets.example.test") {
        const assetPath = url.pathname.slice(1);
        downloads.push(assetPath);
        const bytes = assets.get(assetPath);
        return bytes ? new Response(new Uint8Array(bytes)) : json({ error: "not found" }, 404);
      }
      const exact = url.pathname.match(/^\/repos\/acme\/github-fifth-compatible\/releases\/tags\/(.+)$/u);
      if (exact?.[1]) {
        const tag = decodeURIComponent(exact[1]).replace(/^v/u, "");
        return json(releases.find((release) => release.tag_name === `v${tag}`) ?? {}, 200);
      }
      return json(releases);
    }) as typeof fetch;
    const options = {
      fetch: fetchSource,
      githubApiBase: "https://api.example.test",
      target,
    };

    await expect(resolvePluginSource("github:acme/github-fifth-compatible", options)).resolves.toMatchObject({
      source: { type: "github", version: compatibleVersion, release: `v${compatibleVersion}` },
    });
    expect(downloads).toEqual(versions.flatMap((version) => [`${version}/non-target`, `${version}/target`]));

    downloads.length = 0;
    await expect(resolvePluginSource("github:acme/github-fifth-compatible@3.0.0", options)).rejects.toThrow(
      "across 1 of 1 Release candidates",
    );
    expect(downloads).toEqual(["3.0.0/non-target", "3.0.0/target"]);
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

describe("bundled official Plugin setup", () => {
  it("discovers and installs the packaged official Bundle without network access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-bundled-official-"));
    const configPath = join(directory, "config.json");
    const officialPluginsDirectory = join(directory, "official-plugins");
    await saveConfig(defaultConfig(), configPath);
    await buildOfficialPlugin(codexDescriptor, {
      target: `${process.platform}-${process.arch}`,
      outputDirectory: officialPluginsDirectory,
    });

    const options = {
      officialPluginsDirectory,
      findExecutable: async (command: string) => (command === "codex" ? "/fake/bin/codex" : null),
      runDiscoveryCommand: async () => ({ stdout: "codex-cli 1.2.3" }),
      fetch: Object.assign(
        async () => {
          throw new Error("network must not be used");
        },
        { preconnect: fetch.preconnect },
      ),
    };
    const discovery = await discoverOfficialPlugins(options);
    expect(discovery.officialSource).toBe("bundled");
    expect(discovery.diagnostics).toEqual([]);
    expect(discovery.candidates).toEqual([
      expect.objectContaining({
        pluginId: "clawling.runtime.codex",
        detected: true,
        compatible: true,
        selected: true,
        resolvedSource: null,
        manifest: expect.objectContaining({ pluginId: "clawling.runtime.codex" }),
      }),
    ]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runConnectCli(
      ["plugin", "setup", "--non-interactive", "--select", "clawling.runtime.codex", "--config", configPath],
      {
        pluginSourceOptions: options,
        pluginManagementFetch: async () => {
          throw new Error("offline Plugin manager");
        },
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
      },
    );
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: [] });
    expect(stdout.join("")).toContain("Installed Plugin clawling.runtime.codex");
    await expect(listInstalledPlugins(configPath)).resolves.toEqual([
      expect.objectContaining({ pluginId: "clawling.runtime.codex", status: "active" }),
    ]);
  });

  it("defers Bundle validation until a release-packaged candidate is selected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-bundled-official-pin-"));
    const target = `${process.platform}-${process.arch}`;
    const built = await buildOfficialPlugin(codexDescriptor, {
      target,
      outputDirectory: directory,
    });
    const bundle = JSON.parse(await readFile(built.outputPath, "utf8")) as ConnectPluginBundleV1;
    const artifact = bundle.manifest.artifacts[0];
    const entry = artifact?.entry;
    if (!entry) throw new Error("official Codex fixture has no entry");
    const original = bundle.files[entry];
    if (original?.encoding !== "utf8") throw new Error("official Codex entry is not text");
    const substituted = `${original.content}\n// substituted`;
    bundle.files[entry] = { encoding: "utf8", content: substituted };
    bundle.manifest.artifacts[0] = {
      ...artifact,
      integrity: sri(substituted),
    };
    await writeFile(built.outputPath, `${JSON.stringify(bundle, null, 2)}\n`);

    const loaded = await loadBundledOfficialPlugins({
      officialPluginsDirectory: directory,
      target,
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.entries).toEqual([
      expect.objectContaining({
        pluginId: "clawling.runtime.codex",
        integrity: "sha256-oVPqU29N7c1bvTyrykkbHHngxTVFvN9KaPf1dWdSNWI=",
      }),
    ]);
    const candidate = loaded.entries[0];
    if (!candidate) throw new Error("official Codex candidate is missing");
    await expect(resolveBundledOfficialPlugin(candidate, { target })).rejects.toThrow(
      "does not match the release-pinned integrity",
    );
  });

  it("isolates bounded discovery failures and preselects every compatible official Runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-bundled-official-rules-"));
    const target = "darwin-arm64";
    const descriptors = await discoverOfficialPluginDescriptors();
    await buildOfficialPlugins(descriptors, { target, outputDirectory: directory });
    const base = { officialPluginsDirectory: directory, target };
    const executable = (command: string) => {
      if (command === "codex") return "/fake/bin/codex";
      if (command === "opencode") return "/fake/bin/opencode";
      if (command === "/Applications/WorkBuddy AI.app") return command;
      return null;
    };

    const detected = await discoverOfficialPlugins({
      ...base,
      findExecutable: async (command) => executable(command),
      runDiscoveryCommand: async ({ executable: path }) => ({
        stdout: path.endsWith("codex") ? "codex-cli 1.2.3" : "opencode 7.42.3",
      }),
    });
    expect(
      detected.candidates
        .filter((candidate) => candidate.selected)
        .map((candidate) => candidate.pluginId)
        .sort(),
    ).toEqual(["clawling.runtime.codex", "clawling.runtime.opencode", "clawling.runtime.workbuddy"]);
    expect(detected.candidates.find((candidate) => candidate.pluginId === "clawling.exposure.liveware")).toMatchObject({
      detected: false,
      selected: false,
      selectable: true,
    });

    const missed = await discoverOfficialPlugins({
      ...base,
      findExecutable: async () => null,
    });
    expect(
      missed.candidates
        .filter((candidate) => candidate.discovery !== null)
        .every((candidate) => !candidate.detected && !candidate.selected),
    ).toBe(true);

    const malformed = await discoverOfficialPlugins({
      ...base,
      findExecutable: async (command) => executable(command),
      runDiscoveryCommand: async () => ({ stdout: "not-a-compatible-version" }),
    });
    expect(
      malformed.candidates
        .filter((candidate) => candidate.pluginId !== "clawling.runtime.workbuddy" && candidate.discovery !== null)
        .every((candidate) => candidate.detected && !candidate.compatible && !candidate.selected),
    ).toBe(true);

    const overflow = await discoverOfficialPlugins({
      ...base,
      findExecutable: async (command) => executable(command),
      runDiscoveryCommand: async () => ({ stdout: "x".repeat(4_097) }),
    });
    expect(
      overflow.candidates
        .filter((candidate) => candidate.pluginId !== "clawling.runtime.workbuddy" && candidate.discovery !== null)
        .every((candidate) => candidate.diagnostic?.includes("output limit")),
    ).toBe(true);

    const isolated = await discoverOfficialPlugins({
      ...base,
      findExecutable: async (command) => executable(command),
      runDiscoveryCommand: async ({ executable: path }) => {
        if (path.endsWith("codex")) throw new Error("isolated Codex failure");
        return { stdout: "1.18.10" };
      },
    });
    expect(isolated.candidates.find((candidate) => candidate.pluginId === "clawling.runtime.codex")).toMatchObject({
      selected: false,
      diagnostic: expect.stringContaining("isolated Codex failure"),
    });
    expect(isolated.candidates.find((candidate) => candidate.pluginId === "clawling.runtime.opencode")).toMatchObject({
      compatible: true,
      selected: true,
    });
  });

  it("times out one official discovery command without aborting later candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-bundled-official-timeout-"));
    const target = `${process.platform}-${process.arch}`;
    await buildOfficialPlugin(codexDescriptor, { target, outputDirectory: directory });
    const discovery = await discoverOfficialPlugins({
      officialPluginsDirectory: directory,
      target,
      findExecutable: async () => "/fake/bin/codex",
      runDiscoveryCommand: async () => await Promise.withResolvers<{ readonly stdout: string }>().promise,
    });

    expect(discovery.candidates).toEqual([
      expect.objectContaining({
        pluginId: "clawling.runtime.codex",
        selected: false,
        diagnostic: expect.stringContaining("timed out"),
      }),
    ]);
  }, 7_000);
});
