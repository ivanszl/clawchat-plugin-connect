import type { WorkBuddyDiscoveryFailureCode } from "./workbuddy-task-discovery";

export type WorkBuddyCapabilityAvailability = "unsupported" | "unavailable" | "conflict";

export function workBuddyCapabilityAvailability(code: WorkBuddyDiscoveryFailureCode): WorkBuddyCapabilityAvailability {
  switch (code) {
    case "application-absent":
    case "wrong-distribution":
    case "incompatible-version":
    case "protocol-incompatible":
      return "unsupported";
    case "application-stopped":
    case "discovery-failed":
    case "endpoint-unavailable":
    case "endpoint-stale":
    case "recycled-endpoint":
    case "authentication-failed":
      return "unavailable";
    default:
      return "conflict";
  }
}
