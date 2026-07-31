import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import type { Agent, GlobalEvent, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { createOpenCodeRuntimeAdapter } from "../src/runtime/opencode-adapter";
import {
  createOpenCodeServerClient,
  type OpenCodeApiClient,
  type OpenCodeMessage,
  type OpenCodeServerProcess,
} from "../src/runtime/opencode-server";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { CONNECT_VERSION } from "../src/version";

class FakeProcess extends EventEmitter implements OpenCodeServerProcess {
  readonly stderr = new PassThrough();
  exitCode: number | null = null;

  kill(): boolean {
    if (this.exitCode === null) {
      this.exitCode = 0;
      this.emit("exit", 0, null);
    }
    return true;
  }
}

class StubbornProcess extends EventEmitter implements OpenCodeServerProcess {
  readonly stderr = new PassThrough();
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  exitCode: number | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      this.exitCode = 137;
      this.emit("exit", 137, "SIGKILL");
    }
    return true;
  }
}

class AuthenticatedHttpProcess extends EventEmitter implements OpenCodeServerProcess {
  readonly stderr = new PassThrough();
  readonly requests: Array<{ authorization: string | null; path: string }> = [];
  readonly port: number;
  readonly password: string;
  exitCode: number | null = null;
  private readonly streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly server: Bun.Server<undefined>;

  constructor(port: number, password: string) {
    super();
    this.port = port;
    this.password = password;
    const expectedAuthorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) => {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization");
        this.requests.push({ authorization, path: url.pathname });
        if (authorization !== expectedAuthorization) return new Response("Unauthorized", { status: 401 });
        if (url.pathname === "/global/health") {
          return Response.json({ healthy: true, version: "1.18.10" });
        }
        if (url.pathname === "/global/event") {
          const streams = this.streams;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streams.add(controller);
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
            cancel() {
              streams.clear();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
  }

  crash(): void {
    if (this.exitCode !== null) return;
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.server.stop(true);
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }

  kill(): boolean {
    if (this.exitCode !== null) return true;
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.server.stop(true);
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
}

interface OpenCodeCompatibilityFixture {
  version: string;
  directory: string;
  health: { healthy: true; version: string };
  agents: Agent[];
  providers: { all: Provider[]; connected: string[]; default: Record<string, string> };
  session: Session;
  messages: OpenCodeMessage[];
  events: GlobalEvent[];
}

class CompatibilityHttpProcess extends EventEmitter implements OpenCodeServerProcess {
  readonly stderr = new PassThrough();
  readonly requests: Array<{ method: string; path: string }> = [];
  exitCode: number | null = null;
  private readonly server: Bun.Server<undefined>;

  constructor(
    port: number,
    password: string,
    private readonly fixture: OpenCodeCompatibilityFixture,
  ) {
    super();
    const expectedAuthorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) => {
        const url = new URL(request.url);
        this.requests.push({ method: request.method, path: url.pathname });
        if (request.headers.get("authorization") !== expectedAuthorization)
          return new Response("Unauthorized", { status: 401 });
        if (url.pathname === "/global/health") return Response.json(this.fixture.health);
        if (url.pathname === "/agent") return Response.json(this.fixture.agents);
        if (url.pathname === "/provider") return Response.json(this.fixture.providers);
        if (url.pathname === "/session" && request.method === "GET") return Response.json([this.fixture.session]);
        if (url.pathname === "/session" && request.method === "POST") return Response.json(this.fixture.session);
        if (url.pathname === `/session/${this.fixture.session.id}` && request.method === "GET")
          return Response.json(this.fixture.session);
        if (url.pathname === `/session/${this.fixture.session.id}` && request.method === "DELETE")
          return Response.json(true);
        if (url.pathname === "/session/status") return Response.json({});
        if (url.pathname === `/session/${this.fixture.session.id}/message`) return Response.json(this.fixture.messages);
        if (url.pathname === `/session/${this.fixture.session.id}/prompt_async`)
          return new Response(null, { status: 204 });
        if (url.pathname === `/session/${this.fixture.session.id}/abort`) return Response.json(true);
        if (url.pathname === "/permission/permission_compatibility/reply") return Response.json(true);
        if (url.pathname === "/question/question_compatibility/reply") return Response.json(true);
        if (url.pathname === "/question/question_compatibility/reject") return Response.json(true);
        if (url.pathname === "/global/event") {
          const encoded = new TextEncoder().encode(
            this.fixture.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          );
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoded);
                controller.close();
              },
            }),
            { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });
  }

  kill(): boolean {
    if (this.exitCode !== null) return true;
    this.server.stop(true);
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
}

function api(version = "1.18.10"): OpenCodeApiClient {
  return {
    health: async () => ({ healthy: true, version }),
    listAgents: async () => [],
    listProviders: async () => ({ all: [], connected: [], default: {} }),
    listSessions: async () => [],
    getSession: async () => {
      throw new Error("not found");
    },
    createSession: async () => {
      throw new Error("not implemented");
    },
    deleteSession: async () => false,
    sessionStatus: async () => ({}),
    messages: async () => [],
    promptAsync: async () => undefined,
    abortSession: async () => false,
    events: async function* (_signal, onConnected) {
      onConnected?.();
      yield* [] as GlobalEvent[];
    },
    replyPermission: async () => false,
    replyQuestion: async () => false,
    rejectQuestion: async () => false,
  };
}

describe("OpenCode Server process boundary", () => {
  it("accepts the generated OpenCode 1.18.10 SDK compatibility fixture through the official client", async () => {
    const fixture = (await Bun.file(
      new URL("./fixtures/opencode/1.18.10/compatibility.json", import.meta.url),
    ).json()) as OpenCodeCompatibilityFixture;
    const [port] = await availablePorts(1);
    if (!port) throw new Error("missing compatibility fixture port");
    let compatibilityProcess!: CompatibilityHttpProcess;
    const client = await createOpenCodeServerClient(
      { kind: "opencode", executablePathOverride: "/opt/opencode" },
      {
        readVersion: async () => fixture.version,
        allocatePort: async () => port,
        password: () => "fixture-secret",
        spawnServer: (_executable, _args, env) => {
          compatibilityProcess = new CompatibilityHttpProcess(port, env.OPENCODE_SERVER_PASSWORD ?? "", fixture);
          return compatibilityProcess;
        },
      },
    );

    expect(await client.listAgents(fixture.directory)).toEqual(fixture.agents);
    expect(await client.listProviders(fixture.directory)).toEqual(fixture.providers);
    expect(await client.listSessions(fixture.directory)).toEqual([fixture.session]);
    expect(await client.getSession(fixture.session.id, fixture.directory)).toEqual(fixture.session);
    expect(await client.createSession(fixture.directory, fixture.session.title)).toEqual(fixture.session);
    expect(await client.messages(fixture.session.id, fixture.directory)).toEqual(fixture.messages);
    await expect(
      client.promptAsync({
        sessionID: fixture.session.id,
        directory: fixture.directory,
        messageID: "msg_prompt",
        agent: "build",
        model: { providerID: "fixture", modelID: "fixture-model" },
        variant: "high",
        parts: [{ type: "text", text: "fixture" }],
      }),
    ).resolves.toBeUndefined();
    expect(await client.abortSession(fixture.session.id, fixture.directory)).toBe(true);
    expect(await client.replyPermission("permission_compatibility", fixture.directory, "once")).toBe(true);
    expect(await client.replyQuestion("question_compatibility", fixture.directory, [["Yes"]])).toBe(true);
    expect(await client.rejectQuestion("question_compatibility", fixture.directory)).toBe(true);
    const eventTypes: string[] = [];
    for await (const event of client.events(new AbortController().signal)) eventTypes.push(event.payload.type);
    expect(eventTypes).toEqual(["session.created", "message.part.updated", "permission.asked", "question.asked"]);
    expect(await client.deleteSession(fixture.session.id, fixture.directory)).toBe(true);

    await client.close();
    expect(compatibilityProcess.requests).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/agent" },
        { method: "GET", path: "/provider" },
        { method: "GET", path: `/session/${fixture.session.id}` },
        { method: "GET", path: "/global/event" },
      ]),
    );
  });

  it("starts the installed compatible executable as an authenticated loopback Server", async () => {
    const process = new FakeProcess();
    const spawnServer = mock(() => process);
    const createApi = mock(() => api());

    const client = await createOpenCodeServerClient(
      {
        kind: "opencode",
        executablePathOverride: "/opt/opencode",
        env: {
          OPENCODE_CONFIG_DIR: "/tmp/open-config",
          OPENCODE_SERVER_USERNAME: "inherited-user",
          OPENCODE_SERVER_CORS: "*",
          OPENCODE_SERVER_MDNS: "true",
        },
      },
      {
        readVersion: async () => "1.18.10",
        allocatePort: async () => 43129,
        password: () => "generated-secret",
        spawnServer,
        createApi,
      },
    );

    expect(spawnServer).toHaveBeenCalledWith(
      "/opt/opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "43129", "--mdns=false"],
      expect.objectContaining({
        OPENCODE_CONFIG_DIR: "/tmp/open-config",
        OPENCODE_SERVER_PASSWORD: "generated-secret",
      }),
    );
    expect(createApi).toHaveBeenCalledWith("http://127.0.0.1:43129", "opencode", "generated-secret");
    const spawnedEnv = (spawnServer.mock.calls as unknown as Array<[string, string[], NodeJS.ProcessEnv]>)[0]?.[2];
    expect(spawnedEnv?.OPENCODE_SERVER_USERNAME).toBeUndefined();
    expect(spawnedEnv?.OPENCODE_SERVER_CORS).toBeUndefined();
    expect(spawnedEnv?.OPENCODE_SERVER_MDNS).toBeUndefined();
    expect(client.version).toBe("1.18.10");
    await client.close();
    expect(process.exitCode).toBe(0);
  });

  it("generates a fresh 256-bit hex credential for each owned Server process", async () => {
    const childPasswords: string[] = [];
    const apiPasswords: string[] = [];
    let port = 43_129;
    const clients = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const process = new FakeProcess();
        return await createOpenCodeServerClient(
          { kind: "opencode", executablePathOverride: "/opt/opencode" },
          {
            readVersion: async () => "1.18.10",
            allocatePort: async () => port++,
            spawnServer: (_executable, _args, env) => {
              const password = env.OPENCODE_SERVER_PASSWORD;
              if (!password) throw new Error("missing generated Server credential");
              childPasswords.push(password);
              return process;
            },
            createApi: (_baseUrl, _username, password) => {
              apiPasswords.push(password);
              return api();
            },
          },
        );
      }),
    );

    expect(childPasswords).toHaveLength(2);
    expect(childPasswords.every((password) => /^[a-f0-9]{64}$/u.test(password))).toBe(true);
    expect(new Set(childPasswords).size).toBe(2);
    expect(apiPasswords).toEqual(childPasswords);
    await Promise.all(clients.map(async (client) => await client.close()));
  });

  it("requires the executable to be available from the override or effective PATH", async () => {
    await expect(
      createOpenCodeServerClient(
        { kind: "opencode", env: { PATH: "/empty" } },
        {
          findExecutable: () => null,
          readVersion: async () => "1.18.10",
          allocatePort: async () => 1,
          spawnServer: () => new FakeProcess(),
          createApi: () => api(),
        },
      ),
    ).rejects.toThrow("OpenCode executable was not found in PATH");
  });

  it("rejects an executable outside the tested SDK compatibility matrix before spawn", async () => {
    const spawnServer = mock(() => new FakeProcess());
    await expect(
      createOpenCodeServerClient(
        { kind: "opencode", executablePathOverride: "/opt/opencode" },
        {
          readVersion: async () => "1.19.0",
          allocatePort: async () => 1,
          spawnServer,
          createApi: () => api("1.19.0"),
        },
      ),
    ).rejects.toThrow(
      `OpenCode compatibility failure for executable version: Connect ${CONNECT_VERSION}, @opencode-ai/sdk 1.18.10, OpenCode 1.19.0`,
    );
    expect(spawnServer).not.toHaveBeenCalled();
  });

  it("rejects empty executable version output before spawning a Server", async () => {
    const spawnServer = mock(() => new FakeProcess());
    await expect(
      createOpenCodeServerClient(
        { kind: "opencode", executablePathOverride: "/opt/opencode" },
        {
          readVersion: async () => "",
          allocatePort: async () => 1,
          spawnServer,
          createApi: () => api(),
        },
      ),
    ).rejects.toThrow("Failed to read OpenCode version: empty output");
    expect(spawnServer).not.toHaveBeenCalled();
  });

  it("rejects a health response whose version differs from the executable", async () => {
    const process = new FakeProcess();
    await expect(
      createOpenCodeServerClient(
        { kind: "opencode", executablePathOverride: "/opt/opencode" },
        {
          readVersion: async () => "1.18.10",
          allocatePort: async () => 43129,
          spawnServer: () => process,
          createApi: () => api("1.18.9"),
        },
      ),
    ).rejects.toThrow(
      `OpenCode compatibility failure for global.health version: Connect ${CONNECT_VERSION}, @opencode-ai/sdk 1.18.10, OpenCode 1.18.10; executable version 1.18.10 does not match Server version 1.18.9`,
    );
    expect(process.exitCode).toBe(0);
  });

  it("adds Connect, SDK, executable, and capability context to incompatible API errors", async () => {
    const process = new FakeProcess();
    const incompatibleApi = api();
    incompatibleApi.listAgents = async () => {
      throw new Error("response shape mismatch: expected an agent array");
    };
    const client = await createOpenCodeServerClient(
      { kind: "opencode", executablePathOverride: "/opt/opencode" },
      {
        readVersion: async () => "1.18.10",
        allocatePort: async () => 43129,
        spawnServer: () => process,
        createApi: () => incompatibleApi,
      },
    );

    await expect(client.listAgents("/project")).rejects.toThrow(
      `OpenCode compatibility failure for app.agents: Connect ${CONNECT_VERSION}, @opencode-ai/sdk 1.18.10, OpenCode 1.18.10; response shape mismatch: expected an agent array`,
    );
    await client.close();
  });

  it("redacts the generated password from startup diagnostics", async () => {
    const process = new FakeProcess();
    const failingApi = api();
    failingApi.health = async () => {
      throw new Error("not ready");
    };
    const result = createOpenCodeServerClient(
      { kind: "opencode", executablePathOverride: "/opt/opencode" },
      {
        readVersion: async () => "1.18.10",
        allocatePort: async () => 43129,
        password: () => "generated-secret",
        spawnServer: () => {
          queueMicrotask(() => {
            process.stderr.write("fatal generated-secret");
            process.exitCode = 1;
          });
          return process;
        },
        createApi: () => failingApi,
      },
    );
    await expect(result).rejects.toThrow("fatal [REDACTED]");
    await expect(result).rejects.not.toThrow("generated-secret");
  });

  it("restarts through the authenticated HTTP boundary while isolating two same-kind Bindings", async () => {
    const ports = await availablePorts(3);
    const passwords = ["first-secret", "second-secret", "replacement-secret"];
    const processes: AuthenticatedHttpProcess[] = [];
    let passwordIndex = 0;
    let portIndex = 0;
    const serverClientOptions = {
      readVersion: async () => "1.18.10",
      allocatePort: async () => {
        const port = ports[portIndex++];
        if (port === undefined) throw new Error("missing port fixture");
        return port;
      },
      password: () => {
        const password = passwords[passwordIndex++];
        if (password === undefined) throw new Error("missing password fixture");
        return password;
      },
      spawnServer: (_executable: string, args: string[], env: NodeJS.ProcessEnv) => {
        const portFlag = args.indexOf("--port");
        const port = Number(args[portFlag + 1]);
        const password = env.OPENCODE_SERVER_PASSWORD;
        if (!Number.isInteger(port) || !password) throw new Error("invalid authenticated Server launch");
        const process = new AuthenticatedHttpProcess(port, password);
        processes.push(process);
        return process;
      },
    };
    const registry = new RuntimeAdapterRegistry([
      {
        kind: "opencode",
        create: () =>
          createOpenCodeRuntimeAdapter({
            serverClientOptions,
            eventReconnectDelays: [0],
          }),
      },
    ]);
    const firstBinding = {
      kind: "opencode",
      executablePathOverride: "/opt/opencode",
      env: { CLAWCHAT_CONNECT_AGENT_ID: "first" },
    } as const;
    const secondBinding = {
      kind: "opencode",
      executablePathOverride: "/opt/opencode",
      env: { CLAWCHAT_CONNECT_AGENT_ID: "second" },
    } as const;

    await Promise.all([registry.prepare(firstBinding), registry.prepare(secondBinding)]);
    expect(processes).toHaveLength(2);
    const [first, second] = processes;
    if (!first || !second) throw new Error("missing isolated process fixture");
    expect(first.port).not.toBe(second.port);
    expect(first.password).not.toBe(second.password);
    expect((await fetch(`http://127.0.0.1:${first.port}/global/health`)).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${first.port}/global/health`, {
          headers: { Authorization: basicAuth(second.password) },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${first.port}/global/health`, {
          headers: { Authorization: basicAuth(first.password) },
        })
      ).status,
    ).toBe(200);

    first.crash();
    for (let attempt = 0; attempt < 100 && processes.length < 3; attempt += 1) {
      await Bun.sleep(1);
      await registry.prepare(firstBinding);
    }
    expect(processes).toHaveLength(3);
    const replacement = processes[2];
    if (!replacement) throw new Error("missing replacement process fixture");
    expect(first.exitCode).toBe(1);
    expect(second.exitCode).toBeNull();
    expect(replacement.port).not.toBe(first.port);
    expect(replacement.password).not.toBe(first.password);

    await registry.close();
    expect(second.exitCode).toBe(0);
    expect(replacement.exitCode).toBe(0);
  });

  it("escalates bounded shutdown from SIGTERM to SIGKILL", async () => {
    const process = new StubbornProcess();
    const client = await createOpenCodeServerClient(
      { kind: "opencode", executablePathOverride: "/opt/opencode" },
      {
        readVersion: async () => "1.18.10",
        allocatePort: async () => 43129,
        spawnServer: () => process,
        createApi: () => api(),
        shutdownTimeoutMs: 1,
      },
    );

    await client.close();

    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function availablePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(
      servers.map(
        async (server) =>
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          }),
      ),
    );
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to reserve a loopback port");
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        async (server) =>
          await new Promise<void>((resolve, reject) =>
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            }),
          ),
      ),
    );
  }
}
