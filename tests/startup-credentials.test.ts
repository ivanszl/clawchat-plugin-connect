import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupCredentials } from "../src/account/startup-credentials";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { startConnectService } from "../src/service/connect-service";
import type { ActivationCredentials } from "../src/types";
import { pluginBinding } from "./runtime-adapter-fixture";

const now = 1_800_000_000_000;
const jwt = (expiry: number, changes: Record<string, unknown> = {}) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        sub: "agent-user",
        oid: "owner-user",
        aid: "agent-id",
        did: "device-id",
        exp: expiry,
        ...changes,
      }),
    ).toString("base64url"),
    Buffer.from("synthetic-test-signature").toString("base64url"),
  ].join(".");
const fresh = () => ({ access_token: jwt(now / 1000 + 3600), refresh_token: "new-refresh-secret" });
const response = () => Response.json({ code: 0, data: fresh() });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "connect-startup-refresh-"));
  const dbPath = join(directory, "state.sqlite"),
    store = createStateStore({ dbPath });
  const activation: ActivationCredentials = {
    localAgentId: "dsh",
    accessToken: jwt(now / 1000 - 3600),
    refreshToken: "old-refresh-secret",
    userId: "agent-user",
    ownerUserId: "owner-user",
    serverAgentId: "agent-id",
    conversationId: "owner-chat",
  };
  await store.commitActivationForInstallationOwner(activation);
  const db = new Database(dbPath);
  db.query("INSERT INTO device_state(id,device_id,updated_at) VALUES(1,?,?)").run("device-id", now);
  db.close();
  const options = { store, activation, deviceId: "device-id", baseUrl: "https://fixture.invalid", now: () => now };
  return {
    directory,
    dbPath,
    store,
    activation,
    options,
    receipts() {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db.query("SELECT * FROM activation_refresh_attempts").all();
      } finally {
        db.close();
      }
    },
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("expired startup credential rotation", () => {
  it("starts the real Connect Service with renewed credentials before attempting the first Binding handshake", async () => {
    const f = await fixture();
    let requests = 0,
      starts = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        requests++;
        expect(new URL(request.url).pathname).toBe("/v1/auth/refresh");
        expect(request.headers.has("authorization")).toBe(false);
        expect(await request.json()).toEqual({ refresh_token: "old-refresh-secret" });
        return response();
      },
    });
    try {
      await f.store.commitActivationForInstallationOwner({
        ...f.activation,
        accessToken: jwt(Math.floor(Date.now() / 1000) - 1),
      });
      const config = defaultConfig();
      config.agents.dsh = pluginBinding();
      config.defaultAgent = "dsh";
      config.baseUrl = server.url.origin;
      config.stateDbPath = f.dbPath;
      const errors: string[] = [];
      const result = await startConnectService(
        {
          config,
          configPath: join(f.directory, "config.json"),
          stateStore: f.store,
          waitUntilShutdown: async () => {},
          writeOutput: () => {},
          writeError: (message) => errors.push(message),
        },
        {
          verifyInstalledSkills: async () => {},
          startBindingRuntime: async (options) => {
            starts++;
            if (options.activation.accessToken !== fresh().access_token) throw new Error("authentication failed");
            expect((await options.stateStore.getActivation("dsh"))?.accessToken).toBe(fresh().access_token);
            return { agentId: "dsh", websocketUrl: config.websocketUrl, deviceId: "device-id", close: async () => {} };
          },
        },
      );
      expect(result.startedAgentIds).toEqual(["dsh"]);
      expect(starts).toBe(1);
      expect(requests).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await server.stop(true);
      await f.close();
    }
  });

  it("refreshes once through the canonical API, persists tokens atomically and keeps Binding identity", async () => {
    const f = await fixture();
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://fixture.invalid/v1/auth/refresh");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-device-id")).toBe("device-id");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "old-refresh-secret" });
      return response();
    });
    try {
      const result = await startupCredentials({ ...f.options, fetchImpl });
      expect(result).toEqual({
        ...f.activation,
        accessToken: fresh().access_token,
        refreshToken: fresh().refresh_token,
      });
      expect(await f.store.getActivation("dsh")).toEqual(result);
      expect(f.receipts()).toMatchObject([{ state: "succeeded" }]);
      expect(JSON.stringify(f.receipts())).not.toContain("refresh-secret");
      expect(JSON.stringify(f.receipts())).not.toContain(f.activation.accessToken);
      await startupCredentials({ ...f.options, activation: result, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("keeps nonexpired/opaque credentials and existing live authentication untouched", async () => {
    const f = await fixture(),
      fetchImpl = mock(async () => response());
    try {
      for (const accessToken of [jwt(now / 1000 + 1), "opaque-token", "not.a.jwt"])
        expect(
          await startupCredentials({ ...f.options, activation: { ...f.activation, accessToken }, fetchImpl }),
        ).toEqual({ ...f.activation, accessToken });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(f.receipts()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("rejects foreign identity/device claims before sending refresh credentials", async () => {
    const f = await fixture(),
      fetchImpl = mock(async () => response());
    try {
      for (const key of ["sub", "oid", "aid", "did"])
        await expect(
          startupCredentials({
            ...f.options,
            activation: { ...f.activation, accessToken: jwt(now / 1000 - 1, { [key]: "foreign" }) },
            fetchImpl,
          }),
        ).rejects.toThrow("cannot be refreshed safely");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(f.receipts()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("does not repeat rejected or indeterminate rotations after a service restart", async () => {
    for (const kind of ["rejected", "transport", "bad-json", "server-error"]) {
      const f = await fixture();
      let replacement = f.store;
      const fetchImpl = mock(async () => {
        if (kind === "rejected") return new Response("private-auth-error", { status: 401 });
        if (kind === "transport") throw new Error("old-refresh-secret echoed by transport");
        if (kind === "bad-json") return Response.json({ private: "new-refresh-secret" });
        return Response.json({ code: 0, data: fresh() }, { status: 500 });
      });
      try {
        await expect(startupCredentials({ ...f.options, fetchImpl })).rejects.toThrow(
          kind === "rejected" ? "was rejected" : "outcome is unknown",
        );
        expect(await f.store.getActivation("dsh")).toEqual(f.activation);
        await f.store.close();
        replacement = createStateStore({ dbPath: f.dbPath });
        await expect(startupCredentials({ ...f.options, store: replacement, fetchImpl })).rejects.toThrow(
          "already attempted",
        );
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(f.receipts()).toMatchObject([{ state: kind === "rejected" ? "rejected" : "unknown" }]);
      } finally {
        await replacement.close();
        await f.close();
      }
    }
  });

  it("preserves current credentials when a concurrent canonical re-pair wins before refresh returns", async () => {
    const f = await fixture();
    let release!: (value: Response) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchImpl = mock(async () => {
      started();
      return await new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    try {
      const task = startupCredentials({ ...f.options, fetchImpl });
      await startedPromise;
      const current = { ...f.activation, accessToken: jwt(now / 1000 + 7200), refreshToken: "native-repair-secret" };
      await f.store.commitActivationForInstallationOwner(current);
      release(response());
      await expect(task).rejects.toThrow("lost its Binding revision");
      expect(await f.store.getActivation("dsh")).toEqual(current);
      expect(f.receipts()).toMatchObject([{ state: "conflict" }]);
    } finally {
      await f.close();
    }
  });

  it("keeps uncertain pending attempts across process interruption and rejects duplicate in-flight calls", async () => {
    const f = await fixture(),
      fetchImpl = mock(async () => response());
    try {
      expect(await f.store.beginActivationRefresh(f.activation, "device-id")).not.toBeNull();
      expect(await f.store.beginActivationRefresh(f.activation, "device-id")).toBeNull();
      await expect(startupCredentials({ ...f.options, fetchImpl })).rejects.toThrow("pending or already attempted");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(f.receipts()).toMatchObject([{ state: "pending" }]);
      expect(await f.store.getActivation("dsh")).toEqual(f.activation);
    } finally {
      await f.close();
    }
  });

  it("fences a rotation against source revision, device and Installation Owner changes", async () => {
    for (const kind of ["revision", "device", "owner"]) {
      const f = await fixture();
      try {
        const claim = await f.store.beginActivationRefresh(f.activation, "device-id");
        if (!claim) throw new Error("test claim was not acquired");
        const db = new Database(f.dbPath);
        if (kind === "revision")
          db.query("UPDATE activations SET updated_at = updated_at + 1 WHERE local_agent_id = ?").run("dsh");
        else if (kind === "device")
          db.query("UPDATE device_state SET device_id = ? WHERE id = 1").run("changed-device");
        else db.query("UPDATE installation_owner SET owner_user_id = ? WHERE id = 1").run("changed-owner");
        db.close();
        expect(
          await f.store.completeActivationRefresh(f.activation, "device-id", claim, {
            accessToken: fresh().access_token,
            refreshToken: fresh().refresh_token,
          }),
        ).toBe(false);
        expect(await f.store.getActivation("dsh")).toEqual(f.activation);
        expect(f.receipts()).toMatchObject([{ state: "conflict" }]);
      } finally {
        await f.close();
      }
    }
  });

  it("rejects returned foreign/expired identities without storing or exposing the response", async () => {
    for (const change of [
      { sub: "foreign-agent" },
      { oid: "foreign-owner" },
      { aid: "foreign-agent-id" },
      { did: "foreign-device" },
      { exp: now / 1000 - 1 },
    ]) {
      const f = await fixture();
      try {
        await expect(
          startupCredentials({
            ...f.options,
            fetchImpl: async () =>
              Response.json({
                code: 0,
                data: { access_token: jwt(now / 1000 + 3600, change), refresh_token: "private-returned-token" },
              }),
          }),
        ).rejects.toThrow("identity or expiry check failed");
        expect(await f.store.getActivation("dsh")).toEqual(f.activation);
        expect(f.receipts()).toMatchObject([{ state: "unknown" }]);
      } finally {
        await f.close();
      }
    }
  });

  it("keeps schema4 data readable and removes receipts through native Binding deletion", async () => {
    const f = await fixture();
    try {
      await startupCredentials({ ...f.options, fetchImpl: async () => response() });
      const db = new Database(f.dbPath, { readonly: true });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      db.close();
      await f.store.purgeAgentBinding("dsh");
      expect(f.receipts()).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
