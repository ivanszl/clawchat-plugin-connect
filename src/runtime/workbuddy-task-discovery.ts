import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeActivity, RuntimeActivitySnapshot } from "./types";
import type { WorkBuddyAcpTaskAttachment, WorkBuddyTaskCatalog } from "./workbuddy-acp-client";

export type WorkBuddyProfile = "workbuddy-ai" | "workbuddy-cn";

export interface WorkBuddyProfileCompatibility {
  profile: WorkBuddyProfile;
  displayName: string;
  applicationPath: string;
  bundleIdentifier: string;
  configDirectory: string;
  dataFolderName: string;
  endpointSessionPrefix: string;
  sidecarVersion: number;
  acpVersion: number;
}

export const WORKBUDDY_AI_COMPATIBILITY = {
  profile: "workbuddy-ai",
  displayName: "WorkBuddy AI",
  applicationPath: "/Applications/WorkBuddy AI.app",
  bundleIdentifier: "com.workbuddy.workbuddy-ai",
  configDirectory: join(homedir(), ".workbuddy-ai"),
  dataFolderName: ".workbuddy-ai",
  endpointSessionPrefix: "__workbuddy_cli_host__-",
  sidecarVersion: 3,
  acpVersion: 1,
} as const satisfies WorkBuddyProfileCompatibility;

export const WORKBUDDY_CN_COMPATIBILITY = {
  profile: "workbuddy-cn",
  displayName: "WorkBuddy",
  applicationPath: "/Applications/WorkBuddy.app",
  bundleIdentifier: "com.workbuddy.workbuddy",
  configDirectory: join(homedir(), ".workbuddy"),
  dataFolderName: ".workbuddy",
  endpointSessionPrefix: "__workbuddy_cli_host__-",
  sidecarVersion: 3,
  acpVersion: 1,
} as const satisfies WorkBuddyProfileCompatibility;

const WORKBUDDY_PROFILE_COMPATIBILITY: Record<WorkBuddyProfile, WorkBuddyProfileCompatibility> = {
  "workbuddy-ai": WORKBUDDY_AI_COMPATIBILITY,
  "workbuddy-cn": WORKBUDDY_CN_COMPATIBILITY,
};

export function workBuddyProfileCompatibility(profile: WorkBuddyProfile): WorkBuddyProfileCompatibility {
  return WORKBUDDY_PROFILE_COMPATIBILITY[profile];
}

export function isWorkBuddyProfileHostSession(profile: WorkBuddyProfile, sessionId: string): boolean {
  const prefix = workBuddyProfileCompatibility(profile).endpointSessionPrefix;
  return sessionId.startsWith(prefix) && /^\d+-[0-9a-f]{8}$/u.test(sessionId.slice(prefix.length));
}

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
  sidecarIdentity: {
    pid: number;
    version: number;
    registrationTokenMatches: boolean;
    registrationToken: string;
  } | null;
  sidecarProcess: WorkBuddyProcessIdentity | null;
  endpointSession: { sessionId: string; pid: number; endpoint: string } | null;
  endpointOwner: WorkBuddyProcessIdentity | null;
}

export interface WorkBuddyEndpointVerification {
  taskId: string;
  replayFingerprint: string;
  replayStarted: boolean;
  replayCompleted: boolean;
  activities: RuntimeActivity[];
  connectionOwner: WorkBuddyProcessIdentity | null;
  catalog?: WorkBuddyTaskCatalog;
}

export interface WorkBuddyEndpointInput {
  profile: WorkBuddyProfile;
  endpoint: string;
  taskId: string;
  workspace: string;
  acpVersion: number;
  applicationPath: string;
  expectedEndpointProcessId: number;
  expectedSidecarProcessId: number;
}

export type WorkBuddyEndpointSelection = "any" | "host" | "task";
export interface WorkBuddySidecarPreparationIdentity {
  applicationProcessId: number;
  sidecarProcessId: number;
  sidecarVersion: number;
  registrationToken: string;
}

export interface WorkBuddyTaskDiscoverySource {
  prepareEndpoint?(
    input: WorkBuddyTaskDiscoveryInput,
    sidecarIdentity: WorkBuddySidecarPreparationIdentity,
  ): Promise<void>;
  inspect(
    input: WorkBuddyTaskDiscoveryInput,
    endpointSelection?: WorkBuddyEndpointSelection,
  ): Promise<WorkBuddyDiscoveryObservation>;
  canonicalizeWorkspace?(workspace: string): Promise<string>;
  verifyEndpoint(input: WorkBuddyEndpointInput): Promise<WorkBuddyEndpointVerification>;
  connectEndpoint?(input: WorkBuddyEndpointInput): Promise<WorkBuddyAcpTaskAttachment>;
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
  | "discovery-failed"
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
  | "authentication-failed"
  | "protocol-incompatible"
  | "endpoint-verification-failed";

export class WorkBuddyDiscoveryError extends Error {
  readonly name = "WorkBuddyDiscoveryError";
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: WorkBuddyDiscoveryFailureCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(sanitizeDiagnosticMessage(message), options);
    this.details = sanitizeDiagnosticDetails(details);
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
): Promise<RuntimeActivitySnapshot> {
  const { verification } = await verifyWorkBuddyTask(input, source);
  return {
    activities: verification.activities,
    completeness: "complete",
    limitations: [],
    ...(verification.catalog ? { catalog: verification.catalog } : {}),
  };
}

export async function connectWorkBuddyTask(
  input: WorkBuddyTaskDiscoveryInput,
  source: WorkBuddyTaskDiscoverySource,
): Promise<WorkBuddyAcpTaskAttachment> {
  const connectEndpoint = source.connectEndpoint;
  if (!connectEndpoint) throw new Error("WorkBuddy discovery source cannot retain a Task Attachment");
  let attachment: WorkBuddyAcpTaskAttachment | null = null;
  const connectSelectedEndpoint = async (endpointSelection: WorkBuddyEndpointSelection): Promise<void> => {
    await verifyWorkBuddyTask(
      input,
      source,
      async (endpointInput) => {
        attachment = await connectEndpoint(endpointInput);
        return attachment.verification;
      },
      endpointSelection,
    );
  };
  try {
    if (source.prepareEndpoint) {
      try {
        await connectSelectedEndpoint("task");
        if (!attachment) throw new Error("WorkBuddy Task Attachment was not established");
        return attachment;
      } catch (error) {
        if (attachment || !isMissingExactTaskEndpoint(error)) throw error;
      }

      // No WorkBuddy-owned Task endpoint exists. Authenticate the native Task through
      // the shared read-only host before asking the selected sidecar to create one.
      const { sidecarIdentity } = await verifyWorkBuddyTask(input, source, source.verifyEndpoint, "host");
      try {
        await source.prepareEndpoint(input, sidecarIdentity);
      } catch (error) {
        if (error instanceof WorkBuddyDiscoveryError) throw error;
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        throw failure(
          "discovery-failed",
          `${workBuddyProfileCompatibility(input.profile).displayName} Task runtime preparation failed: ${message}`,
        );
      }
    }
    await connectSelectedEndpoint(source.prepareEndpoint ? "task" : "any");
    if (!attachment) throw new Error("WorkBuddy Task Attachment was not established");
    return attachment;
  } catch (error) {
    await (attachment as WorkBuddyAcpTaskAttachment | null)?.close();
    throw error;
  }
}

function isMissingExactTaskEndpoint(error: unknown): boolean {
  return (
    error instanceof WorkBuddyDiscoveryError &&
    error.code === "endpoint-unavailable" &&
    error.details.expectedEndpointKind === "task" &&
    error.details.candidateCount === 0
  );
}

async function verifyWorkBuddyTask(
  input: WorkBuddyTaskDiscoveryInput,
  source: WorkBuddyTaskDiscoverySource,
  verifyEndpoint = source.verifyEndpoint,
  endpointSelection: WorkBuddyEndpointSelection = "any",
): Promise<{
  discovered: DiscoveredWorkBuddyTask;
  verification: WorkBuddyEndpointVerification;
  sidecarIdentity: WorkBuddySidecarPreparationIdentity;
}> {
  const compatibility = workBuddyProfileCompatibility(input.profile);
  const product = compatibility.displayName;
  let observation: WorkBuddyDiscoveryObservation;
  try {
    observation = await source.inspect(input, endpointSelection);
  } catch (error) {
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    throw failure(
      "discovery-failed",
      `${product} Task discovery failed before an endpoint was selected.`,
      {},
      { cause: error },
    );
  }
  const application = observation.application;
  if (!application) {
    throw failure("application-absent", `${product} is not installed at ${compatibility.applicationPath}.`, {
      selectedProfile: input.profile,
    });
  }
  if (
    application.path !== compatibility.applicationPath ||
    application.bundleIdentifier !== compatibility.bundleIdentifier
  ) {
    throw failure("wrong-distribution", `The selected application is not the ${product} distribution.`, {
      selectedProfile: input.profile,
      selectedApplicationPath: compatibility.applicationPath,
      detectedApplicationPath: application.path,
      detectedBundleIdentifier: application.bundleIdentifier,
    });
  }
  if (
    typeof application.version !== "string" ||
    !application.version.trim() ||
    typeof application.embeddedCodeBuddyVersion !== "string" ||
    !application.embeddedCodeBuddyVersion.trim()
  ) {
    throw failure("discovery-failed", `The installed ${product} version metadata is unreadable.`, {
      selectedProfile: input.profile,
      detectedApplicationVersion: application.version,
      detectedEmbeddedCodeBuddyVersion: application.embeddedCodeBuddyVersion,
    });
  }
  const applicationProcess = observation.applicationProcess;
  if (!applicationProcess) {
    throw failure(
      "application-stopped",
      `${product} is installed but not running; open it before discovering a Task.`,
      { selectedProfile: input.profile },
    );
  }
  if (!ownedExecutable(applicationProcess, application.path)) {
    throw failure(
      "wrong-owning-process",
      `The running application process is not owned by the selected ${product} bundle.`,
    );
  }

  const task = observation.task;
  if (!task || task.id !== input.taskId) {
    throw failure("task-not-found", `The requested Task is not present in ${product}'s authoritative Task store.`, {
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
    throw failure("workspace-identity-mismatch", `The requested workspace does not match ${product}'s Task metadata.`, {
      taskId: task.id,
      expectedWorkspace,
      authoritativeWorkspace,
    });
  }
  if (!task.transcriptIdentityMatches) {
    throw failure(
      "workspace-identity-mismatch",
      `${product}'s native Task transcript has conflicting identity metadata.`,
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
      `${product} is running but its deterministic sidecar control surface is unavailable.`,
    );
  }
  if (
    registration.pid !== sidecarIdentity.pid ||
    registration.version !== sidecarIdentity.version ||
    !sidecarIdentity.registrationTokenMatches
  ) {
    throw failure("endpoint-stale", `${product}'s sidecar registration no longer identifies the live control socket.`);
  }
  if (registration.version !== compatibility.sidecarVersion) {
    throw failure("incompatible-version", `The installed ${product} sidecar version is unsupported.`, {
      selectedProfile: input.profile,
      detectedSidecarVersion: registration.version,
      supportedSidecarVersion: compatibility.sidecarVersion,
    });
  }
  if (
    !ownedExecutable(observation.sidecarProcess, application.path) ||
    !isDescendant(observation.sidecarProcess, applicationProcess)
  ) {
    throw failure(
      "wrong-owning-process",
      `The sidecar control surface is not owned by the selected ${product} process.`,
    );
  }

  const endpointSession = observation.endpointSession;
  if (!endpointSession) {
    throw failure(
      "endpoint-unavailable",
      `${product} has no active ACP endpoint for this Task; open the Task and run one native turn before attaching.`,
    );
  }
  const isExactTask = endpointSession.sessionId === task.id;
  const isProfileHost = isWorkBuddyProfileHostSession(input.profile, endpointSession.sessionId);
  if (
    (endpointSelection === "host" && !isProfileHost) ||
    (endpointSelection === "task" && !isExactTask) ||
    (endpointSelection === "any" && !isExactTask && !isProfileHost)
  ) {
    throw failure("task-identity-mismatch", "The discovered ACP endpoint has the wrong WorkBuddy Session identity.", {
      expectedSessionIdentity:
        endpointSelection === "host"
          ? "profile-host"
          : endpointSelection === "task"
            ? task.id
            : `${task.id} or profile-host`,
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
    product,
  );

  let verification: WorkBuddyEndpointVerification;
  try {
    verification = await verifyEndpoint({
      profile: input.profile,
      endpoint: endpointSession.endpoint,
      taskId: task.id,
      workspace: authoritativeWorkspace,
      acpVersion: compatibility.acpVersion,
      applicationPath: application.path,
      expectedEndpointProcessId: endpointOwner.pid,
      expectedSidecarProcessId: observation.sidecarProcess.pid,
    });
  } catch (error) {
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    throw failure("endpoint-verification-failed", `${product} ACP identity verification failed: ${message}`);
  }
  assertExpectedEndpointOwner(
    verification.connectionOwner,
    endpointOwner.pid,
    application.path,
    observation.sidecarProcess,
    "before Task content exchange",
    product,
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
    throw failure("task-identity-mismatch", `The ACP replay does not match ${product}'s native Task transcript.`, {
      taskId: task.id,
    });
  }

  const confirmedOwner = assertExpectedEndpointOwner(
    await source.confirmEndpointOwner(endpointSession.endpoint),
    endpointOwner.pid,
    application.path,
    observation.sidecarProcess,
    "after Task identity verification",
    product,
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
    sidecarIdentity: {
      applicationProcessId: applicationProcess.pid,
      sidecarProcessId: observation.sidecarProcess.pid,
      sidecarVersion: registration.version,
      registrationToken: sidecarIdentity.registrationToken,
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
  product: string,
): WorkBuddyProcessIdentity {
  if (!candidate) {
    throw failure("endpoint-stale", `The ${product} ACP endpoint is no longer listening ${stage}.`);
  }
  if (candidate.pid !== expectedProcessId) {
    throw failure("recycled-endpoint", `The ACP port changed owners ${stage}.`, {
      expectedProcessId,
      detectedProcessId: candidate.pid,
    });
  }
  if (!ownedExecutable(candidate, applicationPath) || !isDescendant(candidate, sidecarProcess)) {
    throw failure("wrong-owning-process", `The ACP endpoint is not owned by the selected ${product} sidecar ${stage}.`);
  }
  return candidate;
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /(["'][^"']*(?:authorization|bearer|password|credential|secret|token|connection[^"']*id)[^"']*["']\s*:\s*)["'][^"']*["']/giu,
      '$1"[REDACTED]"',
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(connection[-_ ]?id|session[-_ ]?token|authorization|bearer[-_ ]?token|bearer|password|credential|secret)\s*[=:]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    );
}

const SENSITIVE_DIAGNOSTIC_KEY =
  /(?:authorization|bearer|password|credential|secret|token|connection.*id|headers?|product.*config|config.*dir|transcript|prompt|response|payload|body|content)/iu;
const MAX_DIAGNOSTIC_STRING = 512;

function sanitizeDiagnosticMessage(message: string): string {
  return truncateDiagnostic(redactSecrets(message));
}

function sanitizeDiagnosticDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDiagnosticRecord(details, 0);
}

function sanitizeDiagnosticRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 24)
      .map(([key, value]) => [
        key,
        SENSITIVE_DIAGNOSTIC_KEY.test(key) ? "[REDACTED]" : sanitizeDiagnosticValue(value, depth),
      ]),
  );
}

function sanitizeDiagnosticValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncateDiagnostic(redactSecrets(value));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 2) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  if (value && typeof value === "object") {
    return sanitizeDiagnosticRecord(value as Record<string, unknown>, depth + 1);
  }
  return truncateDiagnostic(String(value));
}

function truncateDiagnostic(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_STRING ? value : `${value.slice(0, MAX_DIAGNOSTIC_STRING)}…[TRUNCATED]`;
}

function failure(
  code: WorkBuddyDiscoveryFailureCode,
  message: string,
  details: Record<string, unknown> = {},
  options?: ErrorOptions,
): WorkBuddyDiscoveryError {
  return new WorkBuddyDiscoveryError(code, message, details, options);
}
