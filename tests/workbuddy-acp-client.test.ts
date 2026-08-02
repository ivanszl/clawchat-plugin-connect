import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { verifyWorkBuddyAiEndpoint, type WorkBuddyConnectedSocketIdentity } from "../src/runtime/workbuddy-acp-client";

const taskId = "00000000-0000-4000-8000-000000000001";
const workspace = "/private/tmp/workbuddy-acp-client";
const applicationPath = "/Applications/WorkBuddy AI.app";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("WorkBuddy private ACP client", () => {
  it("uses one established socket for content-length bootstrap and fragmented chunked SSE replay", async () => {
    const serverSockets = new Set<Socket>();
    let loadReceived = false;
    const rpcMethods: string[] = [];
    const endpoint = await serve((request, socket) => {
      serverSockets.add(socket);
      if (request.path.endsWith("/connect")) {
        return jsonResponse({ connectionId: "connection-secret", sessionToken: "session-secret" }, true);
      }
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id: number; method: string };
      rpcMethods.push(rpc.method);
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }], true);
      }
      loadReceived = true;
      return sseResponse(
        [
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({
            sessionUpdate: "user_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "remember " },
          }),
          update({
            sessionUpdate: "user_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "this" },
          }),
          update({
            sessionUpdate: "agent_message_chunk",
            messageId: "message-2",
            content: { type: "text", text: "remembered" },
          }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: { models: [] } },
        ],
        true,
      );
    });

    let observedSocket: WorkBuddyConnectedSocketIdentity | undefined;
    const verification = await verifyWorkBuddyAiEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async (identity) => {
        expect(loadReceived).toBeFalse();
        observedSocket = identity;
        return {
          pid: 120,
          parentPid: 110,
          executablePath: `${applicationPath}/Contents/MacOS/Electron`,
        };
      },
    );

    expect(observedSocket?.remotePort).toBe(Number(new URL(endpoint).port));
    expect(serverSockets.size).toBe(1);
    expect(rpcMethods).toEqual(["initialize", "session/load"]);
    expect(verification).toEqual({
      taskId,
      replayFingerprint: fingerprint(["message-1", "message-2"]),
      replayStarted: true,
      replayCompleted: true,
      activities: [
        {
          id: "message-1",
          position: "0.1",
          parentId: null,
          kind: "user",
          text: "remember this",
          state: "complete",
          source: "history",
        },
        {
          id: "message-2",
          position: "0.2",
          parentId: null,
          kind: "assistant",
          text: "remembered",
          state: "complete",
          source: "history",
        },
      ],
      connectionOwner: {
        pid: 120,
        parentPid: 110,
        executablePath: `${applicationPath}/Contents/MacOS/Electron`,
      },
    });
  });

  it("redacts connection credentials when the server rejects JSON-RPC", async () => {
    const endpoint = await serve((request) => {
      if (request.path.endsWith("/connect")) {
        return jsonResponse({ connectionId: "connection-secret", sessionToken: "session-secret" });
      }
      if (request.method === "DELETE") return emptyResponse();
      return sseResponse([
        {
          jsonrpc: "2.0",
          id: 1,
          error: { message: "connection-secret session-secret must not escape" },
        },
      ]);
    });

    const result = verifyWorkBuddyAiEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 1_000, async () => ({
      pid: 120,
      parentPid: 110,
      executablePath: `${applicationPath}/Contents/MacOS/Electron`,
    }));
    await expect(result).rejects.toThrow("ACP JSON-RPC request failed");
    await expect(result).rejects.not.toThrow(/connection-secret|session-secret/u);
  });

  it("rejects unbounded HTTP response framing", async () => {
    const endpoint = await serve(() => ({ raw: "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n{}" }));
    await expect(
      verifyWorkBuddyAiEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 1_000, async () => null),
    ).rejects.toThrow("omitted a bounded body framing header");
  });

  it("bounds a server that never completes a response", async () => {
    const endpoint = await serve(() => null);
    await expect(
      verifyWorkBuddyAiEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 30, async () => null),
    ).rejects.toThrow("ACP HTTP response timed out");
  });
});

interface FakeRequest {
  method: string;
  path: string;
  body: string;
}

type FakeResponse = { raw: string } | { body: string; contentType: string; chunked?: boolean; fragmented?: boolean };

async function serve(respond: (request: FakeRequest, socket: Socket) => FakeResponse | null): Promise<string> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        const parsed = parseRequest(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.consumedBytes);
        const response = respond(parsed.request, socket);
        if (response) writeResponse(socket, response);
      }
    });
  });
  server.on("close", () => {
    for (const socket of sockets) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}/api/v1/acp`;
}

function parseRequest(buffer: Buffer): { request: FakeRequest; consumedBytes: number } | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const lines = buffer.subarray(0, headerEnd).toString("utf8").split("\r\n");
  const [method = "", path = ""] = (lines.shift() ?? "").split(" ");
  const contentLengthLine = lines.find((line) => line.toLowerCase().startsWith("content-length:"));
  const contentLength = Number(contentLengthLine?.split(":", 2)[1]?.trim() ?? "0");
  const bodyOffset = headerEnd + 4;
  if (buffer.byteLength < bodyOffset + contentLength) return null;
  return {
    request: { method, path, body: buffer.subarray(bodyOffset, bodyOffset + contentLength).toString("utf8") },
    consumedBytes: bodyOffset + contentLength,
  };
}

function writeResponse(socket: Socket, response: FakeResponse): void {
  if ("raw" in response) {
    socket.write(response.raw);
    return;
  }
  const body = response.chunked ? chunk(response.body) : response.body;
  const framing = response.chunked
    ? "Transfer-Encoding: chunked"
    : `Content-Length: ${Buffer.byteLength(response.body)}`;
  const value = `HTTP/1.1 200 OK\r\nContent-Type: ${response.contentType}\r\n${framing}\r\nConnection: keep-alive\r\n\r\n${body}`;
  if (!response.fragmented) {
    socket.write(value);
    return;
  }
  const midpoint = Math.floor(value.length / 2);
  socket.write(value.slice(0, midpoint));
  setTimeout(() => socket.write(value.slice(midpoint)), 1);
}

function jsonResponse(value: unknown, fragmented = false): FakeResponse {
  return { body: JSON.stringify(value), contentType: "application/json", fragmented };
}

function sseResponse(values: unknown[], fragmented = false): FakeResponse {
  return {
    body: values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
    contentType: "text/event-stream",
    chunked: true,
    fragmented,
  };
}

function emptyResponse(): FakeResponse {
  return { body: "", contentType: "application/json" };
}

function chunk(value: string): string {
  return `${Buffer.byteLength(value).toString(16)}\r\n${value}\r\n0\r\n\r\n`;
}

function update(value: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: taskId, update: value } };
}

function fingerprint(messageIds: string[]): string {
  return createHash("sha256").update(JSON.stringify(messageIds)).digest("hex");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
