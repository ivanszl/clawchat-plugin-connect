import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConnect } from "../src/account/activation";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import {
  type ClawChatLivewarePort,
  type LivewareApp,
  type LivewareControlPlanePort,
  type LivewareControlSession,
  prepareLivewareExposure,
} from "../src/service/liveware-exposure";
import type { ActivationCredentials } from "../src/types";
import { pluginBinding } from "./runtime-adapter-fixture";

describe("Installation Owner activation with Liveware Exposure", () => {
  it("rejects another owner without mutating the existing Liveware Exposure or local state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-multi-owner-"));
    const config = upsertAgentBinding(upsertAgentBinding(defaultConfig(), "personal", pluginBinding()), "work", pluginBinding());
    config.stateDbPath = join(directory, "state.sqlite");
    config.livewareAccessPolicy = "private";
    const store = createStateStore({ dbPath: config.stateDbPath });
    const previous = activation("personal", "token-old", "owner-old", "agent-user-old");
    await store.commitActivationForInstallationOwner(previous);
    await store.insertProject({ projectId: "project-1", name: "Existing Project", rootPath: directory });
    await store.upsertRuntimeSession({
      chatId: "chat-existing",
      sessionId: "session-existing",
      agentId: "personal",
      runtimeSessionId: "thread-existing",
      projectId: "project-1",
      isCurrent: true,
    });
    const controlPlane = new OwnerScopedControlPlane();
    const clawChat = new OwnerScopedClawChatLiveware();
    const livewareDependencies = { controlPlane, clawChat };
    const oldExposure = await prepareLivewareExposure(
      {
        activation: previous,
        deviceId: "device-1",
        upstream: "http://127.0.0.1:47823",
        accessPolicy: "private",
        stateStore: store,
      },
      livewareDependencies,
    );
    const fetchImpl = async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? json({
            code: 0,
            data: {
              access_token: "token-new",
              agent: { id: "agent-new", user_id: "agent-user-new", owner_id: "owner-new" },
            },
          })
        : json({ code: 0, data: { nickname: "codex" } });

    await expect(
      activateConnect({
        agentId: "work",
        code: "NEWOWNER",
        config,
        store,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow("this Connect installation is owned by owner-old");

    await expect(store.listActivations()).resolves.toEqual([
      expect.objectContaining({ localAgentId: "personal", ownerUserId: "owner-old", accessToken: "token-old" }),
    ]);
    await expect(store.listProjects()).resolves.toEqual([
      expect.objectContaining({ projectId: "project-1", name: "Existing Project" }),
    ]);
    await expect(store.getCurrentRuntimeSession("chat-existing", "personal")).resolves.toMatchObject({
      sessionId: "session-existing",
      runtimeSessionId: "thread-existing",
      projectId: "project-1",
    });
    expect(controlPlane.appsFor("owner-old").has(oldExposure.appId)).toBe(true);
    expect(clawChat.registrationsFor("owner-old").has(oldExposure.appId)).toBe(true);
    await expect(store.listLivewareExposures()).resolves.toEqual([oldExposure]);
    expect(controlPlane.appsFor("owner-new")).toHaveLength(0);
    expect(clawChat.registrationsFor("owner-new")).toHaveLength(0);
    await store.close();
  });

  it("does not require Liveware Control Plane access during activation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-liveware-activation-failure-"));
    const config = upsertAgentBinding(defaultConfig(), "codex", pluginBinding());
    config.stateDbPath = join(directory, "state.sqlite");
    const store = createStateStore({ dbPath: config.stateDbPath });
    const fetchImpl = async (input: string | URL | Request) =>
      String(input).endsWith("/v1/agents/connect")
        ? json({
            code: 0,
            data: {
              access_token: "token-new",
              agent: { id: "agent-new", user_id: "agent-user-new", owner_id: "owner-new" },
            },
          })
        : json({ code: 0, data: { nickname: "codex" } });

    await expect(
      activateConnect({
        agentId: "codex",
        code: "LIVEWAREDOWN",
        config,
        store,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({ localAgentId: "codex", ownerUserId: "owner-new" });
    await expect(store.getActivation("codex")).resolves.toMatchObject({
      ownerUserId: "owner-new",
      accessToken: "token-new",
    });
    await store.close();
  });
});

class OwnerScopedControlPlane implements LivewareControlPlanePort {
  private readonly apps = new Map<string, Map<string, LivewareApp>>();
  private nextId = 1;

  appsFor(owner: string): Map<string, LivewareApp> {
    const existing = this.apps.get(owner);
    if (existing) return existing;
    const created = new Map<string, LivewareApp>();
    this.apps.set(owner, created);
    return created;
  }

  async connect(accessToken: string): Promise<LivewareControlSession> {
    const owner = accessToken === "token-old" ? "owner-old" : accessToken === "token-new" ? "owner-new" : "";
    if (!owner) throw new Error("unexpected token");
    const apps = this.appsFor(owner);
    return {
      listApps: async () => [...apps.values()],
      createApp: async (name) => {
        const appId = `app-${String(this.nextId++).padStart(16, "0")}`;
        const app = { appId, name, publicUrl: `https://${appId}.apps.example` };
        apps.set(appId, app);
        return app;
      },
      setAccessPolicy: async () => undefined,
      bindTunnel: async (appId) => {
        const app = apps.get(appId);
        if (!app) throw new Error("missing app");
        return app.publicUrl;
      },
      deleteApp: async (appId) => {
        apps.delete(appId);
      },
      startAgent: async () => ({
        exited: new Promise<number>(() => undefined),
        stop: async () => undefined,
      }),
    };
  }
}

class OwnerScopedClawChatLiveware implements ClawChatLivewarePort {
  private readonly registrations = new Map<
    string,
    Map<string, { livewareId: string; name: string; subtitle: string; url: string }>
  >();

  registrationsFor(owner: string) {
    const existing = this.registrations.get(owner);
    if (existing) return existing;
    const created = new Map<string, { livewareId: string; name: string; subtitle: string; url: string }>();
    this.registrations.set(owner, created);
    return created;
  }

  async list(activation: ActivationCredentials) {
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

function activation(
  localAgentId: string,
  accessToken: string,
  ownerUserId: string,
  userId: string,
): ActivationCredentials {
  return {
    localAgentId,
    accessToken,
    refreshToken: null,
    serverAgentId: `server-${localAgentId}`,
    userId,
    ownerUserId,
    conversationId: null,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
