import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { CodexAgentBindingConfig } from "../types";

export const SUPPORTED_CODEX_VERSION = "codex-cli 0.145.0" as const;

type RpcId = number | string;
type JsonObject = Record<string, unknown>;

export interface CodexAppServerThread {
  id: string;
  sessionId?: string;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  source?: unknown;
  preview: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  cwd: string;
  turns?: Array<{ id: string; status: CodexAppServerTurn["status"]; items: CodexAppServerThreadItem[] }>;
}

export interface CodexAppServerTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
}

export interface CodexAppServerThreadItem extends JsonObject {
  type: string;
  id: string;
}

export interface CodexAppServerNotification {
  method: string;
  params: JsonObject;
}

export interface CodexAppServerRequest {
  id: RpcId;
  method: string;
  params: JsonObject;
}

export type CodexAppServerRequestResult = { handled: true; result: unknown } | { handled: false };

export type CodexAppServerRequestHandler = (
  request: CodexAppServerRequest,
) => Promise<CodexAppServerRequestResult> | CodexAppServerRequestResult;

export interface CodexThreadStartParams extends JsonObject {
  model?: string;
  cwd: string;
  approvalPolicy: "never" | "on-request" | "untrusted";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  config?: JsonObject;
}

export interface CodexThreadResumeParams extends CodexThreadStartParams {
  threadId: string;
}

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export interface CodexTurnStartParams extends JsonObject {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: [] }>;
  cwd: string;
  approvalPolicy: "never" | "on-request" | "untrusted";
  sandboxPolicy: CodexSandboxPolicy;
  model?: string;
  effort?: string;
}

export interface CodexAppServerClient {
  listThreads(params: {
    cursor?: string | null;
    limit?: number;
    sortKey?: "created_at" | "updated_at";
    sortDirection?: "asc" | "desc";
    sourceKinds?: string[];
    archived?: boolean;
    cwd?: string | string[];
  }): Promise<{ data: CodexAppServerThread[]; nextCursor: string | null }>;
  startThread(params: CodexThreadStartParams): Promise<{ thread: CodexAppServerThread }>;
  resumeThread(params: CodexThreadResumeParams): Promise<{ thread: CodexAppServerThread }>;
  readThread(params: { threadId: string; includeTurns: true }): Promise<{ thread: CodexAppServerThread }>;
  archiveThread(params: { threadId: string }): Promise<void>;
  unarchiveThread(params: { threadId: string }): Promise<{ thread: CodexAppServerThread }>;
  deleteThread(params: { threadId: string }): Promise<void>;
  startTurn(params: CodexTurnStartParams): Promise<{ turn: CodexAppServerTurn }>;
  interruptTurn(params: { threadId: string; turnId: string }): Promise<void>;
  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void;
  onRequest(handler: CodexAppServerRequestHandler): () => void;
  close(): Promise<void>;
}

export interface CodexAppServerProcess {
  stdin: ChildProcessWithoutNullStreams["stdin"];
  stdout: ChildProcessWithoutNullStreams["stdout"];
  stderr: ChildProcessWithoutNullStreams["stderr"];
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface CreateCodexAppServerClientOptions {
  readVersion?: (executable: string, env: NodeJS.ProcessEnv | undefined) => Promise<string>;
  spawnAppServer?: (executable: string, env: NodeJS.ProcessEnv | undefined) => CodexAppServerProcess;
}

export async function createCodexAppServerClient(
  binding: CodexAgentBindingConfig,
  options: CreateCodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  const env = binding.env ? { ...process.env, ...binding.env } : undefined;
  const executable = binding.codexPathOverride ?? Bun.which("codex", { PATH: env?.PATH ?? process.env.PATH });
  if (!executable) {
    throw new Error(
      "Codex executable was not found in PATH; install codex-cli 0.145.0 or configure the Agent Binding with --codex-path",
    );
  }
  const version = await (options.readVersion ?? readCodexVersion)(executable, env);
  if (version !== SUPPORTED_CODEX_VERSION) {
    throw new Error(
      `Unsupported Codex version: expected ${SUPPORTED_CODEX_VERSION}, received ${version || "no version"}`,
    );
  }
  const child = (options.spawnAppServer ?? spawnCodexAppServer)(executable, env);
  const client = new StdioCodexAppServerClient(child);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function readCodexVersion(executable: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  const child = spawn(executable, ["--version"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${String(code)}`;
    throw new Error(`Failed to read Codex version: ${detail}`);
  }
  return stdout.trim();
}

function spawnCodexAppServer(executable: string, env: NodeJS.ProcessEnv | undefined): CodexAppServerProcess {
  return spawn(executable, ["app-server", "--stdio"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

class StdioCodexAppServerClient implements CodexAppServerClient {
  private nextRequestId = 1;
  private readonly pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private readonly notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly requestHandlers = new Set<CodexAppServerRequestHandler>();
  private readonly lines: ReadlineInterface;
  private readonly exited: Promise<void>;
  private stderrTail = "";
  private closed = false;

  constructor(private readonly child: CodexAppServerProcess) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.lines.on("line", (line) => {
      void this.handleLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_192);
    });
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const suffix = this.stderrTail.trim();
        const reason = this.closed
          ? new Error("Codex app-server closed")
          : new Error(
              `Codex app-server exited (${code === null ? signal : `code ${code}`})${suffix ? `: ${suffix}` : ""}`,
            );
        this.rejectPending(reason);
        if (!this.closed) {
          for (const listener of this.notificationListeners) {
            listener({ method: "$transport/exited", params: { message: reason.message } });
          }
        }
        resolve();
      });
      child.once("error", (error) => {
        this.rejectPending(new Error(`Codex app-server process error: ${error.message}`, { cause: error }));
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "clawchat_connect",
        title: "ClawChat Connect",
        version: "0.1.0-alpha.3",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    await this.write({ method: "initialized" });
  }

  async listThreads(params: {
    cursor?: string | null;
    limit?: number;
    sortKey?: "created_at" | "updated_at";
    sortDirection?: "asc" | "desc";
    sourceKinds?: string[];
    archived?: boolean;
    cwd?: string | string[];
  }): Promise<{ data: CodexAppServerThread[]; nextCursor: string | null }> {
    return await this.request("thread/list", params);
  }

  async startThread(params: CodexThreadStartParams): Promise<{ thread: CodexAppServerThread }> {
    return await this.request("thread/start", params);
  }

  async resumeThread(params: CodexThreadResumeParams): Promise<{ thread: CodexAppServerThread }> {
    return await this.request("thread/resume", params);
  }

  async readThread(params: { threadId: string; includeTurns: true }): Promise<{ thread: CodexAppServerThread }> {
    return await this.request("thread/read", params);
  }

  async archiveThread(params: { threadId: string }): Promise<void> {
    await this.request("thread/archive", params);
  }

  async unarchiveThread(params: { threadId: string }): Promise<{ thread: CodexAppServerThread }> {
    return await this.request("thread/unarchive", params);
  }

  async deleteThread(params: { threadId: string }): Promise<void> {
    await this.request("thread/delete", params);
  }

  async startTurn(params: CodexTurnStartParams): Promise<{ turn: CodexAppServerTurn }> {
    return await this.request("turn/start", params);
  }

  async interruptTurn(params: { threadId: string; turnId: string }): Promise<void> {
    await this.request("turn/interrupt", params);
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(handler: CodexAppServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.rejectPending(new Error("Codex app-server closed"));
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    const stopped = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!stopped && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    }
  }

  private async request<TResult>(method: string, params: unknown): Promise<TResult> {
    if (this.closed) throw new Error("Codex app-server is closed");
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      await this.write({ id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return (await response) as TResult;
  }

  private async write(message: JsonObject): Promise<void> {
    if (this.closed) throw new Error("Codex app-server is closed");
    const writable = this.child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!writable) await once(this.child.stdin, "drain");
  }

  private async handleLine(line: string): Promise<void> {
    let message: JsonObject;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) throw new Error("message must be an object");
      message = parsed;
    } catch (error) {
      this.failProtocol(
        `Invalid JSON from Codex app-server: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      ("result" in message || "error" in message)
    ) {
      this.handleResponse(message.id, message);
      return;
    }
    if (typeof message.method !== "string") {
      this.failProtocol("Codex app-server emitted a message without a method or response id");
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (typeof message.id === "number" || typeof message.id === "string") {
      await this.handleServerRequest({ id: message.id, method: message.method, params });
      return;
    }
    for (const listener of this.notificationListeners) listener({ method: message.method, params });
  }

  private handleResponse(id: RpcId, message: JsonObject): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = isRecord(message.error) ? message.error : null;
    if (error) {
      pending.reject(
        new CodexAppServerRpcError(
          typeof error.message === "string" ? error.message : "Codex app-server request failed",
          typeof error.code === "number" ? error.code : -32_000,
          error.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(request: CodexAppServerRequest): Promise<void> {
    try {
      for (const handler of this.requestHandlers) {
        const handled = await handler(request);
        if (handled.handled) {
          await this.write({ id: request.id, result: handled.result });
          return;
        }
      }
      await this.write({
        id: request.id,
        error: { code: -32_601, message: `Unsupported Codex app-server request: ${request.method}` },
      });
    } catch (error) {
      await this.write({
        id: request.id,
        error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private failProtocol(message: string): void {
    const error = new Error(message);
    this.rejectPending(error);
    if (!this.closed) this.child.kill("SIGTERM");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
