export const WORKBUDDY_AI_COMPATIBILITY = {
  profile: "workbuddy-ai",
  bundleIdentifier: "com.workbuddy.workbuddy-ai",
  applicationVersion: "5.2.7",
  embeddedCodeBuddyVersion: "2.106.4",
  sidecarVersion: 1,
  acpVersion: 1,
} as const;

export type WorkbuddyProfile = typeof WORKBUDDY_AI_COMPATIBILITY.profile;

export interface WorkbuddyProcessIdentity {
  pid: number;
  parentPid: number;
  executablePath: string;
  ancestorPids?: number[];
}

export interface WorkbuddyDiscoveryObservation {
  application: {
    path: string;
    bundleIdentifier: string;
    version: string;
    embeddedCodeBuddyVersion: string;
  } | null;
  applicationProcess: WorkbuddyProcessIdentity | null;
  task: { id: string; workspace: string } | null;
  sidecarRegistration: { pid: number; token: string; version: number } | null;
  sidecarIdentity: { pid: number; token: string; version: number } | null;
  sidecarProcess: WorkbuddyProcessIdentity | null;
  endpointSession: { sessionId: string; pid: number; endpoint: string } | null;
  endpointOwner: WorkbuddyProcessIdentity | null;
}

export interface WorkbuddyEndpointVerification {
  taskId: string;
  workspace?: string;
  replayStarted: boolean;
  replayCompleted: boolean;
}

export interface WorkbuddyTaskDiscoverySource {
  inspect(input: WorkbuddyTaskDiscoveryInput): Promise<WorkbuddyDiscoveryObservation>;
  canonicalizeWorkspace?(workspace: string): Promise<string>;
  verifyEndpoint(input: {
    endpoint: string;
    taskId: string;
    workspace: string;
    acpVersion: number;
  }): Promise<WorkbuddyEndpointVerification>;
}

export interface WorkbuddyTaskDiscoveryInput {
  profile: WorkbuddyProfile;
  taskId: string;
  expectedWorkspace: string;
}

export interface DiscoveredWorkbuddyTask {
  profile: WorkbuddyProfile;
  application: {
    path: string;
    version: string;
    embeddedCodeBuddyVersion: string;
    processId: number;
  };
  task: { id: string; workspace: string };
  owner: { sidecarProcessId: number; endpointProcessId: number };
  endpoint: string;
}

export type WorkbuddyDiscoveryFailureCode =
  | "application-absent"
  | "application-stopped"
  | "wrong-distribution"
  | "incompatible-version"
  | "task-not-found"
  | "workspace-identity-mismatch"
  | "endpoint-unavailable"
  | "non-loopback-endpoint"
  | "endpoint-stale"
  | "recycled-endpoint"
  | "wrong-owning-process"
  | "task-identity-mismatch"
  | "task-replay-incomplete"
  | "endpoint-verification-failed";

export class WorkbuddyDiscoveryError extends Error {
  readonly name = "WorkbuddyDiscoveryError";

  constructor(
    readonly code: WorkbuddyDiscoveryFailureCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export async function discoverWorkbuddyTask(
  input: WorkbuddyTaskDiscoveryInput,
  source: WorkbuddyTaskDiscoverySource,
): Promise<DiscoveredWorkbuddyTask> {
  const observation = await source.inspect(input);
  const application = observation.application;
  if (!application) {
    throw failure(
      "application-absent",
      "WorkBuddy AI is not installed at the selected application path; install WorkBuddy AI 5.2.7.",
    );
  }
  if (application.bundleIdentifier !== WORKBUDDY_AI_COMPATIBILITY.bundleIdentifier) {
    throw failure("wrong-distribution", "The selected application is not the WorkBuddy AI distribution.", {
      selectedProfile: input.profile,
      detectedBundleIdentifier: application.bundleIdentifier,
    });
  }
  if (
    application.version !== WORKBUDDY_AI_COMPATIBILITY.applicationVersion ||
    application.embeddedCodeBuddyVersion !== WORKBUDDY_AI_COMPATIBILITY.embeddedCodeBuddyVersion
  ) {
    throw failure("incompatible-version", "The installed WorkBuddy AI compatibility tuple is unsupported.", {
      selectedProfile: input.profile,
      detectedApplicationVersion: application.version,
      detectedEmbeddedCodeBuddyVersion: application.embeddedCodeBuddyVersion,
      supportedApplicationVersion: WORKBUDDY_AI_COMPATIBILITY.applicationVersion,
      supportedEmbeddedCodeBuddyVersion: WORKBUDDY_AI_COMPATIBILITY.embeddedCodeBuddyVersion,
    });
  }
  const applicationProcess = observation.applicationProcess;
  if (!applicationProcess) {
    throw failure(
      "application-stopped",
      "WorkBuddy AI is installed but not running; open it before discovering a Task.",
    );
  }
  if (!ownedExecutable(applicationProcess, application.path)) {
    throw failure(
      "wrong-owning-process",
      "The running application process is not owned by the selected WorkBuddy AI bundle.",
    );
  }

  const task = observation.task;
  if (!task || task.id !== input.taskId) {
    throw failure("task-not-found", "The requested Task is not present in WorkBuddy AI's authoritative Task store.", {
      taskId: input.taskId,
    });
  }
  const authoritativeWorkspace = source.canonicalizeWorkspace
    ? await source.canonicalizeWorkspace(task.workspace)
    : task.workspace;
  const expectedWorkspace = source.canonicalizeWorkspace
    ? await source.canonicalizeWorkspace(input.expectedWorkspace)
    : input.expectedWorkspace;
  if (authoritativeWorkspace !== expectedWorkspace) {
    throw failure(
      "workspace-identity-mismatch",
      "The requested workspace does not match WorkBuddy AI's Task metadata.",
      {
        taskId: task.id,
        expectedWorkspace,
        authoritativeWorkspace,
      },
    );
  }

  const registration = observation.sidecarRegistration;
  const sidecarIdentity = observation.sidecarIdentity;
  if (!registration || !sidecarIdentity || !observation.sidecarProcess) {
    throw failure(
      "endpoint-unavailable",
      "WorkBuddy AI is running but its deterministic sidecar control surface is unavailable.",
    );
  }
  if (
    registration.pid !== sidecarIdentity.pid ||
    registration.version !== sidecarIdentity.version ||
    registration.token !== sidecarIdentity.token
  ) {
    throw failure(
      "endpoint-stale",
      "WorkBuddy AI's sidecar registration no longer identifies the live control socket.",
    );
  }
  if (
    registration.version !== WORKBUDDY_AI_COMPATIBILITY.sidecarVersion ||
    !ownedExecutable(observation.sidecarProcess, application.path) ||
    !isDescendant(observation.sidecarProcess, applicationProcess)
  ) {
    throw failure(
      "wrong-owning-process",
      "The sidecar control surface is not owned by the selected WorkBuddy AI process.",
    );
  }

  const endpointSession = observation.endpointSession;
  if (!endpointSession) {
    throw failure(
      "endpoint-unavailable",
      "WorkBuddy AI has no active Task ACP host; keep the application and a Task open.",
    );
  }
  assertLoopbackEndpoint(endpointSession.endpoint);
  const endpointOwner = observation.endpointOwner;
  if (!endpointOwner) {
    throw failure("endpoint-stale", "The discovered WorkBuddy AI ACP endpoint is no longer listening.");
  }
  if (endpointOwner.pid !== endpointSession.pid) {
    throw failure("recycled-endpoint", "The discovered ACP port is now owned by another process.", {
      expectedProcessId: endpointSession.pid,
      detectedProcessId: endpointOwner.pid,
    });
  }
  if (!ownedExecutable(endpointOwner, application.path) || !isDescendant(endpointOwner, observation.sidecarProcess)) {
    throw failure(
      "wrong-owning-process",
      "The ACP endpoint process is not owned by the selected WorkBuddy AI sidecar.",
    );
  }

  let verification: WorkbuddyEndpointVerification;
  try {
    verification = await source.verifyEndpoint({
      endpoint: endpointSession.endpoint,
      taskId: task.id,
      workspace: authoritativeWorkspace,
      acpVersion: WORKBUDDY_AI_COMPATIBILITY.acpVersion,
    });
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [registration.token]);
    throw failure("endpoint-verification-failed", `WorkBuddy AI ACP identity verification failed: ${message}`);
  }
  if (verification.taskId !== task.id) {
    throw failure("task-identity-mismatch", "The ACP replay belongs to a different WorkBuddy Task.", {
      expectedTaskId: task.id,
      detectedTaskId: verification.taskId,
    });
  }
  const verifiedWorkspace =
    verification.workspace !== undefined && source.canonicalizeWorkspace
      ? await source.canonicalizeWorkspace(verification.workspace)
      : verification.workspace;
  if (verifiedWorkspace !== undefined && verifiedWorkspace !== authoritativeWorkspace) {
    throw failure("workspace-identity-mismatch", "The ACP endpoint reported a different Task workspace.", {
      taskId: task.id,
      authoritativeWorkspace,
      detectedWorkspace: verifiedWorkspace,
    });
  }
  if (!verification.replayStarted || !verification.replayCompleted) {
    throw failure(
      "task-replay-incomplete",
      "The ACP endpoint did not emit the complete pinned history replay boundary.",
    );
  }

  return {
    profile: input.profile,
    application: {
      path: application.path,
      version: application.version,
      embeddedCodeBuddyVersion: application.embeddedCodeBuddyVersion,
      processId: applicationProcess.pid,
    },
    task: { id: task.id, workspace: authoritativeWorkspace },
    owner: { sidecarProcessId: observation.sidecarProcess.pid, endpointProcessId: endpointOwner.pid },
    endpoint: endpointSession.endpoint,
  };
}

function assertLoopbackEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw failure("non-loopback-endpoint", "The discovered ACP endpoint is not a valid loopback URL.");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    url.pathname !== "/api/v1/acp" ||
    !url.port ||
    url.username ||
    url.password
  ) {
    throw failure("non-loopback-endpoint", "The discovered ACP endpoint is not an exact loopback HTTP endpoint.");
  }
}

function ownedExecutable(processIdentity: WorkbuddyProcessIdentity, applicationPath: string): boolean {
  return processIdentity.executablePath.startsWith(`${applicationPath}/Contents/`);
}

function isDescendant(child: WorkbuddyProcessIdentity, parent: WorkbuddyProcessIdentity): boolean {
  return child.parentPid === parent.pid || child.ancestorPids?.includes(parent.pid) === true;
}

function redactSecrets(value: string, knownSecrets: string[]): string {
  let redacted = value;
  for (const secret of knownSecrets) if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted
    .replace(/\b(connectionId|sessionToken|bearer|password)\s*[=:]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
}

function failure(
  code: WorkbuddyDiscoveryFailureCode,
  message: string,
  details: Record<string, unknown> = {},
  options?: ErrorOptions,
): WorkbuddyDiscoveryError {
  return new WorkbuddyDiscoveryError(code, message, details, options);
}
