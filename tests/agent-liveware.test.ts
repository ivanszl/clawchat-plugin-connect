import { describe, expect, it } from "bun:test";
import { executeAgentLiveware, validateAgentLivewareInput } from "../src/agent/agent-liveware";
import { ClawChatToolApiError } from "../src/agent/tool-executor";
import type { LivewareControlSession } from "../src/service/liveware-exposure";
import type { ActivationCredentials } from "../src/types";

describe("Agent-managed Liveware validation", () => {
  it("permits only exact loopback HTTP upstreams", () => {
    expect(
      validateAgentLivewareInput("liveware_tunnel_bind", {
        appId: "app-1",
        upstream: "http://127.0.0.1:3000",
      }),
    ).toMatchObject({ appId: "app-1" });
    for (const upstream of [
      "http://localhost:3000",
      "https://127.0.0.1:3000",
      "http://127.0.0.1:3000/path",
      "http://0.0.0.0:3000",
    ]) {
      expect(() => validateAgentLivewareInput("liveware_tunnel_bind", { appId: "app-1", upstream })).toThrow();
    }
  });

  it("protects the Connect-managed app name", () => {
    for (const name of ["ClawChat Connect", "ClawChat Connect · personal"]) {
      expect(() =>
        validateAgentLivewareInput("liveware_app_create", {
          name,
          policy: "private",
        }),
      ).toThrow("reserved");
    }
  });

  it("protects the persisted managed app id after the app is renamed", async () => {
    let deleted = false;
    const control = {
      inspectApp: async () => ({ appId: "managed-1", name: "Renamed Connect app", accessPolicy: "private" }),
      deleteApp: async () => {
        deleted = true;
      },
    } as unknown as LivewareControlSession;
    const activation = {
      accessToken: "token",
    } as ActivationCredentials;

    await expect(
      executeAgentLiveware(
        "liveware_app_delete",
        { appId: "managed-1" },
        {
          activation,
          clawChatBaseUrl: "https://example.test",
          deviceId: "device-1",
          managedAppId: "managed-1",
          connectControl: async () => control,
          registerApp: async () => undefined,
          unregisterApp: async () => {
            throw new Error("must not unregister");
          },
        },
      ),
    ).rejects.toThrow("cannot be changed");
    expect(deleted).toBe(false);
  });

  it("registers every bound tunnel in ClawChat and passes login credentials only to the control connection", async () => {
    const registrations: unknown[][] = [];
    const control = {
      inspectApp: async () => ({ appId: "app-1", name: "Dashboard", accessPolicy: "private" }),
      bindTunnel: async (appId: string, upstream: string) => {
        expect([appId, upstream]).toEqual(["app-1", "http://127.0.0.1:3000"]);
        return "https://app-1.apps.example";
      },
    } as unknown as LivewareControlSession;
    const activation = { accessToken: "clawchat-login-token" } as ActivationCredentials;

    await expect(
      executeAgentLiveware(
        "liveware_tunnel_bind",
        { appId: "app-1", upstream: "http://127.0.0.1:3000" },
        {
          activation,
          clawChatBaseUrl: "https://example.test",
          deviceId: "device-1",
          connectControl: async (accessToken) => {
            expect(accessToken).toBe("clawchat-login-token");
            return control;
          },
          registerApp: async (...arguments_) => {
            registrations.push(arguments_);
          },
          unregisterApp: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ registeredInClawChat: true });
    expect(registrations).toEqual([["Dashboard", "app-1", "https://app-1.apps.example"]]);
    expect(JSON.stringify(registrations)).not.toContain("login-token");
  });

  it("cleans up Liveware when the exact ClawChat app was already unregistered", async () => {
    const completed: string[] = [];
    const control = {
      inspectApp: async () => ({ appId: "app-ephemeral", name: "Connect QA ephemeral", accessPolicy: "private" }),
      deleteApp: async (appId: string) => {
        completed.push(`delete:${appId}`);
      },
      unbindTunnel: async (appId: string) => {
        completed.push(`unbind:${appId}`);
      },
    } as unknown as LivewareControlSession;
    const activation = { accessToken: "clawchat-login-token" } as ActivationCredentials;
    const options = {
      activation,
      clawChatBaseUrl: "https://example.test",
      deviceId: "device-1",
      connectControl: async () => control,
      registerApp: async () => undefined,
      unregisterApp: async () => {
        throw new ClawChatToolApiError("agent app not found", 16016, 200, "/v1/agents/me/apps/app-ephemeral", null);
      },
    };

    await expect(
      executeAgentLiveware("liveware_tunnel_unbind", { appId: "app-ephemeral" }, options),
    ).resolves.toMatchObject({ unbound: true, unregisteredFromClawChat: true });
    await expect(
      executeAgentLiveware("liveware_app_delete", { appId: "app-ephemeral" }, options),
    ).resolves.toMatchObject({ deleted: true });
    expect(completed).toEqual(["unbind:app-ephemeral", "delete:app-ephemeral"]);

    await expect(
      executeAgentLiveware(
        "liveware_app_delete",
        { appId: "app-ephemeral" },
        {
          ...options,
          unregisterApp: async () => {
            throw new Error("agent app not found");
          },
        },
      ),
    ).rejects.toThrow("agent app not found");
  });
});
