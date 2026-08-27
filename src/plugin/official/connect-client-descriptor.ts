import { fileURLToPath } from "node:url";
import { build as buildWebAssets } from "vite";
import type { OfficialPluginDescriptor } from "../../../scripts/build-official-plugins";
import { CONNECT_VERSION } from "../../service/version";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../sdk";
import {
  CONNECT_CLIENT_CAPABILITY_CONFIGURATION_SCHEMA,
  CONNECT_CLIENT_INSTALLATION_CONFIGURATION_SCHEMA,
  CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
  CONNECT_CLIENT_PLUGIN_ID,
  CONNECT_CLIENT_SUPPORTED_RUNTIMES,
} from "./connect-client-manifest";
let preparedBrowserAssets: Promise<unknown> | null = null;


const connectClientDescriptor: OfficialPluginDescriptor = {
  manifest: {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId: CONNECT_CLIENT_PLUGIN_ID,
    version: CONNECT_VERSION,
    dependencies: [
      {
        type: "host",
        id: "managed-web-app-provider",
        interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      },
    ],
    installationConfigurationSchema: CONNECT_CLIENT_INSTALLATION_CONFIGURATION_SCHEMA,
    capabilities: [
      {
        id: CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
        type: "managed-web-app",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        configurationSchema: CONNECT_CLIENT_CAPABILITY_CONFIGURATION_SCHEMA,
        displayName: "ClawChat Connect Client",
        description: "ClawChat Connect's local browser client",
        nativeRuntimeCapabilityIds: [],
        compatibleRuntimes: CONNECT_CLIENT_SUPPORTED_RUNTIMES.map((runtime) => ({ ...runtime })),
      },
    ],
  },
  entrypoint: "src/plugin/official/connect-client-entry.ts",
  prepareAssets: async () => {
    preparedBrowserAssets ??= buildWebAssets({
      configFile: fileURLToPath(new URL("../../../vite.config.ts", import.meta.url)),
      configLoader: "runner",
    });
    await preparedBrowserAssets;
  },
  assetDirectories: [
    {
      entryPrefix: "client",
      sourceDirectory: "dist/client",
      integrityManifestEntry: "client-assets.json",
    },
  ],
};

export default connectClientDescriptor;
