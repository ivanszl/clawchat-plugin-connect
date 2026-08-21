import type { WorkBuddyDiscoveryFailureCode } from "./workbuddy-task-discovery";

export type WorkBuddyCapabilityAvailability = "unsupported" | "unavailable" | "conflict";

const WORKBUDDY_DISCOVERY_FAILURE_CODES: Record<WorkBuddyDiscoveryFailureCode, true> = {
  "application-absent": true,
  "application-stopped": true,
  "discovery-failed": true,
  "wrong-distribution": true,
  "incompatible-version": true,
  "task-not-found": true,
  "workspace-identity-mismatch": true,
  "endpoint-unavailable": true,
  "non-loopback-endpoint": true,
  "endpoint-stale": true,
  "recycled-endpoint": true,
  "wrong-owning-process": true,
  "task-identity-mismatch": true,
  "task-replay-incomplete": true,
  "authentication-failed": true,
  "protocol-incompatible": true,
  "endpoint-verification-failed": true,
};

export interface WorkBuddyCapabilityFailure {
  code: WorkBuddyDiscoveryFailureCode;
  message: string;
}

export function workBuddyCapabilityFailure(error: unknown): WorkBuddyCapabilityFailure | null {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { cause?: unknown; code?: unknown; message?: unknown; name?: unknown };
    if (
      candidate.name === "WorkBuddyDiscoveryError" &&
      typeof candidate.code === "string" &&
      Object.hasOwn(WORKBUDDY_DISCOVERY_FAILURE_CODES, candidate.code) &&
      typeof candidate.message === "string"
    ) {
      return { code: candidate.code as WorkBuddyDiscoveryFailureCode, message: candidate.message };
    }
    current = candidate.cause;
  }
  return null;
}

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
