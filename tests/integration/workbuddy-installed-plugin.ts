import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin } from "../../scripts/build-official-plugins";
import { createAgentBinding } from "../../src/plugin/binding";
import { ConnectPluginHost } from "../../src/plugin/host";
import workBuddyDescriptor from "../../src/plugin/official/workbuddy-descriptor";
import {
  WORKBUDDY_AI_CAPABILITY_ID,
  WORKBUDDY_CN_CAPABILITY_ID,
  WORKBUDDY_OFFICIAL_PLUGIN_ID,
} from "../../src/plugin/official/workbuddy-manifest";
import { installLocalPlugin } from "../../src/plugin/store";
import { RuntimeAdapterRegistry } from "../../src/runtime/registry";
import type { WorkBuddyProfile } from "../../src/runtime/workbuddy-task-discovery";
import type { AgentBindingConfig } from "../../src/types";

export interface InstalledWorkBuddyPluginRuntime {
  readonly binding: AgentBindingConfig;
  readonly runtimeAdapters: RuntimeAdapterRegistry;
  close(): Promise<void>;
}

export async function createInstalledWorkBuddyPluginRuntime(
  profile: WorkBuddyProfile,
): Promise<InstalledWorkBuddyPluginRuntime> {
  const directory = await mkdtemp(join(tmpdir(), `clawchat-${profile}-official-plugin-`));
  const configPath = join(directory, "config.json");
  const built = await buildOfficialPlugin(workBuddyDescriptor, { outputDirectory: directory });
  await installLocalPlugin({ configPath, bundlePath: built.outputPath });

  const runtimeAdapters = new RuntimeAdapterRegistry([]);
  const activationFailures: unknown[] = [];
  const pluginHost = new ConnectPluginHost(configPath, runtimeAdapters, (_pluginId, error) => {
    activationFailures.push(error);
  });
  try {
    await pluginHost.activateInstalled();
    if (activationFailures.length > 0) throw activationFailures[0];
  } catch (error) {
    await pluginHost.close().catch(() => undefined);
    await runtimeAdapters.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const capabilityId = profile === "workbuddy-ai" ? WORKBUDDY_AI_CAPABILITY_ID : WORKBUDDY_CN_CAPABILITY_ID;
  const binding = createAgentBinding({
    pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID,
    capabilityId,
  });
  return {
    binding,
    runtimeAdapters,
    async close() {
      await pluginHost.close();
      await runtimeAdapters.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
