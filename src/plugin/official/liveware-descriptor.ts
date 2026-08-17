import type { OfficialPluginDescriptor } from "../../../scripts/build-official-plugins";
import { CONNECT_VERSION } from "../../service/version";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../sdk";
import {
  LIVEWARE_EXPOSURE_CONFIGURATION_SCHEMA,
  LIVEWARE_INSTALLATION_CONFIGURATION_SCHEMA,
  OFFICIAL_LIVEWARE_CAPABILITY_ID,
  OFFICIAL_LIVEWARE_PLUGIN_ID,
} from "./liveware-manifest";

const descriptor: OfficialPluginDescriptor = {
  manifest: {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: OFFICIAL_LIVEWARE_PLUGIN_ID,
    version: CONNECT_VERSION,
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
    installationConfigurationSchema: LIVEWARE_INSTALLATION_CONFIGURATION_SCHEMA,
    capabilities: [
      {
        id: OFFICIAL_LIVEWARE_CAPABILITY_ID,
        type: "exposure",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        configurationSchema: LIVEWARE_EXPOSURE_CONFIGURATION_SCHEMA,
      },
    ],
  },
  assets: [
    {
      entry: "assets/liveware",
      sources: {
        "darwin-arm64": "vendor/liveware/liveware-darwin-arm64",
        "darwin-x64": "vendor/liveware/liveware-darwin-amd64",
        "linux-arm64": "vendor/liveware/liveware-linux-arm64",
        "linux-x64": "vendor/liveware/liveware-linux-amd64",
        "win32-arm64": "vendor/liveware/liveware-windows-arm64.exe",
        "win32-x64": "vendor/liveware/liveware-windows-amd64.exe",
      },
    },
  ],
  entrypoint: "src/plugin/official/liveware-entry.ts",
};

export default descriptor;
