import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLivewareExposureDependencies,
  prepareLivewareExposure,
  type RunLivewareProcess,
  retireLivewareExposure,
} from "../src/liveware-exposure";
import { createStateStore } from "../src/state";
import type { ActivationCredentials } from "../src/types";

describe("production Liveware adapters", () => {
  it("uses the pinned CLI contract and the canonical ClawChat Liveware registration surface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-liveware-external-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const commands: Array<{ command: string[]; env: Record<string, string> }> = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runProcess: RunLivewareProcess = async (command, env) => {
      commands.push({ command, env });
      const operation = command.slice(1, -1).join(" ");
      if (operation === "app list") return success("[]");
      if (operation === "app create ClawChat Connect --policy private") {
        return success(
          JSON.stringify({
            appId: "app-0000000000000001",
            name: "ClawChat Connect",
            publicUrl: "https://app-0000000000000001.apps.example",
          }),
        );
      }
      if (operation === "app access app-0000000000000001 --policy private") return success("{}");
      if (operation === "tunnel bind app-0000000000000001 http://127.0.0.1:47823 --relay-url https://relay.example") {
        return success("{}");
      }
      if (operation === "app inspect app-0000000000000001") {
        return success(
          JSON.stringify({
            appId: "app-0000000000000001",
            name: "ClawChat Connect",
            publicUrl: "https://app-0000000000000001.apps.example",
          }),
        );
      }
      if (operation === "app delete app-0000000000000001") return success("{}");
      throw new Error(`unexpected Liveware command: ${command.join(" ")}`);
    };
    const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://control.example/v1/login") {
        expect(init.headers).toEqual(
          expect.objectContaining({ Authorization: "Bearer clawchat-token", "Content-Type": "application/json" }),
        );
        return json({ code: 0, data: { secret: "liveware-token" } });
      }
      if (url === "https://clawchat.example/v1/agents/me/liveware" && init.method === "GET") {
        return json({ code: 0, data: { liveware: [] } });
      }
      if (url === "https://clawchat.example/v1/agents/me/liveware" && init.method === "POST") {
        const body = init.body;
        expect(body).toBeInstanceOf(FormData);
        expect(Object.fromEntries((body as FormData).entries())).toEqual({
          name: "ClawChat Connect",
          subtitle: "Connect Web",
          liveware_id: "app-0000000000000001",
          url: "https://app-0000000000000001.apps.example",
        });
        return json({ code: 0, data: { liveware: {} } });
      }
      if (url === "https://clawchat.example/v1/agents/me/liveware/app-0000000000000001" && init.method === "DELETE") {
        return json({ code: 0, data: { deleted: true } });
      }
      throw new Error(`unexpected request: ${init.method} ${url}`);
    };
    const dependencies = createLivewareExposureDependencies({
      livewarePath: "/bundle/liveware",
      clawChatBaseUrl: "https://clawchat.example",
      livewareApiUrl: "https://control.example",
      livewareRelayUrl: "https://relay.example",
      fetchImpl: fetchImpl as typeof fetch,
      runProcess,
    });
    const principal = activation();

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

    expect(record.appId).toBe("app-0000000000000001");
    expect(commands.every(({ command }) => !command.some((argument) => /token/u.test(argument)))).toBe(true);
    expect(commands.every(({ env }) => env.LIVEWARE_TOKEN === "liveware-token")).toBe(true);
    expect(
      requests
        .filter(({ url }) => url.startsWith("https://clawchat.example/"))
        .every(({ init }) => {
          const headers = init.headers as Record<string, string>;
          return headers.Authorization === "Bearer clawchat-token" && headers["X-Device-Id"] === "device-1";
        }),
    ).toBe(true);
    await stateStore.close();
  });
});

function activation(): ActivationCredentials {
  return {
    localAgentId: "codex",
    accessToken: "clawchat-token",
    refreshToken: null,
    serverAgentId: "agent-1",
    userId: "agent-user-1",
    ownerUserId: "owner-1",
    conversationId: "conversation-1",
  };
}

function success(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
