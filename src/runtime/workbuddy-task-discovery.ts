export const WORKBUDDY_AI_COMPATIBILITY = {
  profile: "workbuddy-ai",
  bundleIdentifier: "com.workbuddy.workbuddy-ai",
  applicationVersion: "5.2.7",
  embeddedCodeBuddyVersion: "2.106.4",
  sidecarVersion: 1,
  acpVersion: 1,
} as const;

export type WorkBuddyProfile = typeof WORKBUDDY_AI_COMPATIBILITY.profile;

export interface WorkBuddyProcessIdentity {
  pid: number;
  parentPid: number;
  executablePath: string;
  ancestorPids?: number[];
}

export interface WorkBuddyDiscoveryObservation {
  application: {
    path: string;
    bundleIdentifier: string;
    version: string;
    embeddedCodeBuddyVersion: string;
  } | null;
  applicationProcess: WorkBuddyProcessIdentity | null;
  task: {
    id: string;
    workspace: string;
    transcriptIdentityMatches: boolean;
    replayFingerprint: string;
  } | null;
  sidecarRegistration: { pid: number; version: number } | null;
  sidecarIdentity: { pid: number; version: number; registrationTokenMatches: boolean } | null;
  sidecarProcess: WorkBuddyProcessIdentity | null;
  endpointSession: { sessionId: string; pid: number; endpoint: string } | null;
  endpointOwner: WorkBuddyProcessIdentity | null;
}

export interface WorkBuddyEndpointVerification {
  taskId: string;
  replayFingerprint: string;
  replayStarted: boolean;
  replayCompleted: boolean;
  activities: import("./types").RuntimeActivity[];
  connectionOwner: WorkBuddyProcessIdentity | null;
}

export interface WorkBuddyEndpointInput {
  endpoint: string;
  taskId: string;
  workspace: string;
  acpVersion: number;
  applicationPath: string;
  expectedEndpointProcessId: number;
  expectedSidecarProcessId: number;
}

export interface WorkBuddyTaskDiscoverySource {
  inspect(input: WorkBuddyTaskDiscoveryInput): Promise<WorkBuddyDiscoveryObservation>;
  canonicalizeWorkspace?(workspace: string): Promise<string>;
  verifyEndpoint(input: WorkBuddyEndpointInput): Promise<WorkBuddyEndpointVerification>;
  connectEndpoint?(input: WorkBuddyEndpointInput): Promise<import("./workbuddy-acp-client").WorkBuddyAcpTaskAttachment>;
  confirmEndpointOwner(endpoint: string): Promise<WorkBuddyProcessIdentity | null>;
}

export interface WorkBuddyTaskDiscoveryInput {
  profile: WorkBuddyProfile;
  taskId: string;
  expectedWorkspace: string;
}

export interface DiscoveredWorkBuddyTask {
  profile: WorkBuddyProfile;
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

export type WorkBuddyDiscoveryFailureCode =
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

export class WorkBuddyDiscoveryError extends Error {
  readonly name = "WorkBuddyDiscoveryError";

  constructor(
    readonly code: WorkBuddyDiscoveryFailureCode,
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

export async function discoverWorkBuddyTask(
  input: WorkBuddyTaskDiscoveryInput,
  source: WorkBuddyTaskDiscoverySource,
): Promise<DiscoveredWorkBuddyTask> {
  return (await verifyWorkBuddyTask(input, source)).discovered;
}

export async function attachWorkBuddyTask(
  input: WorkBuddyTaskDiscoveryInput,
  source: WorkBuddyTaskDiscoverySource,
): Promise<import("./types").RuntimeActivitySnapshot> {
  const { verification } = await verifyWorkBuddyTask(input, source);
  return { activities: verification.activities, completeness: "complete", limitations: [] };
}

export async function connectWorkBuddyTask(
  input: WorkBuddyTaskDiscoveryInput,
  source: WorkBuddyTaskDiscoverySource,
): Promise<import("./workbuddy-acp-client").WorkBuddyAcpTaskAttachment> {
  const connectEndpoint = source.connectEndpoint;
  if (!connectEndpoint) throw new Error("WorkBuddy discovery source cannot retain a Task Attachment");
  let attachment: import("./workbuddy-acp-client").WorkBuddyAcpTaskAttachment | null = null;
  try {
    await verifyWorkBuddyTask(input, source, async (endpointInput) => {
      attachment = await connectEndpoint(endpointInput);
      return attachment.verification;
    });
    if (!attachment) throw new Error("WorkBuddy Task Attachment was not established");
    return attachment;
  } catch (error) {
    await (attachment as import("./workbuddy-acp-client").WorkBuddyAcpTaskAttachment | null)?.close();
    throw error;
  }
}

async function verifyWorkBuddyTask(
  input: WorkBuddyTaskDiscoveryInput,
  source: WorkBuddyTaskDiscoverySource,
  verifyEndpoint = source.verifyEndpoint,
): Promise<{ discovered: DiscoveredWorkBuddyTask; verification: WorkBuddyEndpointVerification }> {
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
  if (!task.transcriptIdentityMatches) {
    throw failure(
      "workspace-identity-mismatch",
      "WorkBuddy AI's native Task transcript has conflicting identity metadata.",
      {
        taskId: task.id,
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
    !sidecarIdentity.registrationTokenMatches
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
      "WorkBuddy AI has no active ACP endpoint for this Task; open the Task and run one native turn before attaching.",
    );
  }
  if (endpointSession.sessionId !== task.id) {
    throw failure("task-identity-mismatch", "The discovered ACP endpoint belongs to a different WorkBuddy session.", {
      expectedTaskId: task.id,
      detectedSessionId: endpointSession.sessionId,
    });
  }
  assertLoopbackEndpoint(endpointSession.endpoint);
  const endpointOwner = assertExpectedEndpointOwner(
    observation.endpointOwner,
    endpointSession.pid,
    application.path,
    observation.sidecarProcess,
    "during discovery",
  );

  let verification: WorkBuddyEndpointVerification;
  try {
    verification = await verifyEndpoint({
      endpoint: endpointSession.endpoint,
      taskId: task.id,
      workspace: authoritativeWorkspace,
      acpVersion: WORKBUDDY_AI_COMPATIBILITY.acpVersion,
      applicationPath: application.path,
      expectedEndpointProcessId: endpointOwner.pid,
      expectedSidecarProcessId: observation.sidecarProcess.pid,
    });
  } catch (error) {
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    throw failure("endpoint-verification-failed", `WorkBuddy AI ACP identity verification failed: ${message}`);
  }
  assertExpectedEndpointOwner(
    verification.connectionOwner,
    endpointOwner.pid,
    application.path,
    observation.sidecarProcess,
    "before Task content exchange",
  );
  if (verification.taskId !== task.id) {
    throw failure("task-identity-mismatch", "The ACP replay belongs to a different WorkBuddy Task.", {
      expectedTaskId: task.id,
      detectedTaskId: verification.taskId,
    });
  }
  if (!verification.replayStarted || !verification.replayCompleted) {
    throw failure(
      "task-replay-incomplete",
      "The ACP endpoint did not emit the complete pinned history replay boundary.",
    );
  }
  if (verification.replayFingerprint !== task.replayFingerprint) {
    throw failure("task-identity-mismatch", "The ACP replay does not match WorkBuddy AI's native Task transcript.", {
      taskId: task.id,
    });
  }

  const confirmedOwner = assertExpectedEndpointOwner(
    await source.confirmEndpointOwner(endpointSession.endpoint),
    endpointOwner.pid,
    application.path,
    observation.sidecarProcess,
    "after Task identity verification",
  );

  return {
    discovered: {
      profile: input.profile,
      application: {
        path: application.path,
        version: application.version,
        embeddedCodeBuddyVersion: application.embeddedCodeBuddyVersion,
        processId: applicationProcess.pid,
      },
      task: { id: task.id, workspace: authoritativeWorkspace },
      owner: { sidecarProcessId: observation.sidecarProcess.pid, endpointProcessId: confirmedOwner.pid },
      endpoint: endpointSession.endpoint,
    },
    verification,
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

function ownedExecutable(processIdentity: WorkBuddyProcessIdentity, applicationPath: string): boolean {
  return processIdentity.executablePath.startsWith(`${applicationPath}/Contents/`);
}

function isDescendant(child: WorkBuddyProcessIdentity, parent: WorkBuddyProcessIdentity): boolean {
  return child.parentPid === parent.pid || child.ancestorPids?.includes(parent.pid) === true;
}

function assertExpectedEndpointOwner(
  candidate: WorkBuddyProcessIdentity | null,
  expectedProcessId: number,
  applicationPath: string,
  sidecarProcess: WorkBuddyProcessIdentity,
  stage: string,
): WorkBuddyProcessIdentity {
  if (!candidate) {
    throw failure("endpoint-stale", `The WorkBuddy AI ACP endpoint is no longer listening ${stage}.`);
  }
  if (candidate.pid !== expectedProcessId) {
    throw failure("recycled-endpoint", `The ACP port changed owners ${stage}.`, {
      expectedProcessId,
      detectedProcessId: candidate.pid,
    });
  }
  if (!ownedExecutable(candidate, applicationPath) || !isDescendant(candidate, sidecarProcess)) {
    throw failure(
      "wrong-owning-process",
      `The ACP endpoint is not owned by the selected WorkBuddy AI sidecar ${stage}.`,
    );
  }
  return candidate;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(connectionId|sessionToken|bearer|password)\s*[=:]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
}

function failure(
  code: WorkBuddyDiscoveryFailureCode,
  message: string,
  details: Record<string, unknown> = {},
  options?: ErrorOptions,
): WorkBuddyDiscoveryError {
  return new WorkBuddyDiscoveryError(code, message, details, options);
}
