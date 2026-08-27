export const OFFICIAL_LIVEWARE_PLUGIN_ID = "clawling.exposure.liveware" as const;
export const OFFICIAL_LIVEWARE_CAPABILITY_ID = "liveware" as const;

export const LIVEWARE_INSTALLATION_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const LIVEWARE_EXPOSURE_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    accessPolicy: {
      type: "string",
      enum: ["private", "off"],
      default: "private",
      title: "Access policy",
      description: "Publish one private Liveware App per Agent Binding, or retire every publication.",
    },
  },
} as const;

export const LIVEWARE_PUBLICATION_STATE_SCHEMA_VERSION = 3 as const;

export const LIVEWARE_DURABLE_STATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    bindingId: { type: "string", minLength: 1 },
    activationGeneration: { type: "integer", minimum: 1 },
    desired: { type: "string", enum: ["private", "retired"] },
    status: { type: "string", enum: ["absent", "provisioning", "active", "degraded", "retiring", "retired"] },
    transition: {
      type: ["string", "null"],
      enum: ["create-app", "bind-tunnel", "register-launcher", "unregister-launcher", "delete-app", null],
    },
    selectedApp: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        pluginId: { type: "string", minLength: 1 },
        capabilityId: { type: "string", minLength: 1 },
        activationGeneration: { type: "integer", minimum: 1 },
        instanceKey: { type: "string", minLength: 1 },
        displayName: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
      },
      required: [
        "pluginId",
        "capabilityId",
        "activationGeneration",
        "instanceKey",
        "displayName",
        "description",
      ],
    },
    correlationKey: { type: "string", minLength: 1 },
    appId: { type: ["string", "null"] },
    publicUrl: { type: ["string", "null"] },
    registrationId: { type: ["string", "null"] },
    diagnostic: { type: ["string", "null"] },
  },
  required: [
    "bindingId",
    "activationGeneration",
    "desired",
    "status",
    "transition",
    "selectedApp",
    "correlationKey",
    "appId",
    "publicUrl",
    "registrationId",
    "diagnostic",
  ],
} as const;

export type OfficialLivewareAccessPolicy = "private" | "off";
