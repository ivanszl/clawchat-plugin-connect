import { connect, type Socket } from "node:net";
import {
  WorkBuddyDiscoveryError,
  type WorkBuddyEndpointVerification,
  type WorkBuddyProcessIdentity,
} from "./workbuddy-task-discovery";

const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;

export interface WorkBuddyConnectedSocketIdentity {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

export async function verifyWorkBuddyAiEndpoint(
  input: { endpoint: string; taskId: string; workspace: string; acpVersion: number },
  timeoutMs: number,
  readConnectedOwner: (identity: WorkBuddyConnectedSocketIdentity) => Promise<WorkBuddyProcessIdentity | null>,
): Promise<WorkBuddyEndpointVerification> {
  let connectionId = "";
  let sessionToken = "";
  const connection = await PersistentHttpConnection.open(input.endpoint, timeoutMs);
  try {
    const bootstrap = await connection.request("POST", `${connection.pathname}/connect`, {
      "x-codebuddy-request": "1",
    });
    if (bootstrap.statusCode < 200 || bootstrap.statusCode >= 300) {
      throw new Error(`ACP connect failed with HTTP ${bootstrap.statusCode}`);
    }
    const credentials = parseJson(bootstrap.body.toString("utf8"), "connect response") as {
      connectionId?: unknown;
      sessionToken?: unknown;
    };
    if (typeof credentials.connectionId !== "string" || !credentials.connectionId) {
      throw new Error("ACP connect response omitted its connection identifier");
    }
    connectionId = credentials.connectionId;
    sessionToken = typeof credentials.sessionToken === "string" ? credentials.sessionToken : "";

    // This is the exact established TCP socket reused by initialize and load, not a listener snapshot.
    const connectionOwner = await readConnectedOwner(connection.identity());
    const headers = acpHeaders(connectionId, sessionToken);
    const initialized = await postRpc(connection, headers, 1, "initialize", {
      protocolVersion: input.acpVersion,
      clientInfo: { name: "clawchat-connect-discovery", version: "1" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const initializedProtocol = (initialized.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (initializedProtocol !== input.acpVersion) {
      throw new Error("ACP initialize returned an incompatible protocol version");
    }
    const loaded = await postRpc(connection, headers, 2, "session/load", {
      sessionId: input.taskId,
      cwd: input.workspace,
      mcpServers: [],
    });
    const observedTaskId = loaded.taskIds.find((candidate) => candidate !== input.taskId) ?? loaded.taskIds[0];
    if (!observedTaskId) throw new Error("ACP replay emitted no Task identity");
    return {
      taskId: observedTaskId,
      replayFingerprint: replayFingerprint(loaded.messageIds),
      replayStarted: loaded.replayStarted,
      replayCompleted: loaded.replayCompleted,
      connectionOwner,
    };
  } catch (error) {
    if (error instanceof WorkBuddyDiscoveryError) throw error;
    throw new Error(redact(error instanceof Error ? error.message : String(error), [connectionId, sessionToken]));
  } finally {
    if (connectionId) {
      await connection
        .request("DELETE", connection.pathname, acpHeaders(connectionId, sessionToken))
        .catch(() => undefined);
    }
    connection.close();
  }
}

interface RpcObservation {
  result?: unknown;
  taskIds: string[];
  replayStarted: boolean;
  replayCompleted: boolean;
  replayActive: boolean;
  messageIds: string[];
}

async function postRpc(
  connection: PersistentHttpConnection,
  headers: Record<string, string>,
  id: number,
  method: string,
  params: unknown,
): Promise<RpcObservation> {
  const response = await connection.request(
    "POST",
    connection.pathname,
    headers,
    Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`ACP ${method} failed with HTTP ${response.statusCode}`);
  }
  const observation: RpcObservation = {
    taskIds: [],
    replayStarted: false,
    replayCompleted: false,
    replayActive: false,
    messageIds: [],
  };
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    consumeSse(response.body.toString("utf8"), (payload) => observeRpcPayload(payload, id, observation));
  } else {
    observeRpcPayload(parseJson(response.body.toString("utf8"), `${method} response`), id, observation);
  }
  if (observation.result === undefined) throw new Error(`ACP ${method} returned no JSON-RPC result`);
  return observation;
}

function consumeSse(value: string, onPayload: (payload: unknown) => void): void {
  for (const block of value.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onPayload(parseJson(data, "event stream payload"));
  }
}

function observeRpcPayload(payload: unknown, expectedId: number, observation: RpcObservation): void {
  if (typeof payload !== "object" || payload === null) return;
  const message = payload as Record<string, unknown>;
  if (message.id === expectedId && !("method" in message)) {
    if (message.error) throw new Error("ACP JSON-RPC request failed");
    observation.result = message.result ?? {};
    return;
  }
  if (message.method !== "session/update") return;
  const params = message.params as Record<string, unknown> | undefined;
  const taskId = params?.sessionId;
  if (typeof taskId === "string" && !observation.taskIds.includes(taskId)) observation.taskIds.push(taskId);
  const update = params?.update as Record<string, unknown> | undefined;
  const meta = update?._meta as Record<string, unknown> | undefined;
  if (meta?.["codebuddy.ai/historyReplay"] === "start") {
    observation.replayStarted = true;
    observation.replayActive = true;
  }
  if (observation.replayActive) {
    const messageId = update?.messageId;
    if (typeof messageId === "string" && !observation.messageIds.includes(messageId)) {
      observation.messageIds.push(messageId);
    }
  }
  if (meta?.["codebuddy.ai/historyReplay"] === "end") {
    observation.replayCompleted = true;
    observation.replayActive = false;
  }
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

interface HttpResponse {
  statusCode: number;
  headers: Map<string, string>;
  body: Buffer;
}

class PersistentHttpConnection {
  readonly pathname: string;
  private buffer = Buffer.alloc(0);
  private pending:
    | {
        resolve: (response: HttpResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly hostname: string,
    private readonly port: number,
    pathname: string,
    private readonly timeoutMs: number,
  ) {
    this.pathname = pathname;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.consumePendingResponse();
    });
    socket.on("error", (error) => this.rejectPending(error));
    socket.on("close", () => this.rejectPending(new Error("ACP HTTP connection closed unexpectedly")));
  }

  static async open(endpoint: string, timeoutMs: number): Promise<PersistentHttpConnection> {
    const url = new URL(endpoint);
    const port = Number(url.port);
    const hostname = url.hostname === "[::1]" ? "::1" : url.hostname;
    const socket = connect({ host: hostname, port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error("ACP HTTP connection timed out")), timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", reject);
    });
    return new PersistentHttpConnection(socket, hostname, port, url.pathname, timeoutMs);
  }

  identity(): WorkBuddyConnectedSocketIdentity {
    const { localAddress, localPort, remoteAddress, remotePort } = this.socket;
    if (!localAddress || !localPort || !remoteAddress || !remotePort) {
      throw new Error("ACP HTTP socket identity is unavailable");
    }
    return { localAddress, localPort, remoteAddress, remotePort };
  }

  async request(
    method: "POST" | "DELETE",
    pathname: string,
    headers: Record<string, string>,
    body = Buffer.alloc(0),
  ): Promise<HttpResponse> {
    if (this.pending) throw new Error("Concurrent ACP HTTP requests are not supported");
    const requestHeaders = {
      Host: `${this.hostname}:${this.port}`,
      Connection: "keep-alive",
      "Content-Length": String(body.byteLength),
      ...headers,
    };
    const head = `${method} ${pathname} HTTP/1.1\r\n${Object.entries(requestHeaders)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n")}\r\n\r\n`;
    const response = new Promise<HttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("ACP HTTP response timed out"));
        this.socket.destroy();
      }, this.timeoutMs);
      this.pending = { resolve, reject, timer };
    });
    this.socket.write(Buffer.concat([Buffer.from(head, "utf8"), body]));
    this.consumePendingResponse();
    return await response;
  }

  close(): void {
    this.socket.destroy();
  }

  private consumePendingResponse(): void {
    if (!this.pending) return;
    try {
      const parsed = parseHttpResponse(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.consumedBytes);
      const { resolve, timer } = this.pending;
      this.pending = undefined;
      clearTimeout(timer);
      resolve(parsed.response);
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      this.socket.destroy();
    }
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    this.pending = undefined;
    clearTimeout(timer);
    reject(error);
  }
}

function parseHttpResponse(buffer: Buffer): { response: HttpResponse; consumedBytes: number } | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerLines = buffer.subarray(0, headerEnd).toString("latin1").split("\r\n");
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/u.exec(headerLines.shift() ?? "");
  if (!statusMatch) throw new Error("ACP HTTP response had an invalid status line");
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("ACP HTTP response had an invalid header");
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const bodyOffset = headerEnd + 4;
  const contentLength = headers.get("content-length");
  let body: Buffer;
  let consumedBytes: number;
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HTTP_BODY_BYTES) {
      throw new Error("ACP HTTP response declared an invalid body length");
    }
    if (buffer.byteLength < bodyOffset + length) return null;
    body = buffer.subarray(bodyOffset, bodyOffset + length);
    consumedBytes = bodyOffset + length;
  } else if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    const chunked = parseChunkedBody(buffer, bodyOffset);
    if (!chunked) return null;
    body = chunked.body;
    consumedBytes = chunked.consumedBytes;
  } else {
    throw new Error("ACP HTTP response omitted a bounded body framing header");
  }
  return {
    response: { statusCode: Number(statusMatch[1]), headers, body: Buffer.from(body) },
    consumedBytes,
  };
}

function parseChunkedBody(buffer: Buffer, bodyOffset: number): { body: Buffer; consumedBytes: number } | null {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let offset = bodyOffset;
  while (true) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) return null;
    const sizeText = buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0] ?? "";
    if (!/^[0-9a-f]+$/iu.test(sizeText)) throw new Error("ACP HTTP response had an invalid chunk size");
    const size = Number.parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      if (buffer.byteLength < offset + 2) return null;
      if (buffer.subarray(offset, offset + 2).equals(Buffer.from("\r\n"))) {
        return { body: Buffer.concat(chunks), consumedBytes: offset + 2 };
      }
      const trailersEnd = buffer.indexOf("\r\n\r\n", offset);
      if (trailersEnd < 0) return null;
      return { body: Buffer.concat(chunks), consumedBytes: trailersEnd + 4 };
    }
    totalBytes += size;
    if (totalBytes > MAX_HTTP_BODY_BYTES) throw new Error("ACP HTTP response exceeded its body limit");
    if (buffer.byteLength < offset + size + 2) return null;
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
    if (!buffer.subarray(offset, offset + 2).equals(Buffer.from("\r\n"))) {
      throw new Error("ACP HTTP response had an invalid chunk boundary");
    }
    offset += 2;
  }
}

function replayFingerprint(messageIds: string[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(messageIds)).digest("hex");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`ACP ${label} was not valid JSON`);
  }
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => (secret ? result.replaceAll(secret, "[REDACTED]") : result), value);
}
