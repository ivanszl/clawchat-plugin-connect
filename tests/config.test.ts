import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentBinding, loadConfig, normalizeConfig, saveConfig } from "../src/config";

async function tempConfigPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "clawchat-connect-config-")), "config.json");
}

describe("Agent Binding configuration", () => {
  const exactRuntime = {
    pluginId: "clawling.runtime.codex",
    capabilityId: "runtime",
  } as const;

  it("persists only an exact Runtime Plugin capability reference", () => {
    const config = normalizeConfig({
      defaultAgent: "work",
      agents: {
        work: {
          runtime: exactRuntime,
          runtimeConfig: { executablePathOverride: "/opt/codex" },
          displayName: "Work",
        },
      },
    });

    expect(config.agents.work).toEqual({
      runtime: exactRuntime,
      runtimeConfig: { executablePathOverride: "/opt/codex" },
      displayName: "Work",
    });
    expect("kind" in config.agents.work!).toBe(false);
    expect("runtimeFamily" in config.agents.work!).toBe(false);
  });

  it("rejects both built-in and expanded Plugin Binding compatibility forms", () => {
    expect(() => normalizeConfig({ agents: { work: { kind: "codex" } } })).toThrow(
      "Agent Binding work contains unsupported field: kind",
    );
    expect(() =>
      normalizeConfig({
        agents: {
          work: {
            kind: "plugin",
            runtimeFamily: "codex",
            runtime: exactRuntime,
            runtimeConfig: {},
          },
        },
      }),
    ).toThrow("Agent Binding work contains unsupported field: kind, runtimeFamily");
    expect(() =>
      normalizeConfig({
        agents: {
          work: {
            runtime: exactRuntime,
            runtimeConfig: {},
            executablePathOverride: "/opt/codex",
            env: { CODEX_HOME: "/tmp/codex-home" },
          },
        },
      }),
    ).toThrow("Agent Binding work contains unsupported field: executablePathOverride, env");
  });

  it("normalizes generic Binding preferences without interpreting Runtime configuration", async () => {
    const config = normalizeConfig({
      clientHost: "0.0.0.0",
      mediaUploadUrl: "https://media.example/media/upload",
      defaultAgent: "work",
      agents: {
        work: {
          runtime: exactRuntime,
          runtimeConfig: {
            model: "gpt-5-codex",
            sandboxMode: "workspace-write",
            env: { CODEX_HOME: "/tmp/codex-home" },
          },
          displayName: "Local Codex",
          outputVisibility: "full",
          model: "gpt-5-codex",
          modelReasoningEffort: "high",
          sessionOptions: { collaborationMode: "default" },
        },
      },
    });

    expect(getAgentBinding(config, "work")).toEqual({
      runtime: exactRuntime,
      runtimeConfig: {
        model: "gpt-5-codex",
        sandboxMode: "workspace-write",
        env: { CODEX_HOME: "/tmp/codex-home" },
      },
      displayName: "Local Codex",
      outputVisibility: "full",
      model: "gpt-5-codex",
      modelReasoningEffort: "high",
      sessionOptions: { collaborationMode: "default" },
    });
    expect(config.clientHost).toBe("0.0.0.0");
    expect(config.mediaUploadUrl).toBe("https://media.example/media/upload");

    const path = await tempConfigPath();
    await saveConfig(config, path);
    await expect(loadConfig(path)).resolves.toEqual(config);
  });

  it("rejects malformed exact capability identity and configuration", () => {
    expect(() =>
      normalizeConfig({
        agents: {
          work: {
            runtime: { pluginId: "Codex Plugin", capabilityId: "runtime" },
            runtimeConfig: {},
          },
        },
      }),
    ).toThrow("Agent Binding work Plugin ID must be a stable lowercase identifier");
    expect(() =>
      normalizeConfig({
        agents: {
          work: {
            runtime: { ...exactRuntime, family: "codex" },
            runtimeConfig: {},
          },
        },
      }),
    ).toThrow("Agent Binding work Runtime capability reference must contain only pluginId and capabilityId");
    expect(() =>
      normalizeConfig({
        agents: {
          work: {
            runtime: exactRuntime,
            runtimeConfig: [],
          },
        },
      }),
    ).toThrow("Agent Binding work Runtime capability configuration must be an object");
  });

  it("allows several Bindings to reference one exact provider independently", () => {
    const config = normalizeConfig({
      agents: {
        personal: { runtime: exactRuntime, runtimeConfig: { home: "personal" } },
        work: { runtime: exactRuntime, runtimeConfig: { home: "work" } },
      },
    });

    expect(config.agents.personal?.runtime).toEqual(exactRuntime);
    expect(config.agents.personal?.runtimeConfig).toEqual({ home: "personal" });
    expect(config.agents.work?.runtime).toEqual(exactRuntime);
    expect(config.agents.work?.runtimeConfig).toEqual({ home: "work" });
  });

  it("enables a private Liveware Exposure by default and accepts the current policies", () => {
    expect(normalizeConfig({}).livewareAccessPolicy).toBe("private");
    expect(normalizeConfig({ livewareAccessPolicy: "off" }).livewareAccessPolicy).toBe("off");
    expect(normalizeConfig({ livewareAccessPolicy: "public" }).livewareAccessPolicy).toBe("public");
    expect(() => normalizeConfig({ livewareAccessPolicy: "allowlist" })).toThrow(
      "livewareAccessPolicy must be one of: off, private, public",
    );
  });

  it("derives a missing media upload endpoint from a custom API base URL", () => {
    const config = normalizeConfig({
      baseUrl: "https://self-hosted.example/connect",
      websocketUrl: "wss://self-hosted.example/ws",
      agents: { work: { runtime: exactRuntime, runtimeConfig: {} } },
    });
    expect(config.mediaUploadUrl).toBe("https://self-hosted.example/media/upload");

    const normalized = normalizeConfig({
      baseUrl: "https://self-hosted.example/connect",
      websocketUrl: "wss://self-hosted.example/ws",
      mediaUploadUrl: "https://app.clawling.com/media/upload",
      agents: { work: { runtime: exactRuntime, runtimeConfig: {} } },
    });
    expect(normalized.mediaUploadUrl).toBe("https://self-hosted.example/media/upload");
  });

  it("uses a Session-named pending-turn limit without accepting the removed conversation setting", () => {
    expect(normalizeConfig({ maxPendingPerSession: 7 }).maxPendingPerSession).toBe(7);
    const legacy = normalizeConfig({ maxPendingPerChat: 3 });
    expect(legacy.maxPendingPerSession).toBeUndefined();
    expect("maxPendingPerChat" in legacy).toBe(false);
  });

  it("rejects invalid host access and relative state paths", () => {
    expect(() => normalizeConfig({ clientHost: "192.168.1.20" })).toThrow(
      "clientHost must be one of: 127.0.0.1, 0.0.0.0",
    );
    expect(() => normalizeConfig({ clientHost: "toString" })).toThrow(
      "clientHost must be one of: 127.0.0.1, 0.0.0.0",
    );
    expect(() => normalizeConfig({ stateDbPath: "./state.sqlite" })).toThrow("stateDbPath must be an absolute path");
  });
});
