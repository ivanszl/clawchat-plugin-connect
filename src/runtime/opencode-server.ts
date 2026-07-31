import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  Agent,
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

export interface OpenCodeApiClient {
  health(): Promise<{ healthy: true; version: string }>;
  listAgents(directory: string): Promise<Agent[]>;
  listProviders(directory: string): Promise<{ all: Provider[]; connected: string[]; default: Record<string, string> }>;
  listSessions(directory?: string): Promise<Session[]>;
  getSession(sessionID: string, directory: string): Promise<Session>;
  createSession(directory: string, title?: string): Promise<Session>;
  deleteSession(sessionID: string, directory: string): Promise<boolean>;
  sessionStatus(directory: string): Promise<Record<string, SessionStatus>>;
  messages(sessionID: string, directory: string): Promise<OpenCodeMessage[]>;
  promptAsync(input: OpenCodePromptInput): Promise<void>;
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
      `Unsupported OpenCode version ${version}; Connect supports ${SUPPORTED_OPENCODE_VERSIONS.join(", ")} with @opencode-ai/sdk ${OPENCODE_SDK_VERSION}`,
    );
  }

  const port = await (options.allocatePort ?? allocateLoopbackPort)();
  const password = options.password?.() ?? randomBytes(32).toString("base64url");
  const serverEnv = { ...env, OPENCODE_SERVER_PASSWORD: password };
  const child = (options.spawnServer ?? spawnOpenCodeServer)(
    executable,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--mdns=false"],
    serverEnv,
  );
  const stderr = collectStderr(child.stderr, [password]);
  const api = (options.createApi ?? createOfficialApi)(`http://127.0.0.1:${port}`, "opencode", password);

  try {
    const health = await waitForHealth(api, child, stderr, options.readinessTimeoutMs ?? 10_000);
    if (health.version !== version) {
      throw new Error(`OpenCode compatibility handshake failed: executable ${version}, Server ${health.version}`);
    }
  } catch (error) {
    await stopServer(child);
    throw error;
  }

  let closed = false;
  return {
    ...api,
    version,
    async close() {
      if (closed) return;
      closed = true;
      await stopServer(child);
    },
  };
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
    listProviders: async (directory) => unwrap(await client.provider.list({ directory }, { throwOnError: true })),
    listSessions: async (directory) =>
      unwrap(await client.session.list({ ...(directory ? { directory } : {}), roots: true }, { throwOnError: true })),
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
): Promise<{ healthy: true; version: string }> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode Server exited before readiness${stderr() ? `: ${stderr()}` : ""}`);
    }
    try {
      return await api.health();
    } catch (error) {
      lastError = error;
      await Bun.sleep(50);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "health check timed out");
  throw new Error(`OpenCode Server did not become ready: ${detail}${stderr() ? ` (${stderr()})` : ""}`);
}

async function stopServer(child: OpenCodeServerProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
