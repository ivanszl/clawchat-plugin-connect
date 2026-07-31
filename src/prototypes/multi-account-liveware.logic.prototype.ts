// PROTOTYPE — validates the authorization boundary for per-Binding Liveware gateways.

export interface PrototypeBinding {
  bindingId: string;
  ownerUserId: string;
}

export interface PrototypeSession {
  bindingId: string;
  sessionRef: string;
  name: string;
}

export interface ScopedClientSnapshot {
  bindingId: string;
  bindings: PrototypeBinding[];
  projects: string[];
  sessions: PrototypeSession[];
}

export interface LivewareGatewayAssessment {
  feasible: boolean;
  checks: Array<{ name: string; passed: boolean }>;
  snapshots: ScopedClientSnapshot[];
  crossBindingStatuses: number[];
  exposurePorts: number[];
}

export function scopedSnapshot(
  scope: string,
  bindings: PrototypeBinding[],
  projects: string[],
  sessions: PrototypeSession[],
): ScopedClientSnapshot {
  return {
    bindingId: scope,
    bindings: bindings.filter((binding) => binding.bindingId === scope),
    projects,
    sessions: sessions.filter((session) => session.bindingId === scope),
  };
}

export function authorizeScopedSession(scope: string, session: PrototypeSession | undefined): boolean {
  return session?.bindingId === scope;
}

export function assessLivewareGateways(input: {
  snapshots: ScopedClientSnapshot[];
  crossBindingStatuses: number[];
  exposurePorts: number[];
}): LivewareGatewayAssessment {
  const checks = [
    {
      name: "each Liveware gateway exposes exactly one Agent Binding",
      passed: input.snapshots.every(
        (snapshot) => snapshot.bindings.length === 1 && snapshot.bindings[0]?.bindingId === snapshot.bindingId,
      ),
    },
    {
      name: "each Liveware gateway exposes only its Binding's Sessions",
      passed: input.snapshots.every(
        (snapshot) =>
          snapshot.sessions.length === 1 &&
          snapshot.sessions.every((session) => session.bindingId === snapshot.bindingId),
      ),
    },
    {
      name: "shared Projects remain visible through both gateways",
      passed: input.snapshots.every((snapshot) => snapshot.projects.join(",") === "shared-project,second-project"),
    },
    {
      name: "direct cross-Binding Session reads are rejected",
      passed: input.crossBindingStatuses.length === 2 && input.crossBindingStatuses.every((status) => status === 404),
    },
    {
      name: "the two Liveware Exposures terminate at distinct local gateways",
      passed: input.exposurePorts.length === 2 && new Set(input.exposurePorts).size === 2,
    },
  ];
  return {
    feasible: checks.every((check) => check.passed),
    checks,
    snapshots: input.snapshots,
    crossBindingStatuses: input.crossBindingStatuses,
    exposurePorts: input.exposurePorts,
  };
}
