#!/usr/bin/env bun
// Release guard: every built official Plugin Bundle must satisfy the Core's embedded release pins,
// i.e. exactly what `clawchat-connect plugin setup` checks at startup. Usage: verify-official-pins.ts <official-plugins-dir> [target]
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadBundledOfficialPlugins, resolveBundledOfficialPlugin } from "../src/plugin/official-registry";

const directory = process.argv[2];
const target = process.argv[3] ?? `${process.platform}-${process.arch}`;
if (!directory) throw new Error("usage: verify-official-pins.ts <official-plugins-dir> [target]");
const built = (await readdir(directory)).filter((name) => name.endsWith(`-${target}.connect-plugin`));
const registry = await loadBundledOfficialPlugins({ officialPluginsDirectory: resolve(directory), target });
const failures: string[] = [];
if (registry.entries.length !== built.length) {
  failures.push(`${built.length} built bundle(s) for ${target} but ${registry.entries.length} match a release-registered version`);
}
for (const entry of registry.entries) {
  try {
    await resolveBundledOfficialPlugin(entry, { target });
    console.log(`ok ${entry.pluginId}@${entry.version} ${entry.integrity}`);
  } catch (error) {
    failures.push(`${entry.pluginId}@${entry.version}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failures.length > 0) {
  console.error(`Official Plugin pin check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
