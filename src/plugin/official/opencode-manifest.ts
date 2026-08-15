import type { ConnectPluginJsonSchema } from "../sdk";

export const OPENCODE_OFFICIAL_PLUGIN_ID = "clawling.runtime.opencode" as const;
export const OPENCODE_OFFICIAL_CAPABILITY_ID = "opencode" as const;
export const OPENCODE_OFFICIAL_RUNTIME_FAMILY = "opencode" as const;

const MANAGED_SERVER_ENVIRONMENT = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_HOSTNAME",
  "OPENCODE_SERVER_PORT",
  "OPENCODE_SERVER_CORS",
  "OPENCODE_SERVER_MDNS",
] as const;

const environmentSchema = {
  type: "object",
  propertyNames: { not: { enum: MANAGED_SERVER_ENVIRONMENT } },
  additionalProperties: { type: "string" },
} as const satisfies ConnectPluginJsonSchema;

const executablePathSchema = { type: "string", minLength: 1, pattern: "\\S" } as const;

const absolutePathSchema = {
  type: "string",
  minLength: 1,
  anyOf: [{ pattern: "^/" }, { pattern: "^[A-Za-z]:[\\\\/]" }],
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
    outputVisibility: { enum: ["minimal", "normal", "full"] },
    env: environmentSchema,
    displayName: { type: "string", minLength: 1 },
    additionalDirectories: {
      type: "array",
      items: absolutePathSchema,
      uniqueItems: true,
    },
    sessionOptions: {
      type: "object",
      propertyNames: { type: "string", minLength: 1 },
      additionalProperties: { type: "string", minLength: 1 },
    },
  },
} as const satisfies ConnectPluginJsonSchema;
