import { describe, expect, it } from "bun:test";
import { validateAgentLivewareInput } from "../src/agent-liveware";

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
    expect(() =>
      validateAgentLivewareInput("liveware_app_create", {
        name: "ClawChat Connect",
        policy: "private",
      }),
    ).toThrow("reserved");
  });
});
