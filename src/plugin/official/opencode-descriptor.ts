import type { OfficialPluginDescriptor } from "../../../scripts/build-official-plugins";
import { CONNECT_VERSION } from "../../service/version";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../sdk";
import {
  OPENCODE_BINDING_CONFIGURATION_SCHEMA,
  OPENCODE_INSTALLATION_CONFIGURATION_SCHEMA,
  OPENCODE_OFFICIAL_CAPABILITY_ID,
  OPENCODE_OFFICIAL_PLUGIN_ID,
  OPENCODE_OFFICIAL_RUNTIME_FAMILY,
  OPENCODE_WEB_APP_CAPABILITY_ID,
  OPENCODE_WEB_APP_CONFIGURATION_SCHEMA,
} from "./opencode-manifest";

const descriptor: OfficialPluginDescriptor = {
  manifest: {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
    version: CONNECT_VERSION,
    dependencies: [
      {
        type: "host",
        id: "runtime-provider",
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      },
      {
        type: "host",
        id: "managed-web-app-provider",
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      },
    ],
    installationConfigurationSchema: OPENCODE_INSTALLATION_CONFIGURATION_SCHEMA,
    capabilities: [
      {
        id: OPENCODE_OFFICIAL_CAPABILITY_ID,
        type: "runtime",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        family: OPENCODE_OFFICIAL_RUNTIME_FAMILY,
        configurationSchema: OPENCODE_BINDING_CONFIGURATION_SCHEMA,
      },
      {
        id: OPENCODE_WEB_APP_CAPABILITY_ID,
        type: "managed-web-app",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        configurationSchema: OPENCODE_WEB_APP_CONFIGURATION_SCHEMA,
        displayName: "OpenCode Web",
        description: "OpenCode's native Web interface",
        nativeRuntimeCapabilityIds: [OPENCODE_OFFICIAL_CAPABILITY_ID],
        compatibleRuntimes: [],
      },
    ],
  },
  entrypoint: "src/plugin/official/opencode-entry.ts",
};

export default descriptor;
