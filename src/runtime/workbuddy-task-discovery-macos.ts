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
  type WorkBuddyProcessIdentity,
  type WorkBuddyProfile,
  type WorkBuddyProfileCompatibility,
  type WorkBuddyTaskDiscoveryInput,
  type WorkBuddyTaskDiscoverySource,
  workBuddyProfileCompatibility,
} from "./workbuddy-task-discovery";
import { readWorkBuddyTaskTranscriptIdentity } from "./workbuddy-task-transcript";

export interface WorkBuddyMacosDiscoveryOptions {
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
  prepareTaskRuntime?: (input: WorkBuddyTaskRuntimeInput) => Promise<void>;
  readTaskRuntimeSelection?: (configDirectory: string, taskId: string) => Promise<WorkBuddyTaskRuntimeSelection>;
}

export interface WorkBuddyTaskRuntimeSelection {
  model: string | null;
  permissionMode: "fullAccess" | "plan" | "default" | "acceptEdits" | "bypassPermissions";
}

export interface WorkBuddyTaskRuntimeInput {
  applicationPath: string;
  configDirectory: string;
  taskId: string;
  workspace: string;
  selection: WorkBuddyTaskRuntimeSelection;
  commandTimeoutMs: number;
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
      `${compatibility.displayName} is not installed at the selected application path; install ${compatibility.displayName} ${compatibility.applicationVersion}.`,
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
  if (
    application.version !== compatibility.applicationVersion ||
    application.embeddedCodeBuddyVersion !== compatibility.embeddedCodeBuddyVersion
  ) {
    throw new WorkBuddyDiscoveryError(
      "incompatible-version",
      `The installed ${compatibility.displayName} tuple is unsupported for profile ${profile}.`,
      {
        selectedProfile: profile,
        detectedApplicationVersion: application.version,
        detectedEmbeddedCodeBuddyVersion: application.embeddedCodeBuddyVersion,
        supportedApplicationVersion: compatibility.applicationVersion,
        supportedEmbeddedCodeBuddyVersion: compatibility.embeddedCodeBuddyVersion,
        supportedAcpVersion: compatibility.acpVersion,
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
  const database = new Database(join(configDirectory, "workbuddy.db"), { readonly: true });
  try {
    const rows = database
      .query<{ id: string; cwd: string; title: string | null; custom_title: string | null; updated_at: number }, []>(
        "SELECT id, cwd, title, custom_title, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC, id",
      )
      .all();
    return await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        title: row.custom_title || row.title || null,
        workspace: await realpath(row.cwd).catch(() => row.cwd),
        updatedAt: row.updated_at,
      })),
    );
  } finally {
    database.close();
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
  return {
    ...(profile === "workbuddy-cn"
      ? {
          prepareEndpoint: async (input: WorkBuddyTaskDiscoveryInput) => {
            if (input.profile !== profile) throw wrongDiscoverySource(profile, input.profile);
            const selection = options.readTaskRuntimeSelection
              ? await options.readTaskRuntimeSelection(configDirectory, input.taskId)
              : await readWorkBuddyTaskRuntimeSelection(configDirectory, input.taskId);
            await (options.prepareTaskRuntime ?? prepareWorkBuddyTaskRuntime)({
              applicationPath,
              configDirectory,
              taskId: input.taskId,
              workspace: await realpath(input.expectedWorkspace),
              selection,
              commandTimeoutMs,
            });
          },
        }
      : {}),
    canonicalizeWorkspace: async (workspace) => await realpath(workspace),
    inspect: async (input) => {
      if (input.profile !== profile) {
        throw wrongDiscoverySource(profile, input.profile);
      }
      return await inspectWorkBuddy(input, { applicationPath, configDirectory, commandTimeoutMs, compatibility });
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

export type WorkBuddyAiMacosDiscoveryOptions = WorkBuddyMacosDiscoveryOptions;
export type WorkBuddyAiTaskCatalogEntry = WorkBuddyTaskCatalogEntry;

export async function listWorkBuddyAiTasks(
  profile: WorkBuddyProfile,
  options: WorkBuddyAiMacosDiscoveryOptions = {},
): Promise<WorkBuddyAiTaskCatalogEntry[]> {
  return await listWorkBuddyTasks(profile, options);
}

export function createWorkBuddyAiMacosDiscoverySource(
  options: WorkBuddyAiMacosDiscoveryOptions = {},
): WorkBuddyTaskDiscoverySource {
  return createWorkBuddyMacosDiscoverySource("workbuddy-ai", options);
}

async function inspectWorkBuddy(
  input: WorkBuddyTaskDiscoveryInput,
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
  const registration = await readJsonFile<{ pid: number; token: string; version: number }>(
    join(runtimeDirectory, "sidecar.pid"),
  );
  if (!registration) {
    return { ...emptyObservation(), application, applicationProcess, task };
  }
  const liveSidecarIdentity = await sidecarRpc<{ pid: number; token: string; version: number }>(
    join(runtimeDirectory, "sidecar.sock"),
    "sidecar.ping",
    options.commandTimeoutMs,
  ).catch(() => null);
  const sidecarIdentity = liveSidecarIdentity
    ? {
        pid: liveSidecarIdentity.pid,
        version: liveSidecarIdentity.version,
        registrationTokenMatches: liveSidecarIdentity.token === registration.token,
      }
    : null;
  const sessions = liveSidecarIdentity
    ? await sidecarRpc<Array<{ sessionId: string; pid: number; acpEndpoint: string }>>(
        join(runtimeDirectory, "sidecar.sock"),
        "session.list",
        options.commandTimeoutMs,
      ).catch(() => [])
    : [];
  const validSessions = sessions.filter(
    (session) => Number.isSafeInteger(session.pid) && typeof session.acpEndpoint === "string",
  );
  const exactTaskCandidates = validSessions.filter((session) => session.sessionId === input.taskId);
  const endpointCandidates = exactTaskCandidates.length
    ? exactTaskCandidates
    : validSessions.filter((session) => isWorkBuddyProfileHostSession(input.profile, session.sessionId));
  const endpointCandidate = endpointCandidates[0];
  const endpointSession =
    endpointCandidates.length === 1 && endpointCandidate
      ? {
          sessionId: endpointCandidate.sessionId,
          pid: endpointCandidate.pid,
          endpoint: endpointCandidate.acpEndpoint,
        }
      : null;
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
    readEmbeddedCodeBuddyVersion(applicationPath).catch(() => "[unreadable]"),
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
  return (
    await runCommand("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path], timeoutMs, "WorkBuddy Info.plist")
  ).trim();
}

async function readEmbeddedCodeBuddyVersion(applicationPath: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(applicationPath, "Contents", "Resources", "app.asar.unpacked", "cli", "package.json"), "utf8"),
  ) as { publishConfig?: { customPackage?: { version?: unknown } } };
  const version = manifest.publishConfig?.customPackage?.version;
  if (typeof version !== "string") throw new Error("WorkBuddy embedded CodeBuddy manifest has no pinned version");
  return version;
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
  configDirectory: string,
  taskId: string,
): Promise<WorkBuddyTaskRuntimeSelection> {
  const database = new Database(join(configDirectory, "workbuddy.db"), { readonly: true });
  try {
    const row = database
      .query<{ model: string | null; permission_mode: string | null }, [string]>(
        "SELECT model, permission_mode FROM sessions WHERE id = ? AND deleted_at IS NULL",
      )
      .get(taskId);
    if (!row) {
      throw new WorkBuddyDiscoveryError("task-not-found", "The requested WorkBuddy Task has no runtime selection.", {
        taskId,
      });
    }
    const permissionMode = WORKBUDDY_PERMISSION_MODES.has(
      row.permission_mode as WorkBuddyTaskRuntimeSelection["permissionMode"],
    )
      ? (row.permission_mode as WorkBuddyTaskRuntimeSelection["permissionMode"])
      : "bypassPermissions";
    return {
      model: typeof row.model === "string" && row.model.trim() ? row.model.trim() : null,
      permissionMode,
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
  const runtimeDirectory = sidecarRuntimeDirectory(input.configDirectory);
  const socketPath = join(runtimeDirectory, "sidecar.sock");
  const existing = await sidecarRpc<Array<{ sessionId: string }>>(socketPath, "session.list", input.commandTimeoutMs);
  if (existing.some((session) => session.sessionId === input.taskId)) return;

  const resourcesPath = join(input.applicationPath, "Contents", "Resources");
  const cliRoot = join(resourcesPath, "app.asar.unpacked", "cli");
  const cliCandidates = [join(cliRoot, "bin", "codebuddy"), join(cliRoot, "dist", "codebuddy.js")];
  const cliPath = (
    await Promise.all(cliCandidates.map(async (candidate) => ((await exists(candidate)) ? candidate : null)))
  ).find((candidate): candidate is string => candidate !== null);
  if (!cliPath) {
    throw new WorkBuddyDiscoveryError(
      "incompatible-version",
      "The installed WorkBuddy Task runtime executable is unavailable for profile workbuddy-cn.",
      { selectedProfile: "workbuddy-cn" },
    );
  }
  const request = buildWorkBuddyTaskRuntimeRequest(input, cliPath);
  try {
    await sidecarRpc(socketPath, "session.create", Math.max(input.commandTimeoutMs, 180_000), request);
  } catch (error) {
    const raced = await sidecarRpc<Array<{ sessionId: string }>>(
      socketPath,
      "session.list",
      input.commandTimeoutMs,
    ).catch(() => []);
    if (!raced.some((session) => session.sessionId === input.taskId)) throw error;
  }
}

export function buildWorkBuddyTaskRuntimeRequest(
  input: WorkBuddyTaskRuntimeInput,
  cliPath: string,
  gatewaySecret = randomBytes(32).toString("base64url"),
): WorkBuddyTaskRuntimeRequest {
  const resourcesPath = join(input.applicationPath, "Contents", "Resources");
  const cliRoot = join(resourcesPath, "app.asar.unpacked", "cli");
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
      WORKBUDDY_DATA_FOLDER_NAME: ".workbuddy",
      CODEBUDDY_GATEWAY_AUTH: "password",
      CODEBUDDY_GATEWAY_PASSWORD: gatewaySecret,
      CODEBUDDY_GATEWAY_DISABLE_API_DOCS: "1",
      CODEBUDDY_DISABLE_CRON: "1",
      CODEBUDDY_INCLUDE_TOPIC_MESSAGE: "1",
      CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1",
      CODEBUDDY_BUILTIN_SKILLS_DIR: join(resourcesPath, "app.asar.unpacked", "resources", "builtin-skills"),
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
      WORKBUDDY_APP_VERSION: workBuddyProfileCompatibility("workbuddy-cn").applicationVersion,
      WORKBUDDY_IS_PACKAGED: "true",
      WORKBUDDY_NODE_ENV: "production",
      WORKBUDDY_RESOURCES_PATH: resourcesPath,
    },
    port: 0,
  };
}

async function sidecarRpc<Result>(
  socketPath: string,
  method: string,
  timeoutMs: number,
  params?: unknown,
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("WorkBuddy sidecar control request timed out")));
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      const response = JSON.parse(buffer.slice(0, newline)) as { result?: Result; error?: { message?: string } };
      if (response.error) reject(new Error(response.error.message ?? "WorkBuddy sidecar request failed"));
      else resolve(response.result as Result);
    });
    socket.once("error", reject);
  });
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
