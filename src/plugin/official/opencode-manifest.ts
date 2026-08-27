import type { ConnectPluginJsonSchema } from "../sdk";

export const OPENCODE_OFFICIAL_PLUGIN_ID = "clawling.runtime.opencode" as const;
export const OPENCODE_OFFICIAL_CAPABILITY_ID = "opencode" as const;
export const OPENCODE_OFFICIAL_RUNTIME_FAMILY = "opencode" as const;
export const OPENCODE_WEB_APP_CAPABILITY_ID = "opencode-web" as const;

const executablePathSchema = { type: "string", minLength: 1, pattern: "\\S" } as const;

const absolutePathSchema = {
  type: "string",
  minLength: 1,
  pattern: "^(?:/|[A-Za-z]:[\\\\/])",
} as const;

export const OPENCODE_INSTALLATION_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    executablePath: executablePathSchema,
  },
} as const satisfies ConnectPluginJsonSchema;

export const OPENCODE_BINDING_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    executablePathOverride: executablePathSchema,
    outputVisibility: { type: "string", enum: ["minimal", "normal", "full"] },
    displayName: { type: "string", minLength: 1 },
    additionalDirectories: {
      type: "array",
      items: absolutePathSchema,
    },
  },
} as const satisfies ConnectPluginJsonSchema;

export const OPENCODE_WEB_APP_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const satisfies ConnectPluginJsonSchema;
