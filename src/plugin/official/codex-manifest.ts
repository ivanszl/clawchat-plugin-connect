import type { ConnectPluginJsonSchema } from "../sdk";

export const CODEX_PLUGIN_ID = "clawling.runtime.codex" as const;
export const CODEX_CAPABILITY_ID = "codex" as const;
export const CODEX_RUNTIME_FAMILY = "codex" as const;

const stringRecordSchema = {
  type: "object",
  additionalProperties: { type: "string" },
} as const satisfies ConnectPluginJsonSchema;

export const CODEX_INSTALLATION_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    executablePath: { type: "string", minLength: 1 },
  },
} as const satisfies ConnectPluginJsonSchema;

export const CODEX_BINDING_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    executablePathOverride: { type: "string", minLength: 1 },
    codexPathOverride: { type: "string", minLength: 1 },
    env: stringRecordSchema,
    displayName: { type: "string", minLength: 1 },
    sandboxMode: { enum: ["read-only", "workspace-write", "danger-full-access"] },
    approvalPolicy: { enum: ["never", "on-request", "untrusted"], default: "on-request" },
    webSearchMode: { enum: ["disabled", "cached", "live"] },
    networkAccessEnabled: { type: "boolean" },
    additionalDirectories: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
    outputVisibility: { enum: ["minimal", "normal", "full"] },
    sessionOptions: stringRecordSchema,
  },
} as const satisfies ConnectPluginJsonSchema;
