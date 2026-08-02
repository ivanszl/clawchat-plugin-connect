import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  openWorkBuddyAiTaskEndpoint,
  verifyWorkBuddyAiEndpoint,
  type WorkBuddyConnectedSocketIdentity,
} from "./workbuddy-acp-client";
import {
  WORKBUDDY_AI_COMPATIBILITY,
  WorkBuddyDiscoveryError,
  type WorkBuddyDiscoveryObservation,
  type WorkBuddyProcessIdentity,
  type WorkBuddyProfile,
  type WorkBuddyTaskDiscoveryInput,
  type WorkBuddyTaskDiscoverySource,
} from "./workbuddy-task-discovery";
import { readWorkBuddyTaskTranscriptIdentity } from "./workbuddy-task-transcript";

const DEFAULT_APPLICATION_PATH = "/Applications/WorkBuddy AI.app";
const BUNDLE_IDENTIFIER = "com.workbuddy.workbuddy-ai";

export interface WorkBuddyAiMacosDiscoveryOptions {
  applicationPath?: string;
  configDirectory?: string;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface WorkBuddyAiTaskCatalogEntry {
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

export async function listWorkBuddyAiTasks(
  profile: WorkBuddyProfile,
  options: WorkBuddyAiMacosDiscoveryOptions = {},
): Promise<WorkBuddyAiTaskCatalogEntry[]> {
  const applicationPath = options.applicationPath ?? DEFAULT_APPLICATION_PATH;
  const configDirectory = options.configDirectory ?? join(homedir(), ".workbuddy-ai");
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  const { application, applicationProcess } = await inspectWorkBuddyApplication(applicationPath, commandTimeoutMs);
  if (!application) {
    throw new WorkBuddyDiscoveryError(
      "application-absent",
      "WorkBuddy AI is not installed at the selected application path; install WorkBuddy AI 5.2.7.",
    );
  }
  if (application.bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw new WorkBuddyDiscoveryError("wrong-distribution", "The selected application is not WorkBuddy AI.", {
      selectedProfile: profile,
      detectedBundleIdentifier: application.bundleIdentifier,
    });
  }
  if (
    application.version !== WORKBUDDY_AI_COMPATIBILITY.applicationVersion ||
    application.embeddedCodeBuddyVersion !== WORKBUDDY_AI_COMPATIBILITY.embeddedCodeBuddyVersion
  ) {
    throw new WorkBuddyDiscoveryError("incompatible-version", "The installed WorkBuddy AI tuple is unsupported.", {
      selectedProfile: profile,
      detectedApplicationVersion: application.version,
      detectedEmbeddedCodeBuddyVersion: application.embeddedCodeBuddyVersion,
    });
  }
  if (!applicationProcess) {
    throw new WorkBuddyDiscoveryError(
      "application-stopped",
      "WorkBuddy AI is installed but not running; open it before discovering Tasks.",
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

export function createWorkBuddyAiMacosDiscoverySource(
  options: WorkBuddyAiMacosDiscoveryOptions = {},
): WorkBuddyTaskDiscoverySource {
  const applicationPath = options.applicationPath ?? DEFAULT_APPLICATION_PATH;
  const configDirectory = options.configDirectory ?? join(homedir(), ".workbuddy-ai");
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  return {
    canonicalizeWorkspace: async (workspace) => await realpath(workspace),
    inspect: async (input) => await inspectWorkBuddyAi(input, { applicationPath, configDirectory, commandTimeoutMs }),
    verifyEndpoint: async (input) =>
      await verifyWorkBuddyAiEndpoint(input, requestTimeoutMs, async (identity) =>
        assertConnectedEndpointOwner(await confirmConnectedEndpointOwner(identity, commandTimeoutMs), input),
      ),
    connectEndpoint: async (input) =>
      await openWorkBuddyAiTaskEndpoint(input, requestTimeoutMs, async (identity) =>
        assertConnectedEndpointOwner(await confirmConnectedEndpointOwner(identity, commandTimeoutMs), input),
      ),
    confirmEndpointOwner: async (endpoint) => await confirmEndpointOwner(endpoint, commandTimeoutMs),
  };
}

async function inspectWorkBuddyAi(
  input: WorkBuddyTaskDiscoveryInput,
  options: { applicationPath: string; configDirectory: string; commandTimeoutMs: number },
): Promise<WorkBuddyDiscoveryObservation> {
  const { application, applicationProcess, processes } = await inspectWorkBuddyApplication(
    options.applicationPath,
    options.commandTimeoutMs,
  );
  if (!application) return emptyObservation();
  if (application.bundleIdentifier !== BUNDLE_IDENTIFIER) return { ...emptyObservation(), application };
  if (!applicationProcess) return { ...emptyObservation(), application };

  const task = await readTask(options.configDirectory, input.taskId);
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
  const endpointCandidates = sessions.filter(
    (session) =>
      session.sessionId === input.taskId &&
      Number.isSafeInteger(session.pid) &&
      typeof session.acpEndpoint === "string",
  );
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
  commandTimeoutMs: number,
): Promise<WorkBuddyApplicationInspection> {
  if (!(await exists(applicationPath))) return { application: null, applicationProcess: null, processes: [] };
  const [bundleIdentifier, version] = await Promise.all([
    readPlistValue(join(applicationPath, "Contents", "Info.plist"), "CFBundleIdentifier", commandTimeoutMs),
    readPlistValue(join(applicationPath, "Contents", "Info.plist"), "CFBundleShortVersionString", commandTimeoutMs),
  ]);
  if (bundleIdentifier !== BUNDLE_IDENTIFIER) {
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
  if (typeof version !== "string") throw new Error("WorkBuddy AI embedded CodeBuddy manifest has no pinned version");
  return version;
}

async function readTask(
  configDirectory: string,
  taskId: string,
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
    const transcript = await readWorkBuddyTaskTranscriptIdentity(configDirectory, row.id, row.cwd);
    return { id: row.id, workspace: row.cwd, ...transcript };
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
  expected: { applicationPath: string; expectedEndpointProcessId: number; expectedSidecarProcessId: number },
): WorkBuddyProcessIdentity {
  if (!owner) {
    throw new WorkBuddyDiscoveryError(
      "endpoint-stale",
      "The established WorkBuddy AI ACP connection has no owning process.",
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
      "The established ACP connection is not owned by the selected WorkBuddy AI sidecar.",
    );
  }
  return owner;
}

async function sidecarRpc<Result>(socketPath: string, method: string, timeoutMs: number): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("WorkBuddy sidecar control request timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method })}\n`));
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
