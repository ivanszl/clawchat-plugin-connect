import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ConnectConfigMutationCoordinator,
  defaultConfig,
  getAgentBinding,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from "../src/config";

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

    const binding = config.agents.work;
    expect(binding).toEqual({
      runtime: exactRuntime,
      runtimeConfig: { executablePathOverride: "/opt/codex" },
      displayName: "Work",
    });
    if (!binding) throw new Error("Expected normalized work Binding");
    expect("kind" in binding).toBe(false);
    expect("runtimeFamily" in binding).toBe(false);
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
          model: { model: "gpt-5-codex" },
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
      model: { model: "gpt-5-codex" },
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

  it("rejects the removed Core-owned Liveware policy instead of silently migrating it", () => {
    expect(() => normalizeConfig({ livewareAccessPolicy: "private" })).toThrow(
      "livewareAccessPolicy was removed; configure the official Liveware Plugin exposure capability instead",
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
    expect(() => normalizeConfig({ clientHost: "toString" })).toThrow("clientHost must be one of: 127.0.0.1, 0.0.0.0");
    expect(() => normalizeConfig({ stateDbPath: "./state.sqlite" })).toThrow("stateDbPath must be an absolute path");
  });

  it("does not publish a candidate when persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-config-failure-"));
    const configPath = join(directory, "config-target");
    await mkdir(configPath);
    const config = defaultConfig();
    const originalPort = config.clientPort;
    const mutations = new ConnectConfigMutationCoordinator(config, configPath);

    await expect(
      mutations.mutate((candidate) => {
        candidate.clientPort = originalPort + 1;
      }),
    ).rejects.toThrow();

    expect(config.clientPort).toBe(originalPort);
    expect(await readdir(directory)).toEqual(["config-target"]);
  });

  it("uses independent temporary files for concurrent direct saves", async () => {
    const configPath = await tempConfigPath();
    const directory = dirname(configPath);
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      ...defaultConfig(),
      clientPort: 48_000 + index,
    }));

    await expect(
      Promise.all(candidates.map(async (candidate) => await saveConfig(candidate, configPath))),
    ).resolves.toHaveLength(candidates.length);

    expect(candidates.map((candidate) => candidate.clientPort)).toContain((await loadConfig(configPath)).clientPort);
    expect(await readdir(directory)).toEqual(["config.json"]);
  });
});
