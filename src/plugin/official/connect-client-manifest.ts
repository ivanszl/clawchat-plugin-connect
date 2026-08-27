import type { ConnectPluginJsonSchema, RuntimeCapabilityRef } from "../sdk";
import { CODEX_CAPABILITY_ID, CODEX_PLUGIN_ID } from "./codex-manifest";
import {
  WORKBUDDY_AI_CAPABILITY_ID,
  WORKBUDDY_CN_CAPABILITY_ID,
  WORKBUDDY_OFFICIAL_PLUGIN_ID,
} from "./workbuddy-manifest";

export const CONNECT_CLIENT_PLUGIN_ID = "clawling.web.connect-client" as const;
export const CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID = "connect-client" as const;

export const CONNECT_CLIENT_MANAGED_WEB_APP_REF = Object.freeze({
  pluginId: CONNECT_CLIENT_PLUGIN_ID,
  capabilityId: CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
}) satisfies Readonly<RuntimeCapabilityRef>;

export const CONNECT_CLIENT_SUPPORTED_RUNTIMES = Object.freeze([
  Object.freeze({ pluginId: CODEX_PLUGIN_ID, capabilityId: CODEX_CAPABILITY_ID }),
  Object.freeze({ pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID, capabilityId: WORKBUDDY_AI_CAPABILITY_ID }),
  Object.freeze({ pluginId: WORKBUDDY_OFFICIAL_PLUGIN_ID, capabilityId: WORKBUDDY_CN_CAPABILITY_ID }),
]) satisfies readonly Readonly<RuntimeCapabilityRef>[];

export const CONNECT_CLIENT_INSTALLATION_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    hostname: {
      type: "string",
      enum: ["127.0.0.1", "0.0.0.0"],
    },
    port: {
      type: "integer",
      minimum: 1_024,
      maximum: 65_535,
    },
  },
} as const satisfies ConnectPluginJsonSchema;

export const CONNECT_CLIENT_CAPABILITY_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const satisfies ConnectPluginJsonSchema;
