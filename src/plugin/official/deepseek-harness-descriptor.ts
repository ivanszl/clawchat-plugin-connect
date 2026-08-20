import type { OfficialPluginDescriptor, OfficialPluginTarget } from "../../../scripts/build-official-plugins";
import { CONNECT_VERSION } from "../../service/version";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../sdk";
import {
  DEEPSEEK_HARNESS_BINDING_CONFIGURATION_SCHEMA,
  DEEPSEEK_HARNESS_INSTALLATION_CONFIGURATION_SCHEMA,
  DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
  DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
  DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY,
} from "./deepseek-harness-manifest";

const bridgeSources = Object.fromEntries(
  ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].map((target) => [
    target,
    "src/plugin/official/deepseek-harness-bridge.mjs",
  ]),
) as Record<OfficialPluginTarget, string>;

const descriptor: OfficialPluginDescriptor = {
  manifest: {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
    version: CONNECT_VERSION,
    dependencies: [
      {
        type: "host",
        id: "runtime-provider",
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      },
    ],
    installationConfigurationSchema: DEEPSEEK_HARNESS_INSTALLATION_CONFIGURATION_SCHEMA,
    capabilities: [
      {
        id: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
        type: "runtime",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        family: DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY,
        configurationSchema: DEEPSEEK_HARNESS_BINDING_CONFIGURATION_SCHEMA,
      },
    ],
  },
  assets: [{ entry: "artifacts/deepseek-harness-bridge.mjs", sources: bridgeSources }],
  entrypoint: "src/plugin/official/deepseek-harness-entry.ts",
};

export default descriptor;
