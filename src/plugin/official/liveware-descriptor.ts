import type { OfficialPluginDescriptor } from "../../../scripts/build-official-plugins";
import { CONNECT_VERSION } from "../../service/version";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../sdk";
import { OFFICIAL_LIVEWARE_VENDOR_SOURCES } from "./liveware-binaries";
import {
  LIVEWARE_DURABLE_STATE_SCHEMA,
  LIVEWARE_EXPOSURE_CONFIGURATION_SCHEMA,
  LIVEWARE_INSTALLATION_CONFIGURATION_SCHEMA,
  LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION,
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
        durableState: {
          schemaVersion: LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION,
          lifetime: "binding",
          schema: LIVEWARE_DURABLE_STATE_SCHEMA,
          migrations: [
            { from: 1, to: 2 },
            { from: 2, to: 3 },
          ],
        },
      },
    ],
  },
  assets: [
    {
      entry: "assets/liveware",
      sources: OFFICIAL_LIVEWARE_VENDOR_SOURCES,
    },
  ],
  entrypoint: "src/plugin/official/liveware-entry.ts",
};

export default descriptor;
