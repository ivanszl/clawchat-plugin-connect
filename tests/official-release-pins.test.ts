import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugins, discoverOfficialPluginDescriptors } from "../scripts/build-official-plugins";
import { loadBundledOfficialPlugins, resolveBundledOfficialPlugin } from "../src/plugin/official-registry";

describe("official Plugin release pins", () => {
  // A rebuilt official artifact with an unchanged version must carry a refreshed Core pin;
  // otherwise `plugin setup` fails with "entry artifact does not match the release-pinned integrity".
  it("every freshly built official Bundle resolves against the embedded registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-official-pins-"));
    const target = "linux-x64";
    const descriptors = await discoverOfficialPluginDescriptors();
    // The release build runs the in-process Vite build with NODE_ENV=production; `bun test` sets "test", which changes the client assets.
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const built = await buildOfficialPlugins(descriptors, { target, outputDirectory: directory }).finally(() => {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    });
    const registry = await loadBundledOfficialPlugins({ officialPluginsDirectory: directory, target });
    expect(registry.entries.map((entry) => entry.pluginId).sort()).toEqual(
      built.map((plugin) => plugin.descriptor.manifest.pluginId).sort(),
    );
    for (const entry of registry.entries) {
      const resolved = await resolveBundledOfficialPlugin(entry, { target }).catch((error: unknown) => error);
      if (resolved instanceof Error) throw new Error(`${entry.pluginId}@${entry.version}: ${resolved.message}`);
      expect(resolved).toBeDefined();
    }
  }, 120_000);
});
