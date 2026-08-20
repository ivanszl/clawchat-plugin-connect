import type { ConnectPluginJsonSchema } from "../sdk";

export const DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID = "clawling.runtime.deepseek-harness" as const;
export const DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID = "deepseek-harness" as const;
export const DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY = "deepseek-harness" as const;

const nonBlankStringSchema = { type: "string", minLength: 1, pattern: "\\S" } as const;

export const DEEPSEEK_HARNESS_INSTALLATION_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    executablePath: nonBlankStringSchema,
  },
} as const satisfies ConnectPluginJsonSchema;

export const DEEPSEEK_HARNESS_BINDING_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    profile: nonBlankStringSchema,
    homePath: nonBlankStringSchema,
    executablePathOverride: nonBlankStringSchema,
    outputVisibility: { type: "string", enum: ["minimal", "normal", "full"] },
    displayName: { type: "string", minLength: 1 },
  },
} as const satisfies ConnectPluginJsonSchema;
