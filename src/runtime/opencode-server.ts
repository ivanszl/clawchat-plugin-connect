import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  Agent,
  Command,
  FilePartInput,
  GlobalEvent,
  Message,
  Part,
  Provider,
  QuestionAnswer,
  Session,
  SessionStatus,
  TextPartInput,
} from "@opencode-ai/sdk/v2/types";
import { CONNECT_VERSION } from "../service/version";
import type { OpenCodeAgentBindingConfig } from "../types";

export const OPENCODE_SDK_VERSION = "1.18.10" as const;
export const SUPPORTED_OPENCODE_VERSIONS = [OPENCODE_SDK_VERSION] as const;

export interface OpenCodeMessage {
  info: Message;
  parts: Part[];
}

export interface OpenCodePromptInput {
  sessionID: string;
  directory: string;
  messageID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  parts: Array<TextPartInput | FilePartInput>;
}

export interface OpenCodeCommandInput {
  sessionID: string;
  directory: string;
  messageID: string;
  agent?: string;
  model?: string;
  variant?: string;
  command: string;
  arguments: string;
  parts?: Array<FilePartInput>;
}

export interface OpenCodeApiClient {
  health(): Promise<{ healthy: true; version: string }>;
  listAgents(directory: string): Promise<Agent[]>;
  listCommands(directory: string): Promise<Command[]>;
  listProviders(directory: string): Promise<{ all: Provider[]; connected: string[]; default: Record<string, string> }>;
  listSessions(directory?: string, rootsOnly?: boolean): Promise<Session[]>;
  getSession(sessionID: string, directory: string): Promise<Session>;
  createSession(directory: string, title?: string): Promise<Session>;
  deleteSession(sessionID: string, directory: string): Promise<boolean>;
  sessionStatus(directory: string): Promise<Record<string, SessionStatus>>;
  messages(sessionID: string, directory: string): Promise<OpenCodeMessage[]>;
  promptAsync(input: OpenCodePromptInput): Promise<void>;
  runCommand(input: OpenCodeCommandInput): Promise<void>;
  abortSession(sessionID: string, directory: string): Promise<boolean>;
  events(signal: AbortSignal, onConnected?: () => void): AsyncIterable<GlobalEvent>;
  replyPermission(requestID: string, directory: string, reply: "once" | "always" | "reject"): Promise<boolean>;
  replyQuestion(requestID: string, directory: string, answers: QuestionAnswer[]): Promise<boolean>;
  rejectQuestion(requestID: string, directory: string): Promise<boolean>;
}

export interface OpenCodeServerClient extends OpenCodeApiClient {
  readonly version: string;
  close(): Promise<void>;
}

export interface OpenCodeServerProcess {
  readonly stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface OpenCodeServerClientOptions {
  findExecutable?: (name: string, path: string | undefined) => string | null;
  readVersion?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string>;
  allocatePort?: () => Promise<number>;
  password?: () => string;
  spawnServer?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => OpenCodeServerProcess;
  createApi?: (baseUrl: string, username: string, password: string) => OpenCodeApiClient;
  readinessTimeoutMs?: number;
  healthRequestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export async function createOpenCodeServerClient(
  binding: OpenCodeAgentBindingConfig,
  options: OpenCodeServerClientOptions = {},
): Promise<OpenCodeServerClient> {
  const env = { ...process.env, ...(binding.env ?? {}) };
  const executable =
    binding.executablePathOverride ??
    (options.findExecutable ?? findExecutable)("opencode", env.PATH ?? process.env.PATH);
  if (!executable) {
    throw new Error(
      "OpenCode executable was not found in PATH; install OpenCode CLI or configure the Agent Binding with --runtime-path",
    );
  }
  const rawVersion = await (options.readVersion ?? readOpenCodeVersion)(executable, env);
  const version = parseOpenCodeVersion(rawVersion);
  if (!SUPPORTED_OPENCODE_VERSIONS.includes(version as (typeof SUPPORTED_OPENCODE_VERSIONS)[number])) {
    throw new Error(
      `OpenCode compatibility failure for executable version: Connect ${CONNECT_VERSION}, @opencode-ai/sdk ${OPENCODE_SDK_VERSION}, OpenCode ${version}; supported OpenCode versions: ${SUPPORTED_OPENCODE_VERSIONS.join(", ")}`,
    );
  }

  const port = await (options.allocatePort ?? allocateLoopbackPort)();
  const password = options.password?.() ?? randomBytes(32).toString("hex");
  const serverEnv = { ...env };
  for (const name of [
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_SERVER_USERNAME",
    "OPENCODE_SERVER_HOSTNAME",
    "OPENCODE_SERVER_PORT",
    "OPENCODE_SERVER_CORS",
    "OPENCODE_SERVER_MDNS",
  ])
    delete serverEnv[name];
  serverEnv.OPENCODE_SERVER_PASSWORD = password;
  const child = (options.spawnServer ?? spawnOpenCodeServer)(
    executable,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--mdns=false"],
    serverEnv,
  );
  const serverExit = new Promise<Error>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve(
        new Error(
          `OpenCode Server exited unexpectedly${code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : ""}`,
        ),
      );
    });
  });
  const stderr = collectStderr(child.stderr, [password]);
  const api = withCompatibilityDiagnostics(
    (options.createApi ?? createOfficialApi)(`http://127.0.0.1:${port}`, "opencode", password),
    version,
  );

  try {
    const health = await waitForHealth(
      api,
      child,
      stderr,
      options.readinessTimeoutMs ?? 10_000,
      options.healthRequestTimeoutMs ?? 1_000,
    );
    if (health.version !== version) {
      throw compatibilityError(
        "global.health version",
        version,
        new Error(`executable version ${version} does not match Server version ${health.version}`),
      );
    }
  } catch (error) {
    await stopServer(child, options.shutdownTimeoutMs);
    throw error;
  }

  let closed = false;
  return {
    ...api,
    version,
    events: async function* (signal, onConnected) {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", forwardAbort, { once: true });
      if (signal.aborted) forwardAbort();
      let exitFailure: Error | null = null;
      void serverExit.then((failure) => {
        if (signal.aborted) return;
        exitFailure = failure;
        controller.abort(failure);
      });
      try {
        yield* api.events(controller.signal, onConnected);
        if (exitFailure) throw exitFailure;
      } catch (error) {
        if (exitFailure) throw exitFailure;
        throw error;
      } finally {
        signal.removeEventListener("abort", forwardAbort);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await stopServer(child, options.shutdownTimeoutMs);
    },
  };
}

function withCompatibilityDiagnostics(api: OpenCodeApiClient, version: string): OpenCodeApiClient {
  const operation =
    <Arguments extends unknown[], Result>(capability: string, run: (...args: Arguments) => Promise<Result>) =>
    async (...args: Arguments): Promise<Result> => {
      try {
        return await run(...args);
      } catch (error) {
        throw compatibilityError(capability, version, error);
      }
    };
  return {
    health: operation("global.health", api.health.bind(api)),
    listAgents: operation("app.agents", api.listAgents.bind(api)),
    listCommands: operation("command.list", api.listCommands.bind(api)),
    listProviders: operation("provider.list", api.listProviders.bind(api)),
    listSessions: operation("session.list", api.listSessions.bind(api)),
    getSession: operation("session.get", api.getSession.bind(api)),
    createSession: operation("session.create", api.createSession.bind(api)),
    deleteSession: operation("session.delete", api.deleteSession.bind(api)),
    sessionStatus: operation("session.status", api.sessionStatus.bind(api)),
    messages: operation("session.messages", api.messages.bind(api)),
    promptAsync: operation("session.promptAsync", api.promptAsync.bind(api)),
    runCommand: operation("session.command", api.runCommand.bind(api)),
    abortSession: operation("session.abort", api.abortSession.bind(api)),
    events: async function* (signal, onConnected) {
      try {
        yield* api.events(signal, onConnected);
      } catch (error) {
        throw compatibilityError("global.event", version, error);
      }
    },
    replyPermission: operation("permission.reply", api.replyPermission.bind(api)),
    replyQuestion: operation("question.reply", api.replyQuestion.bind(api)),
    rejectQuestion: operation("question.reject", api.rejectQuestion.bind(api)),
  };
}

function compatibilityError(capability: string, version: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `OpenCode compatibility failure for ${capability}: Connect ${CONNECT_VERSION}, @opencode-ai/sdk ${OPENCODE_SDK_VERSION}, OpenCode ${version}; ${detail}`,
    { cause },
  );
}

function createOfficialApi(baseUrl: string, username: string, password: string): OpenCodeApiClient {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const client = createOpencodeClient({
    baseUrl,
    headers: { Authorization: authorization },
  });
  return {
    health: async () => unwrap(await client.global.health({ throwOnError: true })),
    listAgents: async (directory) => unwrap(await client.app.agents({ directory }, { throwOnError: true })),
    listCommands: async (directory) => unwrap(await client.command.list({ directory }, { throwOnError: true })),
    listProviders: async (directory) => unwrap(await client.provider.list({ directory }, { throwOnError: true })),
    listSessions: async (directory, rootsOnly = true) =>
      unwrap(
        await client.session.list({ ...(directory ? { directory } : {}), roots: rootsOnly }, { throwOnError: true }),
      ),
    getSession: async (sessionID, directory) =>
      unwrap(await client.session.get({ sessionID, directory }, { throwOnError: true })),
    createSession: async (directory, title) =>
      unwrap(await client.session.create({ directory, ...(title ? { title } : {}) }, { throwOnError: true })),
    deleteSession: async (sessionID, directory) =>
      unwrap(await client.session.delete({ sessionID, directory }, { throwOnError: true })),
    sessionStatus: async (directory) => unwrap(await client.session.status({ directory }, { throwOnError: true })),
    messages: async (sessionID, directory) =>
      unwrap(await client.session.messages({ sessionID, directory }, { throwOnError: true })),
    promptAsync: async (input) => {
      await client.session.promptAsync(input, { throwOnError: true });
    },
    runCommand: async (input) => {
      await client.session.command(input, { throwOnError: true });
    },
    abortSession: async (sessionID, directory) =>
      unwrap(await client.session.abort({ sessionID, directory }, { throwOnError: true })),
    events: async function* (signal, onConnected) {
      const subscription = await client.global.event({ signal });
      onConnected?.();
      yield* subscription.stream;
    },
    replyPermission: async (requestID, directory, reply) =>
      unwrap(await client.permission.reply({ requestID, directory, reply }, { throwOnError: true })),
    replyQuestion: async (requestID, directory, answers) =>
      unwrap(await client.question.reply({ requestID, directory, answers }, { throwOnError: true })),
    rejectQuestion: async (requestID, directory) =>
      unwrap(await client.question.reject({ requestID, directory }, { throwOnError: true })),
  };
}

function unwrap<T>(result: { data: T }): T {
  return result.data;
}

function findExecutable(name: string, path: string | undefined): string | null {
  return Bun.which(name, { PATH: path }) ?? null;
}

async function readOpenCodeVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(executable, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const [code, stdout, stderr] = await Promise.all([
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    readStreamText(child.stdout),
    readStreamText(child.stderr),
  ]);
  if (code !== 0) throw new Error(`Failed to read OpenCode version: ${stderr.trim() || `exit ${code}`}`);
  return stdout.trim();
}

async function readStreamText(stream: NodeJS.ReadableStream): Promise<string> {
  let value = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream) value += String(chunk);
  return value;
}

function parseOpenCodeVersion(raw: string): string {
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(raw.trim());
  if (!match?.[1]) throw new Error(`Failed to read OpenCode version: ${raw.trim() || "empty output"}`);
  return match[1];
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Failed to allocate an OpenCode Server port");
  return port;
}

function spawnOpenCodeServer(executable: string, args: string[], env: NodeJS.ProcessEnv): OpenCodeServerProcess {
  return spawn(executable, args, {
    cwd: tmpdir(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function collectStderr(stream: NodeJS.ReadableStream, secrets: string[]): () => string {
  let value = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => {
    value = `${value}${String(chunk)}`.slice(-16_384);
  });
  return () =>
    secrets.reduce((redacted, secret) => (secret ? redacted.replaceAll(secret, "[REDACTED]") : redacted), value).trim();
}

async function waitForHealth(
  api: OpenCodeApiClient,
  child: OpenCodeServerProcess,
  stderr: () => string,
  timeoutMs: number,
  requestTimeoutMs: number,
): Promise<{ healthy: true; version: string }> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode Server exited before readiness${stderr() ? `: ${stderr()}` : ""}`);
    }
    try {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      return await withOperationTimeout(
        api.health(),
        Math.min(requestTimeoutMs, remainingMs),
        "health check timed out",
      );
    } catch (error) {
      lastError = error;
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await Bun.sleep(Math.min(50, remainingMs));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "health check timed out");
  throw new Error(`OpenCode Server did not become ready: ${detail}${stderr() ? ` (${stderr()})` : ""}`);
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopServer(child: OpenCodeServerProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
