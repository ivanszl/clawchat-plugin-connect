import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgent, loadConfig, normalizeConfig, saveConfig } from "../src/config";

async function tempConfigPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "clawchat-connect-config-")), "config.json");
}

describe("Codex agent configuration", () => {
  it("normalizes and persists first-party Codex options", async () => {
    const config = normalizeConfig({
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
          skipGitRepoCheck: true,
          additionalDirectories: ["/tmp/shared"],
          env: { CODEX_HOME: "/tmp/codex-home" },
        },
      },
    });

    expect(getAgent(config, "work")).toEqual(
      expect.objectContaining({
        kind: "codex",
        codexPathOverride: "/opt/codex",
        model: "gpt-5-codex",
        sandboxMode: "workspace-write",
        modelReasoningEffort: "high",
        approvalPolicy: "never",
        webSearchMode: "live",
        networkAccessEnabled: true,
        skipGitRepoCheck: true,
        additionalDirectories: ["/tmp/shared"],
      }),
    );

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
    ).toThrow("agent codex kind must be codex");
  });

  it("rejects unsupported runtime kinds", () => {
    expect(() =>
      normalizeConfig({
        defaultAgent: "other",
        agents: { other: { kind: "unsupported" } },
      }),
    ).toThrow("agent other kind must be codex");
  });

  it("rejects invalid security options instead of silently broadening access", () => {
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
