// PROTOTYPE — validates whether Agent Binding can be the ClawChat account isolation boundary.

export interface MultiAccountSnapshot {
  activations: Array<{ bindingId: string; ownerUserId: string; accessToken: string }>;
  sessions: Array<{ bindingId: string; visibleNames: string[] }>;
  messageHandling: Array<{ bindingId: string; handled: boolean }>;
  toolRequests: Array<{ bindingId: string; claimedBindingId: string | null }>;
  runtimeStatuses: Array<{ bindingId: string; connected: boolean | null }>;
  service: {
    startedBindingIds: string[];
    runtimeOwnerIds: string[];
    runtimeInstanceCount: number;
  };
}

export interface PrototypeAssessment {
  feasible: boolean;
  checks: Array<{ name: string; passed: boolean }>;
  snapshot: MultiAccountSnapshot;
}

export function assessMultiAccountSnapshot(snapshot: MultiAccountSnapshot): PrototypeAssessment {
  const checks = [
    {
      name: "two owners retain independent activation credentials",
      passed:
        snapshot.activations.length === 2 &&
        new Set(snapshot.activations.map((activation) => activation.ownerUserId)).size === 2 &&
        new Set(snapshot.activations.map((activation) => activation.accessToken)).size === 2,
    },
    {
      name: "each binding sees only its own Session",
      passed:
        snapshot.sessions.length === 2 &&
        snapshot.sessions.every(
          (entry) => entry.visibleNames.length === 1 && entry.visibleNames[0] === `${entry.bindingId} Session`,
        ),
    },
    {
      name: "the same ClawChat message id is handled independently",
      passed:
        snapshot.messageHandling.find((entry) => entry.bindingId === "personal")?.handled === true &&
        snapshot.messageHandling.find((entry) => entry.bindingId === "work")?.handled === false,
    },
    {
      name: "tool workers claim only their binding's request",
      passed: snapshot.toolRequests.every((entry) => entry.claimedBindingId === entry.bindingId),
    },
    {
      name: "runtime connection status remains binding-scoped",
      passed:
        snapshot.runtimeStatuses.find((entry) => entry.bindingId === "personal")?.connected === true &&
        snapshot.runtimeStatuses.find((entry) => entry.bindingId === "work")?.connected === false,
    },
    {
      name: "one Connect Service starts both owners with independent Runtime instances",
      passed:
        snapshot.service.startedBindingIds.join(",") === "personal,work" &&
        snapshot.service.runtimeOwnerIds.join(",") === "owner-personal,owner-work" &&
        snapshot.service.runtimeInstanceCount === 2,
    },
  ];
  return { feasible: checks.every((check) => check.passed), checks, snapshot };
}
