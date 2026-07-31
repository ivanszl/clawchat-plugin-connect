import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { GlobalEvent } from "@opencode-ai/sdk/v2/types";
import {
  createOpenCodeServerClient,
  type OpenCodeApiClient,
  type OpenCodeServerProcess,
} from "../src/runtime/opencode-server";

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
  it("starts the installed compatible executable as an authenticated loopback Server", async () => {
    const process = new FakeProcess();
    const spawnServer = mock(() => process);
    const createApi = mock(() => api());

    const client = await createOpenCodeServerClient(
      {
        kind: "opencode",
        executablePathOverride: "/opt/opencode",
        env: { OPENCODE_CONFIG_DIR: "/tmp/open-config" },
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
    expect(client.version).toBe("1.18.10");
    await client.close();
    expect(process.exitCode).toBe(0);
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
    ).rejects.toThrow("Unsupported OpenCode version 1.19.0; Connect supports 1.18.10 with @opencode-ai/sdk 1.18.10");
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
    ).rejects.toThrow("OpenCode compatibility handshake failed: executable 1.18.10, Server 1.18.9");
    expect(process.exitCode).toBe(0);
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
});
