import type { OfficialPluginDescriptor } from "../../../scripts/build-official-plugins";
import { CONNECT_VERSION } from "../../service/version";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../sdk";
import {
  CODEX_BINDING_CONFIGURATION_SCHEMA,
  CODEX_CAPABILITY_ID,
  CODEX_INSTALLATION_CONFIGURATION_SCHEMA,
  CODEX_PLUGIN_ID,
  CODEX_RUNTIME_FAMILY,
} from "./codex-manifest";

const codexDescriptor: OfficialPluginDescriptor = {
  manifest: {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: CODEX_PLUGIN_ID,
    version: CONNECT_VERSION,
    dependencies: [
      {
        type: "host",
        id: "runtime-provider",
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      },
    ],
    installationConfigurationSchema: CODEX_INSTALLATION_CONFIGURATION_SCHEMA,
    capabilities: [
      {
        id: CODEX_CAPABILITY_ID,
        type: "runtime",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        family: CODEX_RUNTIME_FAMILY,
        configurationSchema: CODEX_BINDING_CONFIGURATION_SCHEMA,
      },
    ],
  },
  entrypoint: "src/plugin/official/codex-entry.ts",
  probeEntrypoint: "src/plugin/official/codex-probe.ts",
};

export default codexDescriptor;
