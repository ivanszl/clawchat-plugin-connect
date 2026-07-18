import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("migrates the legacy codex agent to the first-party SDK", () => {
    const bare = normalizeConfig({
      defaultAgent: "codex",
      agents: { codex: { kind: "acp", command: "codex" } },
    });
    const bridged = normalizeConfig({
      defaultAgent: "codex",
      agents: {
        codex: {
          kind: "acp",
          command: "npx",
          args: ["-y", "@agentclientprotocol/codex-acp"],
        },
      },
    });

    expect(getAgent(bare, "codex")).toEqual({ kind: "codex" });
    expect(getAgent(bridged, "codex")).toEqual({ kind: "codex" });
  });

  it("preserves non-Codex ACP agents", () => {
    const config = normalizeConfig({
      defaultAgent: "claude",
      agents: {
        claude: {
          kind: "acp",
          command: "npx",
          args: ["-y", "@agentclientprotocol/claude-agent-acp"],
        },
      },
    });

    expect(getAgent(config, "claude")).toEqual({
      kind: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    });
  });

  it("rejects invalid Codex enum values during normalization", () => {
    const config = normalizeConfig({
      defaultAgent: "codex",
      agents: {
        codex: { kind: "codex", sandboxMode: "unsafe", approvalPolicy: "always" },
      },
    });

    expect(getAgent(config, "codex")).toEqual({ kind: "codex" });
  });
});
