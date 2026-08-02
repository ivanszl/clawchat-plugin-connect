import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkbuddyDiscoveryObservation,
  WorkbuddyEndpointVerification,
  WorkbuddyProcessIdentity,
  WorkbuddyTaskDiscoveryInput,
  WorkbuddyTaskDiscoverySource,
} from "./workbuddy-task-discovery";

const DEFAULT_APPLICATION_PATH = "/Applications/WorkBuddy AI.app";
const BUNDLE_IDENTIFIER = "com.workbuddy.workbuddy-ai";
const HOST_SESSION_PREFIX = "__workbuddy_cli_host__-";

export interface WorkbuddyAiMacosDiscoveryOptions {
  applicationPath?: string;
  configDirectory?: string;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export function createWorkbuddyAiMacosDiscoverySource(
  options: WorkbuddyAiMacosDiscoveryOptions = {},
): WorkbuddyTaskDiscoverySource {
  const applicationPath = options.applicationPath ?? DEFAULT_APPLICATION_PATH;
  const configDirectory = options.configDirectory ?? join(homedir(), ".workbuddy-ai");
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  return {
    canonicalizeWorkspace: async (workspace) => await realpath(workspace),
    inspect: async (input) => await inspectWorkbuddyAi(input, { applicationPath, configDirectory, commandTimeoutMs }),
    verifyEndpoint: async (input) => await verifyWorkbuddyAiEndpoint(input, requestTimeoutMs),
  };
}

async function inspectWorkbuddyAi(
  input: WorkbuddyTaskDiscoveryInput,
  options: { applicationPath: string; configDirectory: string; commandTimeoutMs: number },
): Promise<WorkbuddyDiscoveryObservation> {
  if (!(await exists(options.applicationPath))) return emptyObservation();
  const [bundleIdentifier, version] = await Promise.all([
    readPlistValue(
      join(options.applicationPath, "Contents", "Info.plist"),
      "CFBundleIdentifier",
      options.commandTimeoutMs,
    ),
    readPlistValue(
      join(options.applicationPath, "Contents", "Info.plist"),
      "CFBundleShortVersionString",
      options.commandTimeoutMs,
    ),
  ]);
  if (bundleIdentifier !== BUNDLE_IDENTIFIER) {
    return {
      ...emptyObservation(),
      application: {
        path: options.applicationPath,
        bundleIdentifier,
        version,
        embeddedCodeBuddyVersion: "[wrong-distribution]",
      },
    };
  }
  const [embeddedCodeBuddyVersion, processes] = await Promise.all([
    readEmbeddedCodeBuddyVersion(options.applicationPath).catch(() => "[unreadable]"),
    readProcesses(options.commandTimeoutMs),
  ]);
  const application = { path: options.applicationPath, bundleIdentifier, version, embeddedCodeBuddyVersion };
  const executablePath = join(options.applicationPath, "Contents", "MacOS", "Electron");
  const applicationProcess =
    processes.find((candidate) => candidate.parentPid === 1 && candidate.executablePath === executablePath) ?? null;
  if (!applicationProcess) return { ...emptyObservation(), application };

  const task = readTask(options.configDirectory, input.taskId);
  const runtimeDirectory = sidecarRuntimeDirectory(options.configDirectory);
  const registration = await readJsonFile<{ pid: number; token: string; version: number }>(
    join(runtimeDirectory, "sidecar.pid"),
  );
  if (!registration) {
    return { ...emptyObservation(), application, applicationProcess, task };
  }
  const sidecarIdentity = await sidecarRpc<{ pid: number; token: string; version: number }>(
    join(runtimeDirectory, "sidecar.sock"),
    "sidecar.ping",
    options.commandTimeoutMs,
  ).catch(() => null);
  const sessions = sidecarIdentity
    ? await sidecarRpc<Array<{ sessionId: string; pid: number; acpEndpoint: string }>>(
        join(runtimeDirectory, "sidecar.sock"),
        "session.list",
        options.commandTimeoutMs,
      ).catch(() => [])
    : [];
  const endpointCandidates = sessions.filter(
    (session) =>
      session.sessionId.startsWith(HOST_SESSION_PREFIX) &&
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
    sidecarRegistration: registration,
    sidecarIdentity,
    sidecarProcess,
    endpointSession,
    endpointOwner,
  };
}

async function verifyWorkbuddyAiEndpoint(
  input: { endpoint: string; taskId: string; workspace: string; acpVersion: number },
  timeoutMs: number,
): Promise<WorkbuddyEndpointVerification> {
  let connectionId = "";
  let sessionToken = "";
  try {
    const bootstrap = await fetch(`${input.endpoint}/connect`, {
      method: "POST",
      headers: { "x-codebuddy-request": "1" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!bootstrap.ok) throw new Error(`ACP connect failed with HTTP ${bootstrap.status}`);
    const credentials = (await bootstrap.json()) as { connectionId?: unknown; sessionToken?: unknown };
    if (typeof credentials.connectionId !== "string" || !credentials.connectionId)
      throw new Error("ACP connect response omitted its connection identifier");
    connectionId = credentials.connectionId;
    sessionToken = typeof credentials.sessionToken === "string" ? credentials.sessionToken : "";
    const headers = acpHeaders(connectionId, sessionToken);
    const initialized = await postRpc(
      input.endpoint,
      headers,
      1,
      "initialize",
      {
        protocolVersion: input.acpVersion,
        clientInfo: { name: "clawchat-connect-discovery", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      timeoutMs,
    );
    const initializedProtocol = (initialized.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (initializedProtocol !== input.acpVersion)
      throw new Error("ACP initialize returned an incompatible protocol version");
    const loaded = await postRpc(
      input.endpoint,
      headers,
      2,
      "session/load",
      { sessionId: input.taskId, cwd: input.workspace, mcpServers: [] },
      timeoutMs,
    );
    const observedTaskId = loaded.taskIds.find((candidate) => candidate !== input.taskId) ?? loaded.taskIds[0];
    if (!observedTaskId) throw new Error("ACP replay emitted no Task identity");
    return {
      taskId: observedTaskId,
      replayStarted: loaded.replayStarted,
      replayCompleted: loaded.replayCompleted,
    };
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error), [connectionId, sessionToken]));
  } finally {
    if (connectionId) {
      await fetch(input.endpoint, {
        method: "DELETE",
        headers: acpHeaders(connectionId, sessionToken),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)),
      }).catch(() => undefined);
    }
  }
}

interface RpcObservation {
  result?: unknown;
  taskIds: string[];
  replayStarted: boolean;
  replayCompleted: boolean;
}

async function postRpc(
  endpoint: string,
  headers: Record<string, string>,
  id: number,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<RpcObservation> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`ACP ${method} failed with HTTP ${response.status}`);
  const observation: RpcObservation = { taskIds: [], replayStarted: false, replayCompleted: false };
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`ACP ${method} returned no response stream`);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = consumeSse(buffer, (payload) => observeRpcPayload(payload, id, observation));
        if (done) break;
      }
      if (buffer.trim()) consumeSse(`${buffer}\n\n`, (payload) => observeRpcPayload(payload, id, observation));
    } finally {
      reader.releaseLock();
    }
  } else {
    const payload = await response.json();
    observeRpcPayload(payload, id, observation);
  }
  if (observation.result === undefined) throw new Error(`ACP ${method} returned no JSON-RPC result`);
  return observation;
}

function consumeSse(buffer: string, onPayload: (payload: unknown) => void): string {
  let boundary = buffer.search(/\r?\n\r?\n/u);
  while (boundary >= 0) {
    const block = buffer.slice(0, boundary);
    const separator = /^\r\n\r\n/u.test(buffer.slice(boundary)) ? 4 : 2;
    buffer = buffer.slice(boundary + separator);
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onPayload(JSON.parse(data));
    boundary = buffer.search(/\r?\n\r?\n/u);
  }
  return buffer;
}

function observeRpcPayload(payload: unknown, expectedId: number, observation: RpcObservation): void {
  if (typeof payload !== "object" || payload === null) return;
  const message = payload as Record<string, unknown>;
  if (message.id === expectedId && !("method" in message)) {
    const error = message.error as { message?: unknown } | undefined;
    if (error) throw new Error(typeof error.message === "string" ? error.message : "ACP JSON-RPC request failed");
    observation.result = message.result ?? {};
    return;
  }
  if (message.method !== "session/update") return;
  const params = message.params as Record<string, unknown> | undefined;
  const taskId = params?.sessionId;
  if (typeof taskId === "string" && !observation.taskIds.includes(taskId)) observation.taskIds.push(taskId);
  const update = params?.update as Record<string, unknown> | undefined;
  const meta = update?._meta as Record<string, unknown> | undefined;
  if (meta?.["codebuddy.ai/historyReplay"] === "start") observation.replayStarted = true;
  if (meta?.["codebuddy.ai/historyReplay"] === "end") observation.replayCompleted = true;
}

function acpHeaders(connectionId: string, sessionToken: string): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "x-codebuddy-request": "1",
    "acp-connection-id": connectionId,
    ...(sessionToken ? { "acp-session-token": sessionToken } : {}),
  };
}

function emptyObservation(): WorkbuddyDiscoveryObservation {
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

function readTask(configDirectory: string, taskId: string): { id: string; workspace: string } | null {
  const database = new Database(join(configDirectory, "workbuddy.db"), { readonly: true });
  try {
    const row = database
      .query<{ id: string; cwd: string }, [string]>("SELECT id, cwd FROM sessions WHERE id = ? AND deleted_at IS NULL")
      .get(taskId);
    return row ? { id: row.id, workspace: row.cwd } : null;
  } finally {
    database.close();
  }
}

async function readProcesses(timeoutMs: number): Promise<WorkbuddyProcessIdentity[]> {
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
  processIdentity: WorkbuddyProcessIdentity,
  byPid: Map<number, WorkbuddyProcessIdentity>,
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

function processIdentity(processes: WorkbuddyProcessIdentity[], pid: number): WorkbuddyProcessIdentity {
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

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => (secret ? result.replaceAll(secret, "[REDACTED]") : result), value);
}
