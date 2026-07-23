import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  type CodexAppServerNotification,
  type CodexAppServerProcess,
  createCodexAppServerClient,
  SUPPORTED_CODEX_VERSION,
} from "../src/runtime/codex-app-server";

class FakeProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;

  constructor() {
    super();
    this.stdin.on("finish", () => this.exit(0));
  }

  kill(): boolean {
    this.exit(null, "SIGTERM");
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit("exit", code, signal);
  }
}

function startFakeServer(process: FakeProcess, received: Array<Record<string, unknown>>): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      if (message.method === "initialize") respond(process, message.id, { userAgent: SUPPORTED_CODEX_VERSION });
      if (message.method === "thread/list") respond(process, message.id, { data: [], nextCursor: null });
      if (message.method === "thread/archive" || message.method === "thread/delete") respond(process, message.id, {});
      if (message.method === "thread/unarchive") {
        respond(process, message.id, {
          thread: {
            id: "thread-1",
            preview: "Restored",
            name: null,
            createdAt: 1,
            updatedAt: 2,
            recencyAt: 2,
            cwd: "/repo",
          },
        });
      }
    }
  });
}

function respond(process: FakeProcess, id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

describe("Codex app-server stdio client", () => {
  it("rejects any Codex executable version other than the pinned version", async () => {
    const spawnAppServer = mock(() => new FakeProcess());

    await expect(
      createCodexAppServerClient(
        { kind: "codex", codexPathOverride: "/opt/codex" },
        { readVersion: async () => "codex-cli 0.144.5", spawnAppServer },
      ),
    ).rejects.toThrow(`expected ${SUPPORTED_CODEX_VERSION}, received codex-cli 0.144.5`);
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it("initializes once and speaks newline-delimited JSON-RPC without a jsonrpc field", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(
      { kind: "codex", codexPathOverride: "/opt/codex" },
      {
        readVersion: async () => SUPPORTED_CODEX_VERSION,
        spawnAppServer: () => process,
      },
    );

    await expect(client.listThreads({ cwd: "/repo" })).resolves.toEqual({ data: [], nextCursor: null });
    expect(received[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "clawchat_connect", title: "ClawChat Connect", version: "0.1.0-alpha.6" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
    expect(received[1]).toEqual({ method: "initialized" });
    expect(received[2]).toEqual({ id: 2, method: "thread/list", params: { cwd: "/repo" } });
    expect(received.every((message) => !("jsonrpc" in message))).toBe(true);
    await client.close();
  });

  it("answers server-initiated requests through the registered handler", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(
      { kind: "codex", codexPathOverride: "/opt/codex" },
      { readVersion: async () => SUPPORTED_CODEX_VERSION, spawnAppServer: () => process },
    );
    client.onRequest(async (request) => ({
      handled: request.method === "item/commandExecution/requestApproval",
      result: { decision: "cancel" },
    }));

    process.stdout.write(
      `${JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1" },
      })}\n`,
    );
    await Bun.sleep(0);
    expect(received.at(-1)).toEqual({ id: "approval-1", result: { decision: "cancel" } });
    await client.close();
  });

  it("archives, restores, and deletes threads through the v2 methods", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(
      { kind: "codex", codexPathOverride: "/opt/codex" },
      { readVersion: async () => SUPPORTED_CODEX_VERSION, spawnAppServer: () => process },
    );

    await expect(client.archiveThread({ threadId: "thread-1" })).resolves.toBeUndefined();
    await expect(client.unarchiveThread({ threadId: "thread-1" })).resolves.toMatchObject({
      thread: { id: "thread-1" },
    });
    await expect(client.deleteThread({ threadId: "thread-1" })).resolves.toBeUndefined();
    expect(received.slice(-3)).toEqual([
      { id: 2, method: "thread/archive", params: { threadId: "thread-1" } },
      { id: 3, method: "thread/unarchive", params: { threadId: "thread-1" } },
      { id: 4, method: "thread/delete", params: { threadId: "thread-1" } },
    ]);
    await client.close();
  });

  it("rejects pending calls and publishes an exit notification when the child dies", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(
      { kind: "codex", codexPathOverride: "/opt/codex" },
      { readVersion: async () => SUPPORTED_CODEX_VERSION, spawnAppServer: () => process },
    );
    const notifications: CodexAppServerNotification[] = [];
    client.onNotification((notification) => notifications.push(notification));
    const pending = client.startThread({
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });

    process.stderr.write("boom");
    process.exit(1);
    await expect(pending).rejects.toThrow("Codex app-server exited (code 1): boom");
    expect(notifications).toEqual([
      { method: "$transport/exited", params: { message: "Codex app-server exited (code 1): boom" } },
    ]);
  });
});
