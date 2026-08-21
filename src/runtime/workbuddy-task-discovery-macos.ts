import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openWorkBuddyTaskEndpoint,
  verifyWorkBuddyEndpoint,
  type WorkBuddyConnectedSocketIdentity,
} from "./workbuddy-acp-client";
import {
  isWorkBuddyProfileHostSession,
  WorkBuddyDiscoveryError,
  type WorkBuddyDiscoveryObservation,
  type WorkBuddyEndpointSelection,
  type WorkBuddyProcessIdentity,
  type WorkBuddyProfile,
  type WorkBuddyProfileCompatibility,
  type WorkBuddySidecarPreparationIdentity,
  type WorkBuddyTaskDiscoveryInput,
  type WorkBuddyTaskDiscoverySource,
  workBuddyProfileCompatibility,
} from "./workbuddy-task-discovery";
import { readWorkBuddyTaskTranscriptIdentity } from "./workbuddy-task-transcript";

export interface WorkBuddyMacosDiscoveryOptions {
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
  prepareTaskRuntime?: (input: WorkBuddyTaskRuntimeInput) => Promise<void>;
  readTaskRuntimeSelection?: (input: WorkBuddyTaskRuntimeSelectionInput) => Promise<WorkBuddyTaskRuntimeSelection>;
}

export interface WorkBuddyTaskRuntimeSelectionInput {
  profile: WorkBuddyProfile;
  configDirectory: string;
  taskId: string;
}

export interface WorkBuddyTaskRuntimeSelection {
  model: string | null;
  permissionMode: "fullAccess" | "plan" | "default" | "acceptEdits" | "bypassPermissions";
}

export interface WorkBuddyTaskRuntimeRequestInput {
  profile: WorkBuddyProfile;
  applicationPath: string;
  configDirectory: string;
  dataFolderName: string;
  resourcesPath: string;
  taskId: string;
  workspace: string;
  selection: WorkBuddyTaskRuntimeSelection;
  commandTimeoutMs: number;
}

export interface WorkBuddyTaskRuntimeInput extends WorkBuddyTaskRuntimeRequestInput {
  sidecarIdentity: WorkBuddySidecarPreparationIdentity;
}

export interface WorkBuddyTaskRuntimeRequest {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  port: number;
}

export interface WorkBuddyTaskCatalogEntry {
  id: string;
  title: string | null;
  workspace: string;
  updatedAt: number;
}

interface WorkBuddyApplicationInspection {
  application: NonNullable<WorkBuddyDiscoveryObservation["application"]> | null;
  applicationProcess: WorkBuddyProcessIdentity | null;
  processes: WorkBuddyProcessIdentity[];
}

export async function listWorkBuddyTasks(
  profile: WorkBuddyProfile,
  options: WorkBuddyMacosDiscoveryOptions = {},
): Promise<WorkBuddyTaskCatalogEntry[]> {
  const compatibility = workBuddyProfileCompatibility(profile);
  const applicationPath = compatibility.applicationPath;
  const configDirectory = compatibility.configDirectory;
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  const { application, applicationProcess } = await inspectWorkBuddyApplication(
    applicationPath,
    compatibility,
    commandTimeoutMs,
  );
  if (!application) {
    throw new WorkBuddyDiscoveryError(
      "application-absent",
      `${compatibility.displayName} is not installed at ${compatibility.applicationPath}.`,
      { selectedProfile: profile },
    );
  }
  if (application.bundleIdentifier !== compatibility.bundleIdentifier) {
    throw new WorkBuddyDiscoveryError(
      "wrong-distribution",
      `The selected application is not ${compatibility.displayName}.`,
      {
        selectedProfile: profile,
        detectedBundleIdentifier: application.bundleIdentifier,
      },
    );
  }
  if (!applicationProcess) {
    throw new WorkBuddyDiscoveryError(
      "application-stopped",
      `${compatibility.displayName} is installed but not running; open it before discovering Tasks.`,
      { selectedProfile: profile },
    );
  }
  let database: Database | null = null;
  try {
    database = new Database(join(configDirectory, "workbuddy.db"), { readonly: true });
    const rows = database
      .query<{ id: string; cwd: string; title: string | null; custom_title: string | null; updated_at: number }, []>(
        "SELECT id, cwd, title, custom_title, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC, id",
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      title: row.custom_title || row.title || null,
      workspace: row.cwd,
      updatedAt: row.updated_at,
    }));
  } catch (error) {
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    throw new WorkBuddyDiscoveryError(
      "discovery-failed",
      `${compatibility.displayName} Task discovery failed before an endpoint was selected.`,
      { selectedProfile: profile },
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

export function createWorkBuddyMacosDiscoverySource(
  profile: WorkBuddyProfile,
  options: WorkBuddyMacosDiscoveryOptions = {},
): WorkBuddyTaskDiscoverySource {
  const compatibility = workBuddyProfileCompatibility(profile);
  const applicationPath = compatibility.applicationPath;
  const configDirectory = compatibility.configDirectory;
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const prepareRuntime = async (
    input: WorkBuddyTaskDiscoveryInput,
    sidecarIdentity: WorkBuddySidecarPreparationIdentity,
  ) => {
    if (input.profile !== profile) throw wrongDiscoverySource(profile, input.profile);
    const selectionInput = { profile, configDirectory, taskId: input.taskId };
    const selection = options.readTaskRuntimeSelection
      ? await options.readTaskRuntimeSelection(selectionInput)
      : await readWorkBuddyTaskRuntimeSelection(selectionInput);
    await (options.prepareTaskRuntime ?? prepareWorkBuddyTaskRuntime)({
      profile,
      applicationPath,
      configDirectory,
      dataFolderName: compatibility.dataFolderName,
      resourcesPath: join(applicationPath, "Contents", "Resources"),
      taskId: input.taskId,
      workspace: await realpath(input.expectedWorkspace),
      selection,
      commandTimeoutMs,
      sidecarIdentity,
    });
  };
  return {
    prepareEndpoint: async (input, sidecarIdentity) => {
      await prepareRuntime(input, sidecarIdentity);
    },
    canonicalizeWorkspace: async (workspace) => await realpath(workspace),
    inspect: async (input, endpointSelection = "any") => {
      if (input.profile !== profile) {
        throw wrongDiscoverySource(profile, input.profile);
      }
      return await inspectWorkBuddy(input, endpointSelection, {
        applicationPath,
        configDirectory,
        commandTimeoutMs,
        compatibility,
      });
    },
    verifyEndpoint: async (input) =>
      await verifyWorkBuddyEndpoint(input, requestTimeoutMs, async (identity) =>
        assertConnectedEndpointOwner(await confirmConnectedEndpointOwner(identity, commandTimeoutMs), input),
      ),
    connectEndpoint: async (input) =>
      await openWorkBuddyTaskEndpoint(input, requestTimeoutMs, async (identity) =>
        assertConnectedEndpointOwner(await confirmConnectedEndpointOwner(identity, commandTimeoutMs), input),
      ),
    confirmEndpointOwner: async (endpoint) => await confirmEndpointOwner(endpoint, commandTimeoutMs),
  };
}

function wrongDiscoverySource(
  sourceProfile: WorkBuddyProfile,
  selectedProfile: WorkBuddyProfile,
): WorkBuddyDiscoveryError {
  return new WorkBuddyDiscoveryError(
    "wrong-distribution",
    `The ${sourceProfile} discovery source cannot inspect profile ${selectedProfile}.`,
    { selectedProfile, discoverySourceProfile: sourceProfile },
  );
}

async function inspectWorkBuddy(
  input: WorkBuddyTaskDiscoveryInput,
  endpointSelection: WorkBuddyEndpointSelection,
  options: {
    applicationPath: string;
    configDirectory: string;
    commandTimeoutMs: number;
    compatibility: WorkBuddyProfileCompatibility;
  },
): Promise<WorkBuddyDiscoveryObservation> {
  const { application, applicationProcess, processes } = await inspectWorkBuddyApplication(
    options.applicationPath,
    options.compatibility,
    options.commandTimeoutMs,
  );
  if (!application) return emptyObservation();
  if (application.bundleIdentifier !== options.compatibility.bundleIdentifier) {
    return { ...emptyObservation(), application };
  }
  if (!applicationProcess) return { ...emptyObservation(), application };

  const task = await readTask(options.configDirectory, input.taskId, input.profile);
  const runtimeDirectory = sidecarRuntimeDirectory(options.configDirectory);
  const registrationPath = join(runtimeDirectory, "sidecar.pid");
  const registration = await readJsonFile<unknown>(registrationPath);
  if (!registration) {
    if (await exists(registrationPath)) {
      throw malformedSidecarState(input.profile, "registration");
    }
    return { ...emptyObservation(), application, applicationProcess, task };
  }
  if (!isSidecarIdentity(registration)) throw malformedSidecarState(input.profile, "registration");
  const liveSidecarIdentity = await sidecarRpc<unknown>(
    join(runtimeDirectory, "sidecar.sock"),
    "sidecar.ping",
    options.commandTimeoutMs,
  ).catch(() => null);
  if (liveSidecarIdentity !== null && !isSidecarIdentity(liveSidecarIdentity)) {
    throw malformedSidecarState(input.profile, "live identity");
  }
  const sidecarIdentity = liveSidecarIdentity
    ? {
        pid: liveSidecarIdentity.pid,
        version: liveSidecarIdentity.version,
        registrationTokenMatches: liveSidecarIdentity.token === registration.token,
        registrationToken: liveSidecarIdentity.token,
      }
    : null;
  const listedSessions = liveSidecarIdentity
    ? await sidecarRpc<unknown>(join(runtimeDirectory, "sidecar.sock"), "session.list", options.commandTimeoutMs).catch(
        () => null,
      )
    : [];
  if (
    listedSessions !== null &&
    (!Array.isArray(listedSessions) || listedSessions.some((entry) => !isSidecarSession(entry)))
  ) {
    throw malformedSidecarState(input.profile, "Session inventory");
  }
  const validSessions = listedSessions ?? [];
  const exactTaskCandidates = validSessions.filter((session) => session.sessionId === input.taskId);
  const hostCandidates = validSessions.filter((session) =>
    isWorkBuddyProfileHostSession(input.profile, session.sessionId),
  );
  const endpointCandidates =
    endpointSelection === "host"
      ? hostCandidates
      : endpointSelection === "task"
        ? exactTaskCandidates
        : exactTaskCandidates.length
          ? exactTaskCandidates
          : hostCandidates;
  if (endpointCandidates.length !== 1) {
    const expected = endpointSelection === "task" ? `Task Session ${input.taskId}` : "profile host Session";
    throw new WorkBuddyDiscoveryError(
      "endpoint-unavailable",
      `${options.compatibility.displayName} sidecar must expose exactly one ${expected} for this lifecycle phase.`,
      {
        selectedProfile: input.profile,
        expectedEndpointKind: endpointSelection,
        candidateCount: endpointCandidates.length,
      },
    );
  }
  const endpointCandidate = endpointCandidates[0];
  const endpointSession = {
    sessionId: endpointCandidate.sessionId,
    pid: endpointCandidate.pid,
    endpoint: endpointCandidate.acpEndpoint,
  };
  const sidecarProcess = processIdentity(processes, registration.pid);
  const endpointOwnerPid = endpointSession
    ? await readEndpointOwner(endpointSession.endpoint, options.commandTimeoutMs).catch(() => null)
    : null;
  const endpointOwner = endpointOwnerPid === null ? null : processIdentity(processes, endpointOwnerPid);
  return {
    application,
    applicationProcess,
    task,
    sidecarRegistration: { pid: registration.pid, version: registration.version },
    sidecarIdentity,
    sidecarProcess,
    endpointSession,
    endpointOwner,
  };
}

function isSidecarIdentity(value: unknown): value is { pid: number; token: string; version: number } {
  if (!value || typeof value !== "object" || !("pid" in value) || !("token" in value) || !("version" in value)) {
    return false;
  }
  return (
    Number.isSafeInteger(value.pid) &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    Number.isSafeInteger(value.version)
  );
}

function isSidecarSession(value: unknown): value is { sessionId: string; pid: number; acpEndpoint: string } {
  if (
    !value ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    !("pid" in value) ||
    !("acpEndpoint" in value)
  ) {
    return false;
  }
  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    Number.isSafeInteger(value.pid) &&
    typeof value.acpEndpoint === "string" &&
    value.acpEndpoint.length > 0
  );
}

function malformedSidecarState(profile: WorkBuddyProfile, component: string): WorkBuddyDiscoveryError {
  const product = workBuddyProfileCompatibility(profile).displayName;
  return new WorkBuddyDiscoveryError(
    "endpoint-unavailable",
    `${product} sidecar ${component} is malformed and cannot be trusted.`,
    { selectedProfile: profile, malformedComponent: component },
  );
}

async function inspectWorkBuddyApplication(
  applicationPath: string,
  compatibility: WorkBuddyProfileCompatibility,
  commandTimeoutMs: number,
): Promise<WorkBuddyApplicationInspection> {
  if (!(await exists(applicationPath))) return { application: null, applicationProcess: null, processes: [] };
  const [bundleIdentifier, version] = await Promise.all([
    readPlistValue(join(applicationPath, "Contents", "Info.plist"), "CFBundleIdentifier", commandTimeoutMs),
    readPlistValue(join(applicationPath, "Contents", "Info.plist"), "CFBundleShortVersionString", commandTimeoutMs),
  ]);
  if (bundleIdentifier !== compatibility.bundleIdentifier) {
    return {
      application: {
        path: applicationPath,
        bundleIdentifier,
        version,
        embeddedCodeBuddyVersion: "[wrong-distribution]",
      },
      applicationProcess: null,
      processes: [],
    };
  }
  const [embeddedCodeBuddyVersion, processes] = await Promise.all([
    readEmbeddedCodeBuddyVersion(applicationPath),
    readProcesses(commandTimeoutMs),
  ]);
  const application = { path: applicationPath, bundleIdentifier, version, embeddedCodeBuddyVersion };
  const executablePath = join(applicationPath, "Contents", "MacOS", "Electron");
  const applicationProcess =
    processes.find((candidate) => candidate.parentPid === 1 && candidate.executablePath === executablePath) ?? null;
  return { application, applicationProcess, processes };
}

function emptyObservation(): WorkBuddyDiscoveryObservation {
  return {
    application: null,
    applicationProcess: null,
    task: null,
    sidecarRegistration: null,
    sidecarIdentity: null,
    sidecarProcess: null,
    endpointSession: null,
    endpointOwner: null,
  };
}

async function readPlistValue(path: string, key: string, timeoutMs: number): Promise<string> {
  const value = (
    await runCommand("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path], timeoutMs, "WorkBuddy Info.plist")
  ).trim();
  if (!value) throw new Error(`WorkBuddy Info.plist ${key} is empty`);
  return value;
}

async function readEmbeddedCodeBuddyVersion(applicationPath: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(applicationPath, "Contents", "Resources", "app.asar.unpacked", "cli", "package.json"), "utf8"),
  ) as { publishConfig?: { customPackage?: { version?: unknown } } };
  const version = manifest.publishConfig?.customPackage?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("WorkBuddy embedded CodeBuddy manifest has no version");
  }
  return version.trim();
}

async function readTask(
  configDirectory: string,
  taskId: string,
  profile: WorkBuddyProfile,
): Promise<{
  id: string;
  workspace: string;
  transcriptIdentityMatches: boolean;
  replayFingerprint: string;
} | null> {
  const database = new Database(join(configDirectory, "workbuddy.db"), { readonly: true });
  try {
    const row = database
      .query<{ id: string; cwd: string }, [string]>("SELECT id, cwd FROM sessions WHERE id = ? AND deleted_at IS NULL")
      .get(taskId);
    if (!row) return null;
    const transcript = await readWorkBuddyTaskTranscriptIdentity(configDirectory, row.id, row.cwd, profile);
    return { id: row.id, workspace: row.cwd, ...transcript };
  } finally {
    database.close();
  }
}

const WORKBUDDY_PERMISSION_MODES = new Set<WorkBuddyTaskRuntimeSelection["permissionMode"]>([
  "fullAccess",
  "plan",
  "default",
  "acceptEdits",
  "bypassPermissions",
]);

export async function readWorkBuddyTaskRuntimeSelection(
  input: WorkBuddyTaskRuntimeSelectionInput,
): Promise<WorkBuddyTaskRuntimeSelection> {
  const compatibility = workBuddyProfileCompatibility(input.profile);
  const database = new Database(join(input.configDirectory, "workbuddy.db"), { readonly: true });
  try {
    const row = database
      .query<{ model: string | null; permission_mode: string | null }, [string]>(
        "SELECT model, permission_mode FROM sessions WHERE id = ? AND deleted_at IS NULL",
      )
      .get(input.taskId);
    if (!row) {
      throw new WorkBuddyDiscoveryError(
        "task-not-found",
        `The requested ${compatibility.displayName} Task has no runtime selection.`,
        {
          selectedProfile: input.profile,
          taskId: input.taskId,
        },
      );
    }
    if (!WORKBUDDY_PERMISSION_MODES.has(row.permission_mode as WorkBuddyTaskRuntimeSelection["permissionMode"])) {
      throw new WorkBuddyDiscoveryError(
        "incompatible-version",
        `The ${compatibility.displayName} Task permission mode is unsupported for profile ${input.profile}.`,
        {
          selectedProfile: input.profile,
          detectedPermissionMode: row.permission_mode ?? "[missing]",
          supportedPermissionModes: [...WORKBUDDY_PERMISSION_MODES],
        },
      );
    }
    return {
      model: typeof row.model === "string" && row.model.trim() ? row.model.trim() : null,
      permissionMode: row.permission_mode as WorkBuddyTaskRuntimeSelection["permissionMode"],
    };
  } finally {
    database.close();
  }
}

async function readProcesses(timeoutMs: number): Promise<WorkBuddyProcessIdentity[]> {
  const output = await runCommand("/bin/ps", ["-axo", "pid=,ppid=,comm="], timeoutMs, "process inventory");
  const base = output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      executablePath: (match[3] ?? "").trim(),
    }));
  const byPid = new Map(base.map((processIdentity) => [processIdentity.pid, processIdentity]));
  return base.map((processIdentity) => ({
    ...processIdentity,
    ancestorPids: ancestorPids(processIdentity, byPid),
  }));
}

function ancestorPids(
  processIdentity: WorkBuddyProcessIdentity,
  byPid: Map<number, WorkBuddyProcessIdentity>,
): number[] {
  const result: number[] = [];
  const seen = new Set<number>([processIdentity.pid]);
  let parentPid = processIdentity.parentPid;
  while (parentPid > 0 && !seen.has(parentPid)) {
    result.push(parentPid);
    seen.add(parentPid);
    parentPid = byPid.get(parentPid)?.parentPid ?? 0;
  }
  return result;
}

function processIdentity(processes: WorkBuddyProcessIdentity[], pid: number): WorkBuddyProcessIdentity {
  return processes.find((candidate) => candidate.pid === pid) ?? { pid, parentPid: 0, executablePath: "[unknown]" };
}

async function readEndpointOwner(endpoint: string, timeoutMs: number): Promise<number | null> {
  const url = new URL(endpoint);
  const output = await runCommand(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP@${url.hostname}:${url.port}`, "-sTCP:LISTEN", "-Fp"],
    timeoutMs,
    "ACP endpoint owner",
    true,
  );
  const pids = [
    ...new Set(
      output
        .split("\n")
        .filter((line) => /^p\d+$/u.test(line))
        .map((line) => Number(line.slice(1))),
    ),
  ];
  return pids.length === 1 ? (pids[0] ?? null) : null;
}

async function confirmEndpointOwner(endpoint: string, timeoutMs: number): Promise<WorkBuddyProcessIdentity | null> {
  const ownerPid = await readEndpointOwner(endpoint, timeoutMs).catch(() => null);
  if (ownerPid === null) return null;
  const processes = await readProcesses(timeoutMs);
  return processIdentity(processes, ownerPid);
}

async function confirmConnectedEndpointOwner(
  identity: WorkBuddyConnectedSocketIdentity,
  timeoutMs: number,
): Promise<WorkBuddyProcessIdentity | null> {
  const output = await runCommand(
    "/usr/sbin/lsof",
    ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpfn"],
    timeoutMs,
    "established ACP connection owner",
    true,
  );
  const expectedConnection = `n${formatSocketAddress(identity.remoteAddress)}:${identity.remotePort}->${formatSocketAddress(identity.localAddress)}:${identity.localPort}`;
  const owners = new Set<number>();
  let processId: number | undefined;
  for (const line of output.split("\n")) {
    if (/^p\d+$/u.test(line)) processId = Number(line.slice(1));
    if (line === expectedConnection && processId !== undefined) owners.add(processId);
  }
  if (owners.size !== 1) return null;
  const [ownerPid] = owners;
  if (ownerPid === undefined) return null;
  return processIdentity(await readProcesses(timeoutMs), ownerPid);
}

function formatSocketAddress(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

function assertConnectedEndpointOwner(
  owner: WorkBuddyProcessIdentity | null,
  expected: {
    profile: WorkBuddyProfile;
    applicationPath: string;
    expectedEndpointProcessId: number;
    expectedSidecarProcessId: number;
  },
): WorkBuddyProcessIdentity {
  const product = workBuddyProfileCompatibility(expected.profile).displayName;
  if (!owner) {
    throw new WorkBuddyDiscoveryError(
      "endpoint-stale",
      `The established ${product} ACP connection has no owning process.`,
    );
  }
  if (owner.pid !== expected.expectedEndpointProcessId) {
    throw new WorkBuddyDiscoveryError("recycled-endpoint", "The established ACP connection has a recycled owner.", {
      expectedProcessId: expected.expectedEndpointProcessId,
      detectedProcessId: owner.pid,
    });
  }
  if (
    !owner.executablePath.startsWith(`${expected.applicationPath}/Contents/`) ||
    (owner.parentPid !== expected.expectedSidecarProcessId &&
      owner.ancestorPids?.includes(expected.expectedSidecarProcessId) !== true)
  ) {
    throw new WorkBuddyDiscoveryError(
      "wrong-owning-process",
      `The established ACP connection is not owned by the selected ${product} sidecar.`,
    );
  }
  return owner;
}

async function prepareWorkBuddyTaskRuntime(input: WorkBuddyTaskRuntimeInput): Promise<void> {
  assertTaskRuntimeComposition(input);
  const compatibility = workBuddyProfileCompatibility(input.profile);
  const runtimeDirectory = sidecarRuntimeDirectory(input.configDirectory);
  const socketPath = join(runtimeDirectory, "sidecar.sock");
  const cliRoot = join(input.resourcesPath, "app.asar.unpacked", "cli");
  const cliCandidates = [join(cliRoot, "bin", "codebuddy"), join(cliRoot, "dist", "codebuddy.js")];
  const cliPath = (
    await Promise.all(cliCandidates.map(async (candidate) => ((await exists(candidate)) ? candidate : null)))
  ).find((candidate): candidate is string => candidate !== null);
  if (!cliPath) {
    throw new WorkBuddyDiscoveryError(
      "incompatible-version",
      `The installed ${compatibility.displayName} Task runtime executable is unavailable for profile ${input.profile}.`,
      { selectedProfile: input.profile },
    );
  }
  const applicationVersion = await readPlistValue(
    join(input.applicationPath, "Contents", "Info.plist"),
    "CFBundleShortVersionString",
    input.commandTimeoutMs,
  );
  const request = buildWorkBuddyTaskRuntimeRequest(input, cliPath, applicationVersion);
  try {
    await withSidecarRpc(socketPath, async (invoke) => {
      await assertCurrentSidecarIdentity(input, compatibility, invoke);
      await reconcileWorkBuddyTaskRuntime(input.profile, request, input.commandTimeoutMs, invoke);
    });
  } catch (error) {
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    const gatewaySecret = request.env.CODEBUDDY_GATEWAY_PASSWORD;
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(gatewaySecret, "[REDACTED]");
    throw new WorkBuddyDiscoveryError(
      "discovery-failed",
      `${compatibility.displayName} Task runtime preparation failed: ${message}`,
      { selectedProfile: input.profile },
    );
  }
}
async function assertCurrentSidecarIdentity(
  input: WorkBuddyTaskRuntimeInput,
  compatibility: WorkBuddyProfileCompatibility,
  invoke: WorkBuddySidecarInvoke,
): Promise<void> {
  const current = await inspectWorkBuddyApplication(input.applicationPath, compatibility, input.commandTimeoutMs);
  const applicationProcess = current.applicationProcess;
  if (
    current.application?.bundleIdentifier !== compatibility.bundleIdentifier ||
    applicationProcess?.pid !== input.sidecarIdentity.applicationProcessId
  ) {
    throw new WorkBuddyDiscoveryError(
      "endpoint-stale",
      `${compatibility.displayName} changed after host verification; Task runtime preparation was not attempted.`,
      { selectedProfile: input.profile },
    );
  }

  const registration = await readJsonFile<unknown>(join(sidecarRuntimeDirectory(input.configDirectory), "sidecar.pid"));
  if (!isSidecarIdentity(registration)) throw malformedSidecarState(input.profile, "registration");
  const liveSidecarIdentity = await invoke("sidecar.ping", input.commandTimeoutMs);
  if (!isSidecarIdentity(liveSidecarIdentity)) throw malformedSidecarState(input.profile, "live identity");

  const expected = input.sidecarIdentity;
  if (
    registration.pid !== expected.sidecarProcessId ||
    registration.version !== expected.sidecarVersion ||
    registration.token !== expected.registrationToken ||
    liveSidecarIdentity.pid !== expected.sidecarProcessId ||
    liveSidecarIdentity.version !== expected.sidecarVersion ||
    liveSidecarIdentity.token !== expected.registrationToken
  ) {
    throw new WorkBuddyDiscoveryError(
      "endpoint-stale",
      `${compatibility.displayName}'s sidecar identity changed after host verification; Task runtime preparation was not attempted.`,
      { selectedProfile: input.profile },
    );
  }

  const sidecarProcess = current.processes.find((candidate) => candidate.pid === expected.sidecarProcessId);
  if (
    !sidecarProcess?.executablePath.startsWith(`${input.applicationPath}/Contents/`) ||
    (sidecarProcess.parentPid !== applicationProcess.pid &&
      sidecarProcess.ancestorPids?.includes(applicationProcess.pid) !== true)
  ) {
    throw new WorkBuddyDiscoveryError(
      "wrong-owning-process",
      `${compatibility.displayName}'s verified sidecar is no longer owned by the selected application.`,
      { selectedProfile: input.profile },
    );
  }
}

type WorkBuddySidecarInvoke = (method: string, timeoutMs: number, params?: unknown) => Promise<unknown>;

export async function reconcileWorkBuddyTaskRuntime(
  profile: WorkBuddyProfile,
  request: WorkBuddyTaskRuntimeRequest,
  commandTimeoutMs: number,
  invoke: WorkBuddySidecarInvoke,
): Promise<void> {
  const existing = await invoke("session.list", commandTimeoutMs);
  if (!isRuntimeSessionInventory(existing)) {
    throw malformedSidecarState(profile, "Session inventory");
  }
  if (existing.some((session) => session.sessionId === request.sessionId)) {
    throw new WorkBuddyDiscoveryError(
      "endpoint-stale",
      "A WorkBuddy-owned Task endpoint appeared after host verification; retry without replacing it.",
      { selectedProfile: profile, taskId: request.sessionId },
    );
  }
  await invoke("session.create", Math.max(commandTimeoutMs, 180_000), request);
}

export function buildWorkBuddyTaskRuntimeRequest(
  input: WorkBuddyTaskRuntimeRequestInput,
  cliPath: string,
  applicationVersion: string,
  gatewaySecret = randomBytes(32).toString("base64url"),
): WorkBuddyTaskRuntimeRequest {
  assertTaskRuntimeComposition(input);
  const cliRoot = join(input.resourcesPath, "app.asar.unpacked", "cli");
  const trustedWorkspace = `${input.workspace.replace(/[/\\]+$/u, "") || input.workspace}/**`;
  return {
    sessionId: input.taskId,
    command: join(input.applicationPath, "Contents", "MacOS", "Electron"),
    args: [
      cliPath,
      "--serve",
      "--session-id",
      input.taskId,
      "--permission-mode",
      input.selection.permissionMode,
      "--allowedTools",
      "present_files",
      "read_me",
      "show_widget",
      "connect_cloud_service",
      "WebFetch",
      "Bash(mcporter:*)",
      ...(input.selection.model ? ["--model", input.selection.model] : []),
      "--settings",
      JSON.stringify({ trustedDirectories: [trustedWorkspace] }),
    ],
    cwd: input.workspace,
    env: {
      DISABLE_AUTOUPDATER: "1",
      ELECTRON_RUN_AS_NODE: "1",
      CODEBUDDY_DISABLE_IDE: "1",
      SERVER__PORT: "0",
      SERVER__HOST: "127.0.0.1",
      CODEBUDDY_CONFIG_DIR: input.configDirectory,
      WORKBUDDY_CONFIG_DIR: input.configDirectory,
      WORKBUDDY_DATA_FOLDER_NAME: input.dataFolderName,
      CODEBUDDY_GATEWAY_AUTH: "password",
      CODEBUDDY_GATEWAY_PASSWORD: gatewaySecret,
      CODEBUDDY_GATEWAY_DISABLE_API_DOCS: "1",
      CODEBUDDY_DISABLE_CRON: "1",
      CODEBUDDY_INCLUDE_TOPIC_MESSAGE: "1",
      CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1",
      CODEBUDDY_BUILTIN_SKILLS_DIR: join(input.resourcesPath, "app.asar.unpacked", "resources", "builtin-skills"),
      CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
      CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1",
      CODEBUDDY_DISABLE_REQUEST_VALIDATION: "1",
      CODEBUDDY_SKIP_GIT_BASH_CHECK: "1",
      CODEBUDDY_HOST: "workbuddy-desktop",
      CODEBUDDY_HIGH_CREDIT_APPROVAL_ENABLED: "1",
      CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS: "1",
      CODEBUDDY_DISABLE_SESSION_HISTORY_CLEANUP: "1",
      CODEBUDDY_POWERSHELL_USE_PTY: "1",
      CODEBUDDY_REPLAY_SHOW_PRE_COMPACT: "1",
      CODEBUDDY_REASONING_ONLY_END_TURN: "1",
      CODEBUDDY_CODE_IMAGE_COMPRESSION_MAX_DIMENSION: "1080",
      CODEBUDDY_SKILL_TOOL_CHAR_BUDGET: "30000",
      CODEBUDDY_DISABLE_FORK_SUBAGENT: "1",
      CODEBUDDY_ENABLE_SECURITY_AUDIT: "1",
      CODEBUDDY_HOST_CAPABILITIES: "elicitation.form,weixinpay.interception",
      ACC_PRODUCT_CONFIG_PATH: join(cliRoot, "product.json"),
      WORKBUDDY_APP_PATH: input.applicationPath,
      WORKBUDDY_APP_VERSION: applicationVersion,
      WORKBUDDY_IS_PACKAGED: "true",
      WORKBUDDY_NODE_ENV: "production",
      WORKBUDDY_RESOURCES_PATH: input.resourcesPath,
    },
    port: 0,
  };
}

function assertTaskRuntimeComposition(input: WorkBuddyTaskRuntimeRequestInput): void {
  const compatibility = workBuddyProfileCompatibility(input.profile);
  const expectedResourcesPath = join(compatibility.applicationPath, "Contents", "Resources");
  if (
    input.applicationPath !== compatibility.applicationPath ||
    input.configDirectory !== compatibility.configDirectory ||
    input.dataFolderName !== compatibility.dataFolderName ||
    input.resourcesPath !== expectedResourcesPath
  ) {
    throw new WorkBuddyDiscoveryError(
      "wrong-distribution",
      `The ${compatibility.displayName} Task runtime inputs combine resources from different distributions.`,
      {
        selectedProfile: input.profile,
        expectedApplicationPath: compatibility.applicationPath,
        expectedConfigDirectory: compatibility.configDirectory,
        expectedDataFolderName: compatibility.dataFolderName,
        expectedResourcesPath,
      },
    );
  }
  if (
    !WORKBUDDY_PERMISSION_MODES.has(input.selection.permissionMode) ||
    (input.selection.model !== null &&
      (typeof input.selection.model !== "string" ||
        input.selection.model.length === 0 ||
        input.selection.model.trim() !== input.selection.model))
  ) {
    throw new WorkBuddyDiscoveryError(
      "incompatible-version",
      `The ${compatibility.displayName} Task runtime selection cannot be reproduced exactly.`,
      {
        selectedProfile: input.profile,
        detectedPermissionMode: input.selection.permissionMode,
      },
    );
  }
}

function isRuntimeSessionInventory(
  value: unknown,
): value is Array<{ sessionId: string; pid: number; acpEndpoint: string }> {
  return Array.isArray(value) && value.every(isSidecarSession);
}

async function sidecarRpc<Result>(
  socketPath: string,
  method: string,
  timeoutMs: number,
  params?: unknown,
): Promise<Result> {
  return (await withSidecarRpc(socketPath, async (invoke) => await invoke(method, timeoutMs, params))) as Result;
}

async function withSidecarRpc<Result>(
  socketPath: string,
  operation: (invoke: WorkBuddySidecarInvoke) => Promise<Result>,
): Promise<Result> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    const connected = () => {
      socket.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      socket.off("connect", connected);
      reject(error);
    };
    socket.once("connect", connected);
    socket.once("error", failed);
  });

  let buffer = "";
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const failPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let response: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        response = JSON.parse(line) as typeof response;
      } catch {
        socket.destroy(new Error("WorkBuddy sidecar returned malformed JSON"));
        return;
      }
      if (!Number.isSafeInteger(response.id)) {
        socket.destroy(new Error("WorkBuddy sidecar returned a response without a valid request ID"));
        return;
      }
      const request = pending.get(response.id as number);
      if (!request) {
        socket.destroy(new Error("WorkBuddy sidecar returned an unexpected request ID"));
        return;
      }
      pending.delete(response.id as number);
      clearTimeout(request.timer);
      if (response.error) request.reject(new Error(response.error.message ?? "WorkBuddy sidecar request failed"));
      else request.resolve(response.result);
    }
  });
  socket.on("error", failPending);
  socket.on("close", () => {
    if (pending.size) failPending(new Error("WorkBuddy sidecar closed the authenticated control connection"));
  });

  const invoke: WorkBuddySidecarInvoke = async (method, timeoutMs, params) => {
    const id = nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error("WorkBuddy sidecar control request timed out");
        reject(error);
        socket.destroy(error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
        (error) => {
          if (!error) return;
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          clearTimeout(request.timer);
          request.reject(error);
        },
      );
    });
  };

  try {
    return await operation(invoke);
  } finally {
    socket.end();
  }
}

function sidecarRuntimeDirectory(configDirectory: string): string {
  const hash = (value: string, length: number) => createHash("sha1").update(value).digest("hex").slice(0, length);
  const uid = process.getuid?.();
  const base = uid === undefined ? "wb" : `wb-${hash(String(uid), 6)}`;
  return join(tmpdir(), base, hash(configDirectory, 12));
}

async function readJsonFile<Value>(path: string): Promise<Value | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Value;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  label: string,
  acceptFailure = false,
): Promise<string> {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      }),
      readStream(child.stdout),
      readStream(child.stderr),
    ]);
    if (code !== 0 && !acceptFailure) throw new Error(`${label} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let result = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream) result += String(chunk);
  return result;
}
