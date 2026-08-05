import { connect, type Socket } from "node:net";

const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;

export interface WorkBuddyConnectedSocketIdentity {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

export function acpHeaders(connectionId: string, sessionToken: string): Record<string, string> {
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

export class PersistentHttpConnection {
  readonly pathname: string;
  private closed = false;
  private pending:
    | {
        resolve: (response: HttpResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | undefined;
        parser: IncrementalHttpResponseParser;
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
      try {
        const pending = this.pending;
        if (!pending) return;
        this.refreshResponseTimeout();
        pending.parser.push(Buffer.from(chunk));
      } catch (error) {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });
    socket.on("error", (error) => this.rejectPending(error));
    socket.on("close", () => {
      this.closed = true;
      this.rejectPending(new Error("ACP HTTP connection closed unexpectedly"));
    });
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
    onBodyChunk?: (chunk: Buffer) => void,
  ): Promise<HttpResponse> {
    if (this.closed || this.socket.destroyed) throw new Error("ACP HTTP connection is closed");
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
      const parser = new IncrementalHttpResponseParser(onBodyChunk, (parsed) => {
        const pending = this.pending;
        if (!pending) return;
        this.pending = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(parsed);
      });
      this.pending = { resolve, reject, timer: undefined, parser };
      this.refreshResponseTimeout();
    });
    this.socket.write(Buffer.concat([Buffer.from(head, "utf8"), body]));
    return await response;
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    this.pending = undefined;
    if (timer) clearTimeout(timer);
    reject(error);
  }

  private refreshResponseTimeout(): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      pending.reject(new Error("ACP HTTP response timed out"));
      this.socket.destroy();
    }, this.timeoutMs);
  }
}

class IncrementalHttpResponseParser {
  private buffer = Buffer.alloc(0);
  private statusCode: number | null = null;
  private headers: Map<string, string> | null = null;
  private remainingContentLength: number | null = null;
  private chunkBytesRemaining: number | null = null;
  private awaitingChunkBoundary = false;
  private awaitingFinalChunkBoundary = false;
  private totalBytes = 0;
  private readonly body: Buffer[] = [];
  private completed = false;

  constructor(
    private readonly onBodyChunk: ((chunk: Buffer) => void) | undefined,
    private readonly onComplete: (response: HttpResponse) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.completed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.consume();
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private consume(): void {
    if (!this.headers && !this.consumeHeaders()) return;
    if (this.remainingContentLength !== null) {
      this.consumeContentLength();
      return;
    }
    this.consumeChunked();
  }

  private consumeHeaders(): boolean {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return false;
    const headerLines = this.buffer.subarray(0, headerEnd).toString("latin1").split("\r\n");
    const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/u.exec(headerLines.shift() ?? "");
    if (!statusMatch) throw new Error("ACP HTTP response had an invalid status line");
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("ACP HTTP response had an invalid header");
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const contentLength = headers.get("content-length");
    if (contentLength !== undefined) {
      const length = Number(contentLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HTTP_BODY_BYTES) {
        throw new Error("ACP HTTP response declared an invalid body length");
      }
      this.remainingContentLength = length;
    } else if (!headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
      throw new Error("ACP HTTP response omitted a bounded body framing header");
    }
    this.statusCode = Number(statusMatch[1]);
    this.headers = headers;
    this.buffer = this.buffer.subarray(headerEnd + 4);
    if (this.remainingContentLength === 0) this.finish();
    return true;
  }

  private consumeContentLength(): void {
    if (this.remainingContentLength === null || this.completed) return;
    const length = Math.min(this.buffer.byteLength, this.remainingContentLength);
    if (length > 0) this.emit(this.take(length));
    this.remainingContentLength -= length;
    if (this.remainingContentLength === 0) this.finish();
  }

  private consumeChunked(): void {
    while (!this.completed) {
      if (this.awaitingFinalChunkBoundary) {
        if (this.buffer.byteLength < 2) return;
        if (this.buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
          this.buffer = this.buffer.subarray(2);
          this.finish();
          return;
        }
        const trailersEnd = this.buffer.indexOf("\r\n\r\n");
        if (trailersEnd < 0) return;
        this.buffer = this.buffer.subarray(trailersEnd + 4);
        this.finish();
        return;
      }
      if (this.awaitingChunkBoundary) {
        if (this.buffer.byteLength < 2) return;
        if (!this.buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
          throw new Error("ACP HTTP response had an invalid chunk boundary");
        }
        this.buffer = this.buffer.subarray(2);
        this.awaitingChunkBoundary = false;
        this.chunkBytesRemaining = null;
      }
      if (this.chunkBytesRemaining === null) {
        const lineEnd = this.buffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const sizeText = this.buffer.subarray(0, lineEnd).toString("ascii").split(";", 1)[0] ?? "";
        if (!/^[0-9a-f]+$/iu.test(sizeText)) throw new Error("ACP HTTP response had an invalid chunk size");
        const size = Number.parseInt(sizeText, 16);
        this.buffer = this.buffer.subarray(lineEnd + 2);
        if (size === 0) {
          this.awaitingFinalChunkBoundary = true;
          continue;
        }
        this.chunkBytesRemaining = size;
      }
      const length = Math.min(this.buffer.byteLength, this.chunkBytesRemaining);
      if (length === 0) return;
      this.emit(this.take(length));
      this.chunkBytesRemaining -= length;
      if (this.chunkBytesRemaining === 0) this.awaitingChunkBoundary = true;
    }
  }

  private take(length: number): Buffer {
    const value = Buffer.from(this.buffer.subarray(0, length));
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  private emit(value: Buffer): void {
    this.totalBytes += value.byteLength;
    if (this.totalBytes > MAX_HTTP_BODY_BYTES) throw new Error("ACP HTTP response exceeded its body limit");
    this.body.push(value);
    this.onBodyChunk?.(value);
  }

  private finish(): void {
    if (this.completed || this.statusCode === null || !this.headers) return;
    this.completed = true;
    this.onComplete({ statusCode: this.statusCode, headers: this.headers, body: Buffer.concat(this.body) });
  }
}

export function replayFingerprint(messageIds: string[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(messageIds)).digest("hex");
}

export function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`ACP ${label} was not valid JSON`);
  }
}

export function redact(value: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => (secret ? result.replaceAll(secret, "[REDACTED]") : result), value);
}
