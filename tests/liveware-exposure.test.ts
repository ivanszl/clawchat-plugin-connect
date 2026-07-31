import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClawChatLivewarePort,
  type LivewareAgentProcess,
  type LivewareApp,
  type LivewareControlPlanePort,
  type LivewareControlSession,
  prepareLivewareExposure,
  retireLivewareExposure,
  startLivewareExposure,
} from "../src/liveware-exposure";
import { createStateStore } from "../src/state";
import type { ActivationCredentials } from "../src/types";

describe("Liveware Exposure", () => {
  it("provisions and registers one private exposure idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-liveware-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const controlPlane = new FakeLivewareControlPlane();
    const clawChat = new FakeClawChatLiveware();
    const input = {
      activation: activation(),
      deviceId: "device-1",
      upstream: "http://127.0.0.1:47823",
      accessPolicy: "private" as const,
      stateStore,
    };

    const first = await prepareLivewareExposure(input, { controlPlane, clawChat });
    const second = await prepareLivewareExposure(input, { controlPlane, clawChat });

    expect(first).toEqual({
      ownerUserId: "owner-1",
      localAgentId: "codex",
      appId: "app-0000000000000001",
      publicUrl: "https://app-0000000000000001.apps.example",
      accessPolicy: "private",
    });
    expect(second).toEqual(first);
    expect(await controlPlane.connect("token-1").then((session) => session.listApps())).toHaveLength(1);
    expect(controlPlane.policies.get(first.appId)).toBe("private");
    expect(controlPlane.bindings.get(first.appId)).toBe("http://127.0.0.1:47823");
    expect(await clawChat.list(activation(), "device-1")).toEqual([
      {
        livewareId: first.appId,
        name: "ClawChat Connect · codex",
        subtitle: "Connect Web",
        url: first.publicUrl,
      },
    ]);
    await expect(stateStore.getLivewareExposure("codex")).resolves.toEqual(first);
    await stateStore.close();
  });

  it("retires the registered App before clearing the local exposure record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-liveware-retire-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const controlPlane = new FakeLivewareControlPlane();
    const clawChat = new FakeClawChatLiveware();
    const principal = activation();
    const dependencies = { controlPlane, clawChat };
    const record = await prepareLivewareExposure(
      {
        activation: principal,
        deviceId: "device-1",
        upstream: "http://127.0.0.1:47823",
        accessPolicy: "private",
        stateStore,
      },
      dependencies,
    );

    await retireLivewareExposure({ activation: principal, deviceId: "device-1", stateStore }, dependencies);

    expect(await clawChat.list(principal, "device-1")).toEqual([]);
    expect(await controlPlane.connect("token-1").then((session) => session.listApps())).toEqual([]);
    expect(controlPlane.bindings.has(record.appId)).toBe(false);
    await expect(stateStore.getLivewareExposure("codex")).resolves.toBeNull();
    await stateStore.close();
  });

  it("changes an existing exposure from private to public without creating a second App", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-liveware-public-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const controlPlane = new FakeLivewareControlPlane();
    const clawChat = new FakeClawChatLiveware();
    const input = {
      activation: activation(),
      deviceId: "device-1",
      upstream: "http://127.0.0.1:47823",
      stateStore,
    };
    const privateExposure = await prepareLivewareExposure(
      { ...input, accessPolicy: "private" },
      { controlPlane, clawChat },
    );

    const publicExposure = await prepareLivewareExposure(
      { ...input, accessPolicy: "public" },
      { controlPlane, clawChat },
    );

    expect(publicExposure).toMatchObject({
      appId: privateExposure.appId,
      accessPolicy: "public",
    });
    expect(controlPlane.apps).toHaveLength(1);
    expect(controlPlane.policies.get(privateExposure.appId)).toBe("public");
    await expect(stateStore.getLivewareExposure("codex")).resolves.toEqual(publicExposure);
    await stateStore.close();
  });

  it("provisions independent Liveware Exposures for Agent Bindings owned by one account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-liveware-multi-account-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const controlPlane = new FakeLivewareControlPlane();
    const clawChat = new FakeClawChatLiveware();
    const dependencies = { controlPlane, clawChat };
    const personal = activation("personal", "shared-owner-token", "shared-owner");
    const work = activation("work", "shared-owner-token", "shared-owner");

    const personalExposure = await prepareLivewareExposure(
      {
        activation: personal,
        deviceId: "device-1",
        upstream: "http://127.0.0.1:48001",
        accessPolicy: "private",
        stateStore,
      },
      dependencies,
    );
    const workExposure = await prepareLivewareExposure(
      {
        activation: work,
        deviceId: "device-1",
        upstream: "http://127.0.0.1:48002",
        accessPolicy: "private",
        stateStore,
      },
      dependencies,
    );

    expect(personalExposure.appId).not.toBe(workExposure.appId);
    await expect(stateStore.listLivewareExposures()).resolves.toEqual([personalExposure, workExposure]);
    expect(controlPlane.bindings.get(personalExposure.appId)).toBe("http://127.0.0.1:48001");
    expect(controlPlane.bindings.get(workExposure.appId)).toBe("http://127.0.0.1:48002");
    await stateStore.close();
  });

  it("restarts an exited Liveware agent and stops supervising when Connect closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-liveware-agent-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const controlPlane = new FakeLivewareControlPlane();
    const clawChat = new FakeClawChatLiveware();
    const errors: string[] = [];

    const handle = await startLivewareExposure(
      {
        activation: activation(),
        deviceId: "device-1",
        upstream: "http://127.0.0.1:47823",
        accessPolicy: "private",
        stateStore,
        writeError: (message) => errors.push(message),
      },
      { controlPlane, clawChat, delay: async () => undefined },
    );
    expect(controlPlane.agentProcesses).toHaveLength(1);

    controlPlane.agentProcesses[0]?.exit(23);
    await eventually(() => controlPlane.agentProcesses.length === 2);
    expect(errors.join("")).toContain("exited with code 23");

    await handle.close();
    expect(controlPlane.agentProcesses[1]?.stopped).toBe(true);
    await Bun.sleep(0);
    expect(controlPlane.agentProcesses).toHaveLength(2);
    await stateStore.close();
  });
});

class FakeLivewareControlPlane implements LivewareControlPlanePort {
  readonly apps = new Map<string, LivewareApp>();
  readonly policies = new Map<string, "private" | "public">();
  readonly bindings = new Map<string, string>();
  readonly agentProcesses: FakeLivewareAgentProcess[] = [];
  private readonly appsByToken = new Map<string, Map<string, LivewareApp>>();
  private nextId = 1;

  async connect(accessToken: string): Promise<LivewareControlSession> {
    const accountApps = this.appsByToken.get(accessToken) ?? new Map<string, LivewareApp>();
    this.appsByToken.set(accessToken, accountApps);
    return {
      listApps: async () => [...accountApps.values()],
      createApp: async (name, accessPolicy) => {
        const appId = `app-${String(this.nextId++).padStart(16, "0")}`;
        const app = {
          appId,
          name,
          publicUrl: `https://${appId}.apps.example`,
        };
        this.apps.set(app.appId, app);
        accountApps.set(app.appId, app);
        this.policies.set(app.appId, accessPolicy);
        return app;
      },
      setAccessPolicy: async (appId, accessPolicy) => {
        this.policies.set(appId, accessPolicy);
      },
      bindTunnel: async (appId, upstream) => {
        this.bindings.set(appId, upstream);
        const app = this.apps.get(appId);
        if (!app) throw new Error("missing app");
        return app.publicUrl;
      },
      deleteApp: async (appId) => {
        this.apps.delete(appId);
        accountApps.delete(appId);
        this.policies.delete(appId);
        this.bindings.delete(appId);
      },
      startAgent: async () => {
        const process = new FakeLivewareAgentProcess();
        this.agentProcesses.push(process);
        return process;
      },
    };
  }
}

class FakeLivewareAgentProcess implements LivewareAgentProcess {
  stopped = false;
  private resolveExit: (exitCode: number) => void = () => undefined;
  readonly exited = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });

  exit(exitCode: number) {
    this.resolveExit(exitCode);
  }

  async stop() {
    this.stopped = true;
    this.resolveExit(0);
  }
}

class FakeClawChatLiveware implements ClawChatLivewarePort {
  private readonly registrations = new Map<
    string,
    Map<string, { livewareId: string; name: string; subtitle: string; url: string }>
  >();

  private registrationsFor(ownerUserId: string) {
    const registrations =
      this.registrations.get(ownerUserId) ??
      new Map<string, { livewareId: string; name: string; subtitle: string; url: string }>();
    this.registrations.set(ownerUserId, registrations);
    return registrations;
  }

  async list(activation: ActivationCredentials, _deviceId: string) {
    return [...this.registrationsFor(activation.ownerUserId).values()];
  }

  async register(
    activation: ActivationCredentials,
    _deviceId: string,
    registration: { livewareId: string; name: string; subtitle: string; url: string },
  ) {
    this.registrationsFor(activation.ownerUserId).set(registration.livewareId, registration);
  }

  async unregister(activation: ActivationCredentials, _deviceId: string, livewareId: string) {
    this.registrationsFor(activation.ownerUserId).delete(livewareId);
  }
}

function activation(localAgentId = "codex", accessToken = "token-1", ownerUserId = "owner-1"): ActivationCredentials {
  return {
    localAgentId,
    accessToken,
    refreshToken: null,
    serverAgentId: "agent-1",
    userId: "agent-user-1",
    ownerUserId,
    conversationId: "conversation-1",
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}
