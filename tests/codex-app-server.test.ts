import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CodexRuntimeAdapterBinding } from "../src/runtime/codex-adapter";
import {
  type CodexAppServerNotification,
  type CodexAppServerProcess,
  createCodexAppServerClient,
} from "../src/runtime/codex-app-server";
import { pluginBinding } from "./runtime-adapter-fixture";

function codexBinding(overrides: Partial<CodexRuntimeAdapterBinding>): CodexRuntimeAdapterBinding {
  return { ...pluginBinding(), ...overrides } as CodexRuntimeAdapterBinding;
}

const CODEX_VERSION_FIXTURE = "codex-cli 0.145.0";

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

  exit(code: number | null, signal: NodeJS.Signals | null = null, bufferedStdout = ""): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit("exit", code, signal);
    this.stdout.end(bufferedStdout);
    this.stderr.end();
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
      if (message.method === "initialize") respond(process, message.id, { userAgent: CODEX_VERSION_FIXTURE });
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
  it("accepts any Codex CLI version that initializes app-server", async () => {
    const process = new FakeProcess();
    startFakeServer(process, []);
    const spawnAppServer = mock(() => process);
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => "codex-cli 99.0.0",
      spawnAppServer,
    });

    await expect(client.listThreads({ cwd: "/repo" })).resolves.toEqual({ data: [], nextCursor: null });
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("rejects an executable that returns no version output", async () => {
    const spawnAppServer = mock(() => new FakeProcess());
    await expect(
      createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
        readVersion: async () => "",
        spawnAppServer,
      }),
    ).rejects.toThrow("Failed to read Codex version: empty output");
    expect(spawnAppServer).not.toHaveBeenCalled();
  });

  it("initializes once and speaks newline-delimited JSON-RPC without a jsonrpc field", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
    });

    await expect(client.listThreads({ cwd: "/repo" })).resolves.toEqual({ data: [], nextCursor: null });
    expect(received[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "clawchat_connect", title: "ClawChat Connect", version: "0.1.0-beta.9" },
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
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
    });
    const onDelivered = mock(async () => undefined);
    client.onRequest(async (request) => ({
      handled: request.method === "item/commandExecution/requestApproval",
      result: { decision: "cancel" },
      onDelivered,
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
    expect(onDelivered).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("serializes RPC requests on the shared app-server transport", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        received.push(message);
        if (message.method === "initialize") respond(process, message.id, { userAgent: CODEX_VERSION_FIXTURE });
      }
    });
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
    });

    const first = client.listThreads({});
    const second = client.resumeThread({
      threadId: "thread-1",
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    await Bun.sleep(0);
    expect(received.slice(2).map((message) => message.method)).toEqual(["thread/list"]);

    respond(process, received[2]?.id, { data: [], nextCursor: null });
    await first;
    await Bun.sleep(0);
    expect(received.slice(2).map((message) => message.method)).toEqual(["thread/list", "thread/resume"]);
    respond(process, received[3]?.id, {
      thread: { id: "thread-1", preview: "", name: null, createdAt: 1, updatedAt: 1, recencyAt: 1, cwd: "/repo" },
    });
    await second;
    await client.close();
  });

  it("releases the shared RPC queue when an app-server request stops responding", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
      requestTimeoutMs: 10,
    });

    const stalled = client.startThread({
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const following = client.listThreads({});
    await expect(stalled).rejects.toThrow("thread/start timed out after 10ms");
    await expect(following).resolves.toEqual({ data: [], nextCursor: null });
    expect(received.slice(2).map((message) => message.method)).toEqual(["thread/start", "thread/list"]);
    await client.close();
  });

  it("bounds stdin backpressure within the app-server request timeout", async () => {
    const process = new FakeProcess();
    startFakeServer(process, []);
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
      requestTimeoutMs: 10,
    });
    const write = process.stdin.write.bind(process.stdin);
    process.stdin.write = (() => false) as typeof process.stdin.write;

    const request = client.listThreads({});
    try {
      const outcome = await Promise.race([
        request.then(
          () => "resolved",
          (error) => (error instanceof Error ? error.message : String(error)),
        ),
        Bun.sleep(50).then(() => "still pending"),
      ]);
      expect(outcome).toBe("Codex app-server thread/list timed out after 10ms");
    } finally {
      process.stdin.write = write;
      process.stdin.emit("drain");
      await request.catch(() => undefined);
      await client.close();
    }
  });

  it("archives, restores, and deletes threads through the v2 methods", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
    });

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

  it("reports buffered protocol errors before the child exit status", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
    });
    const pending = client.startThread({
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (received.some(({ method }) => method === "thread/start")) break;
      await Bun.sleep(1);
    }

    process.exit(0, null, "not-json\n");
    await expect(pending).rejects.toThrow("Invalid JSON from Codex app-server");
  });
  it("rejects pending calls and publishes an exit notification when the child dies", async () => {
    const process = new FakeProcess();
    const received: Array<Record<string, unknown>> = [];
    startFakeServer(process, received);
    const client = await createCodexAppServerClient(codexBinding({ codexPathOverride: "/opt/codex" }), {
      readVersion: async () => CODEX_VERSION_FIXTURE,
      spawnAppServer: () => process,
    });
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
