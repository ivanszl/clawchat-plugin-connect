import type { OfficialPluginDescriptor } from "../../../scripts/build-official-plugins";
import { CONNECT_VERSION } from "../../service/version";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../sdk";
import {
  WORKBUDDY_AI_CAPABILITY_ID,
  WORKBUDDY_BINDING_CONFIGURATION_SCHEMA,
  WORKBUDDY_CN_CAPABILITY_ID,
  WORKBUDDY_INSTALLATION_CONFIGURATION_SCHEMA,
  WORKBUDDY_OFFICIAL_PLUGIN_ID,
  WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
} from "./workbuddy-manifest";

const descriptor: OfficialPluginDescriptor = {
  supportedTargets: ["darwin-arm64", "darwin-x64"],
  manifest: {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID,
    version: CONNECT_VERSION,
    dependencies: [
      {
        type: "host",
        id: "runtime-provider",
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      },
    ],
    installationConfigurationSchema: WORKBUDDY_INSTALLATION_CONFIGURATION_SCHEMA,
    capabilities: [
      {
        id: WORKBUDDY_AI_CAPABILITY_ID,
        type: "runtime",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        family: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
        configurationSchema: WORKBUDDY_BINDING_CONFIGURATION_SCHEMA,
      },
      {
        id: WORKBUDDY_CN_CAPABILITY_ID,
        type: "runtime",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        family: WORKBUDDY_OFFICIAL_RUNTIME_FAMILY,
        configurationSchema: WORKBUDDY_BINDING_CONFIGURATION_SCHEMA,
      },
    ],
  },
  entrypoint: "src/plugin/official/workbuddy-entry.ts",
};

export default descriptor;
