import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import deepSeekHarnessDescriptor from "../src/plugin/official/deepseek-harness-descriptor";
import { loadBundledOfficialPlugins, resolveBundledOfficialPlugin } from "../src/plugin/official-registry";

describe("official Plugin release pins", () => {
  // A rebuilt DSH artifact with an unchanged version must carry a refreshed Core pin;
  // otherwise `plugin setup` fails with "entry artifact does not match the release-pinned integrity".
  it("the freshly built DeepSeek Harness Bundle resolves against the embedded registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-official-dsh-pin-"));
    const target = "linux-x64";
    await buildOfficialPlugin(deepSeekHarnessDescriptor, { target, outputDirectory: directory });
    const registry = await loadBundledOfficialPlugins({ officialPluginsDirectory: directory, target });
    const entry = registry.entries.find((candidate) => candidate.pluginId === "clawling.runtime.deepseek-harness");
    if (!entry) throw new Error("DSH official entry is missing");
    await expect(resolveBundledOfficialPlugin(entry, { target })).resolves.toBeDefined();
  });
});
