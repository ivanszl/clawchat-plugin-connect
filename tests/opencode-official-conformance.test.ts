import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import { defaultConfig, saveConfig } from "../src/config";
import { createAgentBinding } from "../src/plugin/binding";
import { ConnectPluginHost } from "../src/plugin/host";
import descriptor from "../src/plugin/official/opencode-descriptor";
import { OPENCODE_OFFICIAL_CAPABILITY_ID, OPENCODE_OFFICIAL_PLUGIN_ID } from "../src/plugin/official/opencode-manifest";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { runtimeAdapterConformance } from "./runtime-adapter-conformance";

interface ConformanceState {
  active: boolean;
  closes: number;
  lifecycleCalls: string[];
  pending: boolean;
}

let nextInstance = 1;

runtimeAdapterConformance("installed official OpenCode Plugin", async () => {
  const instance = `installed-opencode-${nextInstance++}`;
  const directory = await mkdtemp(join(tmpdir(), "connect-opencode-installed-conformance-"));
  const configPath = join(directory, "config.json");
  const bundlePath = join(directory, "opencode.connect-plugin");
  const binding = createAgentBinding({
    pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
    capabilityId: OPENCODE_OFFICIAL_CAPABILITY_ID,
    configuration: { displayName: instance },
  });
  const config = defaultConfig();
  config.agents = { opencode: binding };
  config.defaultAgent = "opencode";
  await saveConfig(config, configPath);
  const built = await buildOfficialPlugin(
    { ...descriptor, entrypoint: "tests/fixtures/opencode-official-entry.ts" },
    { write: false },
  );
  await writeFile(bundlePath, `${JSON.stringify(built.bundle)}\n`);
  const registry = new RuntimeAdapterRegistry([]);
  const host = new ConnectPluginHost(configPath, registry, () => undefined);
  await host.install({ source: `local:${bundlePath}` });

  const states = Reflect.get(globalThis, "__connectOpenCodeOfficialConformance") as
    | Record<string, ConformanceState>
    | undefined;
  return {
    registry,
    binding,
    activateThread() {
      const current = states?.[instance];
      if (current) current.active = true;
    },
    closeCount: () => states?.[instance]?.closes ?? 0,
    failNextArchive() {},
    lifecycleCalls: () => states?.[instance]?.lifecycleCalls ?? [],
    async startPendingOperation() {
      const current = states?.[instance];
      if (!current) throw new Error("OpenCode conformance client was not prepared");
      current.pending = true;
      return await registry.listSessionOptions(binding, {
        workspaceRef: "WSDEFALT",
        workingDirectory: "/repo",
        skipGitRepoCheck: true,
      });
    },
  };
});
