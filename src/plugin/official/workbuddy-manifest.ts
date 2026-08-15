export const WORKBUDDY_OFFICIAL_PLUGIN_ID = "clawling.runtime.workbuddy" as const;
export const WORKBUDDY_OFFICIAL_RUNTIME_FAMILY = "workbuddy" as const;
export const WORKBUDDY_AI_CAPABILITY_ID = "workbuddy-ai" as const;
export const WORKBUDDY_CN_CAPABILITY_ID = "workbuddy-cn" as const;

export const WORKBUDDY_INSTALLATION_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const WORKBUDDY_BINDING_CONFIGURATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export interface OfficialWorkBuddyDistribution {
  readonly capabilityId: typeof WORKBUDDY_AI_CAPABILITY_ID | typeof WORKBUDDY_CN_CAPABILITY_ID;
  readonly profile: "workbuddy-ai" | "workbuddy-cn";
  readonly displayName: string;
  readonly applicationPath: string;
  readonly bundleIdentifier: string;
  readonly applicationVersion: string;
  readonly embeddedCodeBuddyVersion: string;
  readonly acpVersion: 1;
}

export const OFFICIAL_WORKBUDDY_DISTRIBUTIONS = [
  {
    capabilityId: WORKBUDDY_AI_CAPABILITY_ID,
    profile: "workbuddy-ai",
    displayName: "WorkBuddy AI",
    applicationPath: "/Applications/WorkBuddy AI.app",
    bundleIdentifier: "com.workbuddy.workbuddy-ai",
    applicationVersion: "5.2.7",
    embeddedCodeBuddyVersion: "2.106.4",
    acpVersion: 1,
  },
  {
    capabilityId: WORKBUDDY_CN_CAPABILITY_ID,
    profile: "workbuddy-cn",
    displayName: "WorkBuddy",
    applicationPath: "/Applications/WorkBuddy.app",
    bundleIdentifier: "com.workbuddy.workbuddy",
    applicationVersion: "5.3.8",
    embeddedCodeBuddyVersion: "2.115.0",
    acpVersion: 1,
  },
] as const satisfies readonly OfficialWorkBuddyDistribution[];
