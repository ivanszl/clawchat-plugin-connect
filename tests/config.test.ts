import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentBinding, loadConfig, normalizeConfig, saveConfig } from "../src/config";

async function tempConfigPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "clawchat-connect-config-")), "config.json");
}

describe("Agent Binding configuration", () => {
  it("defaults Codex Bindings to interactive approvals so Connect Client can surface requests", () => {
    const config = normalizeConfig({
      defaultAgent: "codex",
      agents: { codex: { kind: "codex" } },
    });

    expect(getAgentBinding(config, "codex")).toMatchObject({
      kind: "codex",
      approvalPolicy: "on-request",
      env: { CLAWCHAT_CONNECT_AGENT_ID: "codex" },
    });
  });

  it("injects the selected Binding identity after user environment merging", () => {
    const config = normalizeConfig({
      defaultAgent: "work",
      agents: {
        work: {
          kind: "codex",
          env: { CLAWCHAT_CONNECT_AGENT_ID: "redirected", CUSTOM: "kept" },
        },
      },
    });
    expect(getAgentBinding(config, "work").env).toEqual({
      CLAWCHAT_CONNECT_AGENT_ID: "work",
      CUSTOM: "kept",
    });
  });

  it("enables a private Liveware Exposure by default and accepts only off, private, or public", () => {
    expect(normalizeConfig({}).livewareAccessPolicy).toBe("private");
    expect(normalizeConfig({ livewareAccessPolicy: "off" }).livewareAccessPolicy).toBe("off");
    expect(normalizeConfig({ livewareAccessPolicy: "public" }).livewareAccessPolicy).toBe("public");
    expect(() => normalizeConfig({ livewareAccessPolicy: "allowlist" })).toThrow(
      "livewareAccessPolicy must be one of: off, private, public",
    );
  });

  it("normalizes and persists a Codex Runtime configuration without making the Binding ID semantic", async () => {
    const config = normalizeConfig({
      clientHost: "0.0.0.0",
      mediaUploadUrl: "https://media.example/media/upload",
      defaultAgent: "work",
      agents: {
        work: {
          kind: "codex",
          codexPathOverride: "/opt/codex",
          model: "gpt-5-codex",
          sandboxMode: "workspace-write",
          modelReasoningEffort: "high",
          approvalPolicy: "never",
          webSearchMode: "live",
          networkAccessEnabled: true,
          additionalDirectories: ["/tmp/shared"],
          env: { CODEX_HOME: "/tmp/codex-home" },
        },
      },
    });

    expect(getAgentBinding(config, "work")).toEqual(
      expect.objectContaining({
        kind: "codex",
        codexPathOverride: "/opt/codex",
        model: "gpt-5-codex",
        sandboxMode: "workspace-write",
        modelReasoningEffort: "high",
        approvalPolicy: "never",
        webSearchMode: "live",
        networkAccessEnabled: true,
        additionalDirectories: ["/tmp/shared"],
      }),
    );
    expect(config.clientHost).toBe("0.0.0.0");
    expect(config.mediaUploadUrl).toBe("https://media.example/media/upload");

    const path = await tempConfigPath();
    await saveConfig(config, path);
    await expect(loadConfig(path)).resolves.toEqual(config);
  });

  it("derives a missing media upload endpoint from a custom API base URL", () => {
    const config = normalizeConfig({
      baseUrl: "https://self-hosted.example/connect",
      websocketUrl: "wss://self-hosted.example/ws",
      agents: { codex: { kind: "codex" } },
    });

    expect(config.mediaUploadUrl).toBe("https://self-hosted.example/media/upload");

    const migrated = normalizeConfig({
      baseUrl: "https://self-hosted.example/connect",
      websocketUrl: "wss://self-hosted.example/ws",
      mediaUploadUrl: "https://app.clawling.com/media/upload",
      agents: { codex: { kind: "codex" } },
    });
    expect(migrated.mediaUploadUrl).toBe("https://self-hosted.example/media/upload");
  });

  it("uses a Session-named pending-turn limit without accepting the removed conversation setting", () => {
    expect(normalizeConfig({ maxPendingPerSession: 7 }).maxPendingPerSession).toBe(7);
    const legacy = normalizeConfig({ maxPendingPerChat: 3 });
    expect(legacy.maxPendingPerSession).toBeUndefined();
    expect("maxPendingPerChat" in legacy).toBe(false);
  });

  it("rejects legacy agent shapes instead of migrating them", () => {
    expect(() =>
      normalizeConfig({
        defaultAgent: "codex",
        agents: { codex: { command: "codex" } },
      }),
    ).toThrow("Agent Binding codex Runtime kind is not supported in this release: (missing)");
  });

  it("rejects Runtime kinds without a released Adapter", () => {
    expect(() =>
      normalizeConfig({
        defaultAgent: "other",
        agents: { other: { kind: "unsupported" } },
      }),
    ).toThrow("Agent Binding other Runtime kind is not supported in this release: unsupported");
  });

  it("allows multiple Agent Bindings to use the same Runtime Adapter kind", () => {
    const config = normalizeConfig({
      agents: {
        personal: { kind: "codex" },
        work: { kind: "codex" },
      },
    });

    expect(Object.keys(config.agents)).toEqual(["personal", "work"]);
    expect(config.agents.personal?.kind).toBe("codex");
    expect(config.agents.work?.kind).toBe("codex");
  });

  it("rejects invalid security options instead of silently broadening access", () => {
    expect(() => normalizeConfig({ clientHost: "192.168.1.20" })).toThrow(
      "clientHost must be one of: 127.0.0.1, 0.0.0.0",
    );
    expect(() =>
      normalizeConfig({
        defaultAgent: "codex",
        agents: { codex: { kind: "codex", sandboxMode: "unsafe" } },
      }),
    ).toThrow("sandboxMode must be one of");
    expect(() =>
      normalizeConfig({
        defaultAgent: "codex",
        agents: { codex: { kind: "codex", approvalPolicy: "always" } },
      }),
    ).toThrow("approvalPolicy must be one of");
  });

  it("rejects legacy fields and relative state paths", () => {
    expect(() =>
      normalizeConfig({
        agents: { codex: { kind: "codex", mode: "read-only" } },
      }),
    ).toThrow("legacy agent config field is not supported: mode");
    expect(() => normalizeConfig({ stateDbPath: "./state.sqlite" })).toThrow("stateDbPath must be an absolute path");
    expect(() =>
      normalizeConfig({ agents: { codex: { kind: "codex", additionalDirectories: ["./shared"] } } }),
    ).toThrow("additionalDirectories[0] must be an absolute path");
  });
});
