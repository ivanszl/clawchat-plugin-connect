import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentBinding, loadConfig, normalizeConfig, saveConfig } from "../src/config";

async function tempConfigPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "clawchat-connect-config-")), "config.json");
}

describe("Agent Binding configuration", () => {
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

  it("allows at most one Agent Binding for each Runtime Adapter kind", () => {
    expect(() =>
      normalizeConfig({
        agents: {
          work: { kind: "codex" },
          review: { kind: "codex" },
        },
      }),
    ).toThrow("Runtime kind codex may be configured only once");
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
