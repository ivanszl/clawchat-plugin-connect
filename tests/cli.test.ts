import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateAccountProfileResult } from "../src/account/profile";
import type { ChatCommandContext } from "../src/clawchat/chat-commands";
import {
  handleChatCommand as handleChatCommandImpl,
  isConnectControlMessage,
  requiresOrderedSessionControl,
} from "../src/clawchat/chat-commands";
import type { NormalizedInboundMessage } from "../src/clawchat/protocol";
import { defaultConfig, loadConfig, saveConfig, upsertAgentBinding } from "../src/config";
import { type ConnectStateStore, createStateStore } from "../src/persistence/state";
import { createAgentBinding } from "../src/plugin/binding";
import type { ConnectPluginBundleV1 } from "../src/plugin/sdk";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
} from "../src/plugin/sdk";
import { currentConnectPluginTarget, installPluginBundle, setInstalledPluginStatus } from "../src/plugin/store";
import type { SelectableRuntimeThread } from "../src/runtime/types";
import { runConnectCli } from "../src/service/cli";
import { CONNECT_VERSION } from "../src/service/version";
import type { AgentBindingConfig } from "../src/types";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

type TestChatCommandContext = Omit<ChatCommandContext, "runtimeFamilyFor"> &
  Partial<Pick<ChatCommandContext, "runtimeFamilyFor">>;

function handleChatCommand(context: TestChatCommandContext) {
  return handleChatCommandImpl({
    ...context,
    runtimeFamilyFor: context.runtimeFamilyFor ?? (() => "codex"),
  });
}

function testBinding(
  configuration: Record<string, unknown> = {},
  preferences: Pick<AgentBindingConfig, "displayName" | "outputVisibility" | "model" | "modelReasoningEffort"> = {},
): AgentBindingConfig {
  return {
    ...createAgentBinding({
      pluginId: "test.runtime",
      capabilityId: "runtime",
      configuration,
    }),
    ...preferences,
  };
}

async function tempConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clawchat-connect-cli-"));
  return join(dir, "config.json");
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
    },
  };
}

const CLI_PLUGIN_ID = "example.cli-runtime";

type CliPluginBehavior = "success" | "throw-entry" | "missing-provider" | "create-failure" | "prepare-failure";

function cliPluginBundle(behavior: CliPluginBehavior = "success"): ConnectPluginBundleV1 {
  const effectsKey = `__connectCliProviderValidation_${behavior.replaceAll("-", "_")}`;
  const runtimeRegistration =
    behavior === "missing-provider"
      ? ""
      : `
    context.hostCapabilities.get("runtime-provider").register({
      capabilityId: "exact-runtime",
      family: "example",
      create() {
        effects.push("create");
        ${behavior === "create-failure" ? 'throw new Error("provider create failed");' : ""}
        return {
          modes: [],
          async prepare() {
            effects.push("prepare");
            ${behavior === "prepare-failure" ? 'throw new Error("provider prepare failed");' : ""}
          },
          async start() { throw new Error("not exercised"); },
          async close() { effects.push("adapter-dispose"); }
        };
      }
    });`;
  const source = `
const effects = globalThis[${JSON.stringify(effectsKey)}] = [];
export default {
  async activate(context) {
    effects.push("entry-activate");
    ${behavior === "throw-entry" ? 'throw new Error("entry activation failed");' : ""}
    ${runtimeRegistration}
    context.hostCapabilities.get("exposure-provider").register({
      capabilityId: "exposure-only",
      async activate() {
        effects.push("exposure-activate");
        return () => effects.push("exposure-dispose");
      }
    });
    return () => effects.push("plugin-dispose");
  }
};`;
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  return {
    format: CONNECT_PLUGIN_BUNDLE_FORMAT,
    manifest: {
      manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      pluginId: CLI_PLUGIN_ID,
      version: "1.0.0",
      dependencies: [
        { type: "host", id: "runtime-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
        { type: "host", id: "exposure-provider", interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION },
      ],
      installationConfigurationSchema: { type: "object", additionalProperties: false },
      capabilities: [
        {
          id: "exact-runtime",
          type: "runtime",
          family: "example",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: {
            type: "object",
            properties: {
              endpoint: { type: "string", pattern: "^https?://" },
              retries: { type: "integer", minimum: 1 },
            },
            required: ["endpoint"],
            additionalProperties: false,
          },
        },
        {
          id: "exposure-only",
          type: "exposure",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema: { type: "object", additionalProperties: false },
        },
      ],
      artifacts: [{ target: currentConnectPluginTarget(), entry: "plugin.mjs", integrity }],
    },
    files: { "plugin.mjs": { encoding: "utf8", content: source } },
  };
}
async function installCliPlugin(configPath: string, bundle = cliPluginBundle()) {
  return await installPluginBundle({
    configPath,
    source: { type: "local", path: configPath },
    bundle,
  });
}

function message(text: string, chatType: "direct" | "group" = "direct"): NormalizedInboundMessage {
  return {
    event: "message.send",
    chatId: "chat-1",
    chatType,
    messageId: "msg-1",
    traceId: "trace-1",
    sender: { id: "usr", type: "direct", nick_name: "User" },
    emittedAt: 1,
    text,
    fragments: [{ kind: "text", text }],
    mentions: [],
    replyToMessageId: null,
    raw: {} as never,
  };
}

describe("runConnectCli", () => {
  it("reports the build version pinned by the release manifest", async () => {
    const output = io();
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };

    await expect(runConnectCli(["--version"], output.deps)).resolves.toBe(0);

    expect(CONNECT_VERSION).toBe(manifest.version);
    expect(output.stdout).toEqual([`clawchat-connect v${manifest.version}\n`]);
  });

  it("initializes Plugin-free administration config without unsupported surfaces", async () => {
    const path = await tempConfig();
    const output = io();

    await expect(runConnectCli(["init", "--config", path], output.deps)).resolves.toBe(0);

    const config = await loadConfig(path);
    expect(config.agents).toEqual({});
    expect(config.defaultAgent).toBeNull();
    const text = await readFile(path, "utf8");
    expect(text).not.toMatch(new RegExp(["pro", "jects"].join(""), "u"));
    expect(text).not.toMatch(new RegExp(["work", "Dir"].join(""), "u"));
  });

  it("rejects the removed kind-only Runtime Binding flags", async () => {
    const path = await tempConfig();
    const output = io();
    await runConnectCli(["init", "--config", path], output.deps);

    await expect(
      runConnectCli(["agent", "add", "work", "--kind", "codex", "--config", path], output.deps),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("requires --plugin <plugin-id> and --capability <capability-id>");
    expect((await loadConfig(path)).agents).toEqual({});
  });

  it("creates only an exact active Plugin Runtime Binding with schema-valid configuration", async () => {
    const path = await tempConfig();
    const output = io();
    await saveConfig(defaultConfig(), path);
    const originalConfig = await readFile(path, "utf8");
    const addPluginBinding = async (options: {
      pluginId?: string;
      capabilityId?: string;
      runtimeConfig?: Record<string, unknown>;
    }) =>
      await runConnectCli(
        [
          "agent",
          "add",
          "bound",
          "--plugin",
          options.pluginId ?? CLI_PLUGIN_ID,
          "--capability",
          options.capabilityId ?? "exact-runtime",
          "--runtime-config-json",
          JSON.stringify(options.runtimeConfig ?? { endpoint: "https://runtime.example", retries: 2 }),
          "--config",
          path,
        ],
        output.deps,
      );
    const expectRejectedWithoutConfigChange = async (
      expectedError: string,
      options: Parameters<typeof addPluginBinding>[0] = {},
    ) => {
      output.stderr.length = 0;
      await expect(addPluginBinding(options)).resolves.toBe(1);
      expect(output.stderr.join("")).toContain(expectedError);
      await expect(readFile(path, "utf8")).resolves.toBe(originalConfig);
    };

    await expectRejectedWithoutConfigChange("Plugin is not installed: missing.plugin", {
      pluginId: "missing.plugin",
    });

    await installCliPlugin(path);

    await setInstalledPluginStatus(path, CLI_PLUGIN_ID, "disabled");
    await expectRejectedWithoutConfigChange(`Plugin ${CLI_PLUGIN_ID} is not active (status: disabled)`);

    await setInstalledPluginStatus(path, CLI_PLUGIN_ID, "error", new Error("activation failed"));
    await expectRejectedWithoutConfigChange(`Plugin ${CLI_PLUGIN_ID} is not active (status: error): activation failed`);

    await setInstalledPluginStatus(path, CLI_PLUGIN_ID, "active");
    await expectRejectedWithoutConfigChange(`Plugin ${CLI_PLUGIN_ID} has no capability absent`, {
      capabilityId: "absent",
    });
    await expectRejectedWithoutConfigChange(
      `Plugin ${CLI_PLUGIN_ID} capability exposure-only is not a Runtime capability`,
      { capabilityId: "exposure-only" },
    );
    expect(output.stderr.join("")).not.toContain("Runtime family");
    await expectRejectedWithoutConfigChange(`Plugin ${CLI_PLUGIN_ID}/exact-runtime Runtime configuration is invalid`, {
      runtimeConfig: { endpoint: "not a uri", retries: 0 },
    });

    output.stderr.length = 0;
    await expect(addPluginBinding({})).resolves.toBe(0);
    expect(output.stderr).toEqual([]);
    await expect(loadConfig(path)).resolves.toMatchObject({
      defaultAgent: "bound",
      agents: {
        bound: {
          runtime: { pluginId: CLI_PLUGIN_ID, capabilityId: "exact-runtime" },
          runtimeConfig: { endpoint: "https://runtime.example", retries: 2 },
        },
      },
    });
    expect(Reflect.get(globalThis, "__connectCliProviderValidation_success")).toEqual([
      "entry-activate",
      "create",
      "prepare",
      "adapter-dispose",
      "plugin-dispose",
    ]);
  });

  for (const scenario of [
    {
      behavior: "throw-entry",
      diagnostic: "entry activation failed",
      effects: ["entry-activate"],
    },
    {
      behavior: "missing-provider",
      diagnostic: `Plugin ${CLI_PLUGIN_ID} registered 1 providers; manifest declares 2`,
      effects: ["entry-activate", "plugin-dispose"],
    },
    {
      behavior: "create-failure",
      diagnostic: "provider create failed",
      effects: ["entry-activate", "create", "plugin-dispose"],
    },
    {
      behavior: "prepare-failure",
      diagnostic: "provider prepare failed",
      effects: ["entry-activate", "create", "prepare", "adapter-dispose", "plugin-dispose"],
    },
  ] as const) {
    it(`rejects an active Plugin Bundle with ${scenario.behavior} before changing the Binding`, async () => {
      const path = await tempConfig();
      const output = io();
      await saveConfig(upsertAgentBinding(defaultConfig(), "bound", testBinding()), path);
      const originalConfig = await readFile(path, "utf8");
      await installCliPlugin(path, cliPluginBundle(scenario.behavior));

      await expect(
        runConnectCli(
          [
            "agent",
            "add",
            "bound",
            "--plugin",
            CLI_PLUGIN_ID,
            "--capability",
            "exact-runtime",
            "--runtime-config-json",
            JSON.stringify({ endpoint: "https://runtime.example", retries: 2 }),
            "--config",
            path,
          ],
          output.deps,
        ),
      ).resolves.toBe(1);

      expect(output.stderr.join("")).toContain(scenario.diagnostic);
      await expect(readFile(path, "utf8")).resolves.toBe(originalConfig);
      expect(
        Reflect.get(globalThis, `__connectCliProviderValidation_${scenario.behavior.replaceAll("-", "_")}`),
      ).toEqual(scenario.effects);
    });
  }

  it("requires explicit confirmation before removing an Agent Binding and its local data", async () => {
    const path = await tempConfig();
    const output = io();
    const removeAgentBinding = mock(async () => ({ agentId: "work", configPath: path }));

    await expect(
      runConnectCli(["agent", "remove", "work", "--config", path], {
        ...output.deps,
        removeAgentBinding,
      }),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("--yes");
    expect(removeAgentBinding).not.toHaveBeenCalled();

    output.stderr.length = 0;
    await expect(
      runConnectCli(["agent", "remove", "work", "--yes", "--config", path], {
        ...output.deps,
        removeAgentBinding,
      }),
    ).resolves.toBe(0);
    expect(removeAgentBinding).toHaveBeenCalledWith({ agentId: "work", configPath: path });
    expect(output.stdout.join("")).toContain("Removed Agent Binding work");
  });

  it("rejects Agent Bindings without an exact Plugin Runtime capability", async () => {
    const path = await tempConfig();
    const output = io();
    await runConnectCli(["init", "--config", path], output.deps);
    await expect(runConnectCli(["agent", "add", "claude", "--config", path], output.deps)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("requires --plugin <plugin-id> and --capability <capability-id>");
  });

  it("reads and updates config through the config subcommands", async () => {
    const path = await tempConfig();
    const stateDbPath = `${path}.sqlite`;
    const output = io();
    await runConnectCli(["init", "--config", path], output.deps);

    output.stdout.length = 0;
    await expect(
      runConnectCli(["config", "set", "stateDbPath", stateDbPath, "--config", path], output.deps),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({ stateDbPath });
    expect(output.stdout.join("")).toContain("Updated config:");

    await expect(
      runConnectCli(["config", "set", "clientHost", "0.0.0.0", "--config", path], output.deps),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({ clientHost: "0.0.0.0" });

    await expect(
      runConnectCli(
        ["config", "set", "mediaUploadUrl", "https://media.example/media/upload", "--config", path],
        output.deps,
      ),
    ).resolves.toBe(0);
    await expect(loadConfig(path)).resolves.toMatchObject({
      mediaUploadUrl: "https://media.example/media/upload",
    });

    await expect(
      runConnectCli(["config", "set", "livewareAccessPolicy", "public", "--config", path], output.deps),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("Unsupported config key: livewareAccessPolicy");

    output.stdout.length = 0;
    await expect(runConnectCli(["config", "get", "stateDbPath", "--config", path], output.deps)).resolves.toBe(0);
    expect(output.stdout).toEqual([`${JSON.stringify(stateDbPath)}\n`]);
  });

  it("reports the selected Plugin Runtime capability and latest bounded operator diagnostic", async () => {
    const path = await tempConfig();
    const config = defaultConfig();
    config.defaultAgent = "desktop";
    config.agents = {
      desktop: createAgentBinding({
        pluginId: CLI_PLUGIN_ID,
        capabilityId: "exact-runtime",
        configuration: { endpoint: "https://runtime.example" },
      }),
    };
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    await installCliPlugin(path);
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.setRuntimeConnectionStatus("desktop", false, "Runtime temporarily unavailable.");
    await store.close();
    const output = io();

    await expect(runConnectCli(["status", "--config", path], output.deps)).resolves.toBe(0);

    expect(output.stdout.join("")).toContain(`runtime capability: example (${CLI_PLUGIN_ID}/exact-runtime)`);
    expect(output.stdout.join("")).toContain("recent diagnostic: Runtime temporarily unavailable.");
  });

  it("checks the remaining mandatory installation diagnostics", async () => {
    const path = await tempConfig();
    await saveConfig(defaultConfig(), path);
    const output = io();

    await expect(runConnectCli(["doctor", "--config", path], output.deps)).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("clawchat-connect doctor:");
  });

  it("updates Connect through the release installer and refreshes the configured service", async () => {
    const output = io();
    const updateConnect = mock(async () => ({
      version: "v0.1.0-alpha.16",
      executablePath: "/opt/connect/clawchat-connect",
    }));

    await expect(
      runConnectCli(["update", "--version", "v0.1.0-alpha.16", "--config", "/tmp/connect.json"], {
        ...output.deps,
        updateConnect,
      }),
    ).resolves.toBe(0);

    expect(updateConnect).toHaveBeenCalledWith({
      version: "v0.1.0-alpha.16",
      configPath: "/tmp/connect.json",
    });
    expect(output.stdout.join("")).toContain("Updated ClawChat Connect to v0.1.0-alpha.16");
  });

  it("manages Workspaces only through the local CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-workspace-cli-"));
    const configPath = join(directory, "config.json");
    const root = join(directory, "repo");
    await mkdir(root);
    const config = defaultConfig();
    config.agents = { codex: testBinding() };
    config.stateDbPath = join(directory, "state.sqlite");
    await saveConfig(config, configPath);
    const output = io();

    await expect(runConnectCli(["workspace", "add", "codex", root, "--config", configPath], output.deps)).resolves.toBe(
      0,
    );
    const workspaceRef = /\(([23456789A-Z]{8})\)/u.exec(output.stdout.join(""))?.[1];
    expect(workspaceRef).toBeTruthy();
    if (!workspaceRef) throw new Error("expected Workspace Ref");

    output.stdout.length = 0;
    await expect(runConnectCli(["workspace", "list", "codex", "--config", configPath], output.deps)).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("repo");
    expect(output.stdout.join("")).toContain(root);

    output.stdout.length = 0;
    await expect(
      runConnectCli(["workspace", "remove", "codex", workspaceRef, "--config", configPath], output.deps),
    ).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("Removed Workspace repo");
  });

  it("activates through injectable activation action without printing invite code", async () => {
    const output = io();
    const activateConnect = mock(async () => ({
      localAgentId: "codex",
      accessToken: "token",
      refreshToken: null,
      serverAgentId: "agt",
      userId: "usr-agent",
      ownerUserId: "usr-owner",
      conversationId: "chat-owner",
    }));
    await expect(runConnectCli(["activate", "codex", "A1B2C3"], { ...output.deps, activateConnect })).resolves.toBe(0);
    expect(activateConnect).toHaveBeenCalledWith(expect.objectContaining({ agentId: "codex", code: "A1B2C3" }));
    expect(output.stdout.join("")).not.toContain("A1B2C3");
  });

  it("reserves process execution for the native background service", async () => {
    const output = io();
    const startConnectService = mock(async () => ({ startedAgentIds: ["codex", "claude"] }));
    await expect(
      runConnectCli(["service", "exec", "--config", "/tmp/connect.json"], {
        ...output.deps,
        startConnectService,
      }),
    ).resolves.toBe(0);
    expect(startConnectService).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/connect.json",
        writeOutput: expect.any(Function),
        writeError: expect.any(Function),
      }),
    );

    output.stdout.length = 0;
    await expect(runConnectCli(["run"], { ...output.deps, startConnectService })).resolves.toBe(1);
    expect(startConnectService).toHaveBeenCalledTimes(1);
    expect(output.stdout.join("")).not.toContain("run [--config");
  });

  it("opens the fixed loopback Connect Client URL", async () => {
    const path = await tempConfig();
    const config = defaultConfig();
    config.stateDbPath = `${path}.sqlite`;
    config.clientPort = 49_123;
    await saveConfig(config, path);
    const output = io();
    const openUrl = mock(async (_url: string) => undefined);

    await expect(runConnectCli(["web", "--config", path], { ...output.deps, openUrl })).resolves.toBe(0);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:49123/");
    expect(output.stdout.join("")).toContain("Connect Client URL: http://127.0.0.1:49123/");

    await expect(runConnectCli(["web", "--no-open", "--config", path], { ...output.deps, openUrl })).resolves.toBe(0);
    expect(openUrl).toHaveBeenCalledTimes(1);

    config.clientHost = "0.0.0.0";
    await saveConfig(config, path);
    output.stdout.length = 0;
    await expect(runConnectCli(["web", "--no-open", "--config", path], { ...output.deps, openUrl })).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("LAN Host mode is enabled on 0.0.0.0:49123");
  });

  it("manages one native background service for the complete Connect installation", async () => {
    const path = await tempConfig();
    const output = io();
    await runConnectCli(["init", "--config", path], output.deps);
    const manageBackgroundService = mock(async () => ({ message: "background ok\n", running: true }));

    await expect(
      runConnectCli(["service", "logs", "--lines", "25", "--follow", "--config", path], {
        ...output.deps,
        manageBackgroundService,
      }),
    ).resolves.toBe(0);
    expect(manageBackgroundService).toHaveBeenCalledWith({
      action: "logs",
      configPath: path,
      lines: 25,
      follow: true,
    });
    expect(output.stdout.join("")).toContain("background ok");

    await expect(runConnectCli(["service", "status", "--agent", "work", "--config", path], output.deps)).resolves.toBe(
      1,
    );
    expect(output.stderr.join("")).toContain("manages all activated Agent Bindings");
  });

  it("updates the connected ClawChat Profile through the CLI", async () => {
    const output = io();
    const updateAccountProfile = mock(
      async (): Promise<UpdateAccountProfileResult> => ({ agentId: "work", profile: { nickname: "Luna" } }),
    );

    await expect(
      runConnectCli(
        [
          "profile",
          "update",
          "--agent",
          "work",
          "--nickname",
          "Luna",
          "--avatar-url",
          "https://example.com/luna.png",
          "--bio",
          "Local coding agent",
          "--config",
          "/tmp/connect.json",
        ],
        { ...output.deps, updateAccountProfile },
      ),
    ).resolves.toBe(0);
    expect(updateAccountProfile).toHaveBeenCalledWith({
      agentId: "work",
      configPath: "/tmp/connect.json",
      patch: {
        nickname: "Luna",
        avatar_url: "https://example.com/luna.png",
        bio: "Local coding agent",
      },
    });
    expect(output.stdout.join("")).toContain("Updated ClawChat Profile for work");
  });

  it("rejects empty Profile updates and no longer exposes an MCP server command", async () => {
    const output = io();
    const updateAccountProfile = mock(
      async (): Promise<UpdateAccountProfileResult> => ({
        agentId: "work",
        profile: {},
      }),
    );

    await expect(
      runConnectCli(["profile", "update", "--agent", "work"], { ...output.deps, updateAccountProfile }),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("at least one Profile field");
    expect(updateAccountProfile).not.toHaveBeenCalled();

    output.stdout.length = 0;
    output.stderr.length = 0;
    await expect(runConnectCli(["mcp-server", "--agent", "work"], output.deps)).resolves.toBe(1);
    expect(output.stdout.join("")).not.toContain("mcp-server");
  });

  it("exposes tool-name calls through the SQLite request record and returns reused settled results", async () => {
    const path = await tempConfig();
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    const store = createStateStore({ dbPath: config.stateDbPath });
    await store.submitToolRequest({
      requestId: "known-request",
      bindingId: "codex",
      toolName: "clawchat_get_account_profile",
      normalizedInput: {},
      timeoutMs: 30_000,
    });
    await store.claimNextToolRequest("codex");
    await store.settleToolRequest("known-request", { state: "succeeded", result: { nickname: "Connect" } });
    await store.close();
    const output = io();

    await expect(
      runConnectCli(
        [
          "tool",
          "call",
          "clawchat_get_account_profile",
          "--input-json",
          "{}",
          "--request-id",
          "known-request",
          "--agent",
          "codex",
          "--config",
          path,
        ],
        output.deps,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(output.stdout.at(-1) ?? "{}")).toMatchObject({
      requestId: "known-request",
      toolName: "clawchat_get_account_profile",
      status: "succeeded",
      result: { nickname: "Connect" },
    });
    expect(JSON.parse(output.stdout.at(-1) ?? "{}")).not.toHaveProperty("agent");
  });

  it("settles a locally timed-out Tool Request to a terminal state", async () => {
    const path = await tempConfig();
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    const output = io();

    await expect(
      runConnectCli(
        [
          "tool",
          "call",
          "clawchat_get_account_profile",
          "--input-json",
          "{}",
          "--request-id",
          "deadline-request",
          "--agent",
          "codex",
          "--config",
          path,
        ],
        { ...output.deps, toolRequestWaitMs: 0 },
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(output.stdout.at(-1) ?? "{}")).toMatchObject({
      requestId: "deadline-request",
      status: "expired",
    });
  });

  it("lists the static 24-entry tool catalog without opening state", async () => {
    const output = io();
    await expect(runConnectCli(["tool", "list"], output.deps)).resolves.toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "{}").tools).toHaveLength(24);
  });

  it("describes tools, reads stdin JSON, and honors explicit, runtime, then default Binding precedence", async () => {
    const path = await tempConfig();
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    config.stateDbPath = `${path}.sqlite`;
    await saveConfig(config, path);
    const store = createStateStore({ dbPath: config.stateDbPath });
    for (const requestId of ["explicit-request", "default-request"]) {
      await store.submitToolRequest({
        requestId,
        bindingId: "codex",
        toolName: "clawchat_get_user_profile",
        normalizedInput: { userId: "user-1" },
        timeoutMs: 30_000,
      });
      await store.claimNextToolRequest("codex");
      await store.settleToolRequest(requestId, { state: "succeeded", result: { userId: "user-1" } });
    }
    await store.close();
    const output = io();

    await expect(runConnectCli(["tool", "describe", "clawchat_get_user_profile"], output.deps)).resolves.toBe(0);
    expect(JSON.parse(output.stdout.pop() ?? "{}")).toMatchObject({
      name: "clawchat_get_user_profile",
      inputSchema: { required: ["userId"] },
    });

    const previousBinding = process.env.CLAWCHAT_CONNECT_AGENT_ID;
    try {
      process.env.CLAWCHAT_CONNECT_AGENT_ID = "missing-runtime-binding";
      await expect(
        runConnectCli(
          [
            "tool",
            "call",
            "clawchat_get_user_profile",
            "--input-json",
            "-",
            "--request-id",
            "explicit-request",
            "--agent",
            "codex",
            "--config",
            path,
          ],
          { ...output.deps, readStdin: async () => '{"userId":"user-1"}' },
        ),
      ).resolves.toBe(0);
      await expect(
        runConnectCli(
          ["tool", "call", "clawchat_get_user_profile", "--input-json", '{"userId":"user-1"}', "--config", path],
          output.deps,
        ),
      ).resolves.toBe(1);
      expect(output.stderr.join("")).toContain("missing-runtime-binding");

      delete process.env.CLAWCHAT_CONNECT_AGENT_ID;
      await expect(
        runConnectCli(
          [
            "tool",
            "call",
            "clawchat_get_user_profile",
            "--input-json",
            '{"userId":"user-1"}',
            "--request-id",
            "default-request",
            "--config",
            path,
          ],
          output.deps,
        ),
      ).resolves.toBe(0);
    } finally {
      if (previousBinding === undefined) delete process.env.CLAWCHAT_CONNECT_AGENT_ID;
      else process.env.CLAWCHAT_CONNECT_AGENT_ID = previousBinding;
    }
  });
});

describe("handleChatCommand", () => {
  it("orders only controls that change Session routing or turn settings", () => {
    for (const text of [
      "/new",
      "/new Plan",
      "/switch ABCDEFGH",
      "/workspace ABCDEFGH",
      "/model default",
      "/mode read-only",
    ])
      expect(requiresOrderedSessionControl(text)).toBe(true);
    for (const text of [
      "/help",
      "/status",
      "/sessions",
      "/switch",
      "/workspace",
      "/model",
      "/mode",
      "/clawchat-output full",
    ])
      expect(requiresOrderedSessionControl(text)).toBe(false);
    expect(isConnectControlMessage("/status")).toBe(true);
    expect(isConnectControlMessage("ordinary work")).toBe(false);
  });

  it("uses /help as the only Connect help command", async () => {
    const context = {
      agentId: "codex",
      ownerUserId: "someone-else",
      config: upsertAgentBinding(defaultConfig(), "codex", testBinding()),
      stateStore: {} as ConnectStateStore,
      workspaces: {} as WorkspaceCatalog,
    };

    const help = await handleChatCommand({ ...context, message: message("/help") });
    const helpText = help.text ?? "";
    expect(help.handled).toBe(true);
    expect(helpText.includes("/sessions")).toBe(true);
    expect(helpText.includes("/model")).toBe(true);
    expect(helpText.includes("/project add")).toBe(false);
    expect(helpText.includes("/current")).toBe(false);
    await expect(handleChatCommand({ ...context, message: message("/clawchat-help") })).resolves.toMatchObject({
      handled: true,
      text: expect.stringContaining("Unknown ClawChat command: /clawchat-help"),
    });
    await expect(handleChatCommand({ ...context, message: message("/list") })).resolves.toMatchObject({
      handled: true,
      text: expect.stringContaining("Unknown Connect command: /list"),
    });
  });

  it("validates the exact single-line command grammar before authorization", async () => {
    const context = {
      agentId: "codex",
      ownerUserId: "owner-user",
      config: upsertAgentBinding(defaultConfig(), "codex", testBinding()),
      stateStore: {} as ConnectStateStore,
      workspaces: {} as WorkspaceCatalog,
    };

    await expect(handleChatCommand({ ...context, message: message("/status extra", "group") })).resolves.toMatchObject({
      handled: true,
      text: "Usage: @Agent /status",
    });
    await expect(handleChatCommand({ ...context, message: message("/help\n/status") })).resolves.toMatchObject({
      handled: true,
      text: "Usage: /help",
    });
    await expect(
      handleChatCommand({
        ...context,
        message: {
          ...message("/cancel"),
          fragments: [
            { kind: "text", text: "/cancel" },
            { kind: "file", url: "https://media.example/file.txt" },
          ],
        },
      }),
    ).resolves.toMatchObject({
      handled: true,
      text: "Usage: /cancel",
    });
    await expect(handleChatCommand({ ...context, message: message("/clawchat-output bogus") })).resolves.toMatchObject({
      handled: true,
      text: "Usage: /clawchat-output minimal|normal|full",
    });
    await expect(handleChatCommand({ ...context, message: message("/STATUS") })).resolves.toEqual({
      handled: false,
    });
    await expect(handleChatCommand({ ...context, message: message("/clawchat-OUTPUT full") })).resolves.toEqual({
      handled: false,
    });
  });

  it("persists /clawchat-output overrides", async () => {
    const store = { setOutputVisibility: mock(async () => undefined) } as unknown as ConnectStateStore;
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    await expect(
      handleChatCommand({
        message: message("/clawchat-output full"),
        agentId: "codex",
        config,
        stateStore: store,
        workspaces: {} as WorkspaceCatalog,
        ownerUserId: "usr",
      }),
    ).resolves.toMatchObject({ handled: true });
    expect(store.setOutputVisibility).toHaveBeenCalledWith("codex", "chat-1", "full");
  });

  it("rejects control commands from users other than the Agent Binding owner", async () => {
    const store = {} as ConnectStateStore;
    const workspaces = { list: mock(async () => []) } as unknown as WorkspaceCatalog;
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    const result = await handleChatCommand({
      message: message("/workspace"),
      agentId: "codex",
      ownerUserId: "owner-user",
      config,
      stateStore: store,
      workspaces,
    });
    expect(result).toMatchObject({ handled: true, text: expect.stringContaining("owner") });
    expect(workspaces.list).not.toHaveBeenCalled();
  });

  it("handles Session and Workspace commands while removing legacy directory commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-commands-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const workspace = await workspaces.add("codex", root);
    const workspaceRef = workspace.workspaceRef;
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    const closeRuntimeSession = mock(async () => true);
    const invalidateRuntimeSession = mock(async () => true);
    for (const command of [
      "/status",
      "/new",
      "/sessions",
      "/workspace",
      `/workspace ${workspaceRef}`,
      "/mode read-only",
      "/cancel",
    ]) {
      const result = await handleChatCommand({
        message: message(command, "group"),
        agentId: "codex",
        ownerUserId: "usr",
        config,
        stateStore: store,
        workspaces,
        closeRuntimeSession,
        invalidateRuntimeSession,
        runtimeModesFor: () => ["read-only", "workspace-write", "danger-full-access"],
      });
      expect(result.handled, command).toBe(true);
      expect(result.text, command).toBeTruthy();
    }
    for (const command of ["/dir", "/dir /tmp/repo", "/cd /tmp/other"]) {
      await expect(
        handleChatCommand({
          message: message(command),
          agentId: "codex",
          ownerUserId: "usr",
          config,
          stateStore: store,
          workspaces,
        }),
      ).resolves.toEqual({ handled: false });
    }
    expect(closeRuntimeSession).toHaveBeenCalled();
    expect(invalidateRuntimeSession).not.toHaveBeenCalled();

    await expect(
      handleChatCommand({
        message: message("/mode unsupported"),
        agentId: "codex",
        ownerUserId: "usr",
        config,
        stateStore: store,
        workspaces,
        runtimeModesFor: () => ["read-only", "workspace-write", "danger-full-access"],
      }),
    ).resolves.toMatchObject({ handled: true, text: "Usage: /mode [mode|default]" });
    await store.close();
  });

  it("records Workspace changes without creating a Session before the first message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-project-switch-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const workspace = await workspaces.add("work", root);
    const workspaceRef = workspace.workspaceRef;
    const config = upsertAgentBinding(defaultConfig(), "work", testBinding());
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "before",
      agentId: "work",
      runtimeSessionId: "thread-before",
      workspaceRef: null,
    });
    const closeRuntimeSession = mock(async () => true);

    const selected = await handleChatCommand({
      message: message(`/workspace ${workspaceRef}`),
      agentId: "work",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      closeRuntimeSession,
    });
    expect(selected.text).toContain("next message");
    expect(await store.getCurrentRuntimeSession("chat-1", "work")).toBeNull();
    expect(await store.listRuntimeSessions("chat-1", "work")).toHaveLength(1);
    await expect(store.getSessionIntent("chat-1", "work")).resolves.toMatchObject({ workspaceRef: expect.any(String) });
    await expect(
      handleChatCommand({
        message: message("/status"),
        agentId: "work",
        ownerUserId: "usr",
        config,
        stateStore: store,
        workspaces,
      }),
    ).resolves.toMatchObject({ text: expect.stringContaining("next Session (not started)") });
    const selectedList = await handleChatCommand({
      message: message("/sessions"),
      agentId: "work",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
    });
    expect(selectedList.text).toContain("No Sessions in Workspace `repo`");
    expect(selectedList.text).not.toContain("thread-before");
    expect(closeRuntimeSession).toHaveBeenCalledTimes(1);

    await store.close();
  });

  it("uses synchronized Workspace Refs and labels from Connect Client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-workspace-command-"));
    const registeredRoot = join(directory, "clawchat-plugin-connect");
    const discoveredRoot = join(directory, "clawpet");
    await Promise.all([mkdir(registeredRoot), mkdir(discoveredRoot)]);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const registered = await workspaces.add("codex", registeredRoot);
    const discovered = await workspaces.add("codex", discoveredRoot);
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    const listRuntimeWorkspaces = async () => [
      {
        workspaceRef: registered.workspaceRef,
        name: "clawchat-plugin-connect",
        rootPath: registeredRoot,
      },
      {
        workspaceRef: discovered.workspaceRef,
        name: "clawpet",
        rootPath: discoveredRoot,
      },
    ];

    const listed = await handleChatCommand({
      message: message("/workspace"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      listRuntimeWorkspaces,
    });
    expect(listed.text).toContain("clawchat-plugin-connect");
    expect(listed.text).toContain("clawpet");
    expect(listed.text).not.toContain("Runtime Workspace");

    const rejectedName = await handleChatCommand({
      message: message("/workspace clawpet"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      listRuntimeWorkspaces,
    });
    expect(rejectedName.text).toContain("Unknown Workspace Ref");
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toBeNull();

    await handleChatCommand({
      message: message(`/workspace ${discovered.workspaceRef}`),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      listRuntimeWorkspaces,
      closeRuntimeSession: async () => true,
    });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      workspaceRef: expect.any(String),
    });
    await expect(workspaces.list("codex")).resolves.toHaveLength(3);
    await store.close();
  });

  it("records /new without creating an empty Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-new-intent-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-existing",
      agentId: "codex",
      name: "Existing work",
    });

    const result = await handleChatCommand({
      message: message("/new Planned work"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      closeRuntimeSession: mock(async () => true),
    });

    expect(result.text).toContain("next message");
    expect(await store.getCurrentRuntimeSession("chat-1", "codex")).toBeNull();
    expect(await store.listRuntimeSessions("chat-1", "codex")).toHaveLength(1);
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      name: "Planned work",
      workspaceRef: expect.any(String),
    });
    await store.close();
  });

  it("plans a desktop-invisible CodeBuddy Session for WorkBuddy /new", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-workbuddy-new-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const workspaceRoot = join(directory, "repo");
    await mkdir(workspaceRoot);
    const project = await workspaces.add("workbuddy", workspaceRoot);
    const config = upsertAgentBinding(defaultConfig(), "workbuddy", testBinding({ profile: "workbuddy-cn" }));
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-workbuddy-task",
      agentId: "workbuddy",
      runtimeSessionId: "task-native-1",
      workspaceRef: project.workspaceRef,
      name: "Existing WorkBuddy Task",
    });

    const result = await handleChatCommand({
      message: message("/new Planned work"),
      agentId: "workbuddy",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      closeRuntimeSession: mock(async () => true),
      runtimeFamilyFor: () => "workbuddy",
    });

    expect(result.text).toContain("CodeBuddy Session `Planned work`");
    expect(result.text).toContain("will not appear in WorkBuddy Desktop");
    expect(await store.getCurrentRuntimeSession("chat-1", "workbuddy")).toBeNull();
    await expect(store.getSessionIntent("chat-1", "workbuddy")).resolves.toMatchObject({
      name: "Planned work",
      workspaceRef: project.workspaceRef,
    });
    const status = await handleChatCommand({
      message: message("/status"),
      agentId: "workbuddy",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      runtimeFamilyFor: () => "workbuddy",
    });
    expect(status.text).toContain("CodeBuddy Session");
    expect(status.text).toContain("not shown in WorkBuddy Desktop");
    await store.close();
  });

  it("selects and clears a validated model without replacing the Runtime Thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-model-command-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding({}, { model: "gpt-default" }));
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-model",
      agentId: "codex",
      runtimeSessionId: "thread-stable",
    });
    const context = {
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      listRuntimeModels: async () => [
        {
          id: "gpt-default",
          displayName: "Default",
          description: "Default model",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          inputModalities: ["text" as const],
        },
        {
          id: "gpt-deep",
          displayName: "Deep",
          description: "Deep model",
          isDefault: false,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["high", "xhigh"],
          inputModalities: ["text" as const, "image" as const],
        },
      ],
    };

    await expect(handleChatCommand({ ...context, message: message("/model gpt-deep xhigh") })).resolves.toMatchObject({
      text: expect.stringContaining("gpt-deep"),
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-stable",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
    });

    await handleChatCommand({
      ...context,
      listRuntimeModels: async () => {
        throw new Error("catalog temporarily unavailable");
      },
      message: message("/model default"),
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-stable",
      model: null,
      reasoningEffort: null,
    });
    await store.close();
  });

  it("validates a pending Session model atomically and preserves it through /new", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-model-intent-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    const workspace = await workspaces.ensureDefault("codex");
    const models = async () => [
      {
        id: "gpt-deep",
        displayName: "Deep",
        description: "Deep model",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["high", "xhigh"],
        inputModalities: ["text" as const],
      },
    ];
    const context = {
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      listRuntimeModels: models,
    };
    await handleChatCommand({ ...context, message: message(`/workspace ${workspace.workspaceRef}`) });

    await handleChatCommand({ ...context, message: message("/model gpt-deep") });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      model: "gpt-deep",
      reasoningEffort: "high",
    });
    await expect(handleChatCommand({ ...context, message: message("/model gpt-deep low") })).resolves.toMatchObject({
      text: expect.stringContaining("not supported"),
    });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      model: "gpt-deep",
      reasoningEffort: "high",
    });
    await handleChatCommand({ ...context, message: message("/new Continue") });
    await expect(store.getSessionIntent("chat-1", "codex")).resolves.toMatchObject({
      name: "Continue",
      model: "gpt-deep",
      reasoningEffort: "high",
    });
    await expect(
      handleChatCommand({
        ...context,
        listRuntimeModels: undefined,
        message: message("/model gpt-deep"),
      }),
    ).resolves.toMatchObject({ text: expect.stringContaining("does not support model selection") });
    await store.close();
  });

  it("lists Session names and switches existing or discovered Runtime Threads by name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-named-sessions-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const project = await workspaces.add("codex", root);
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-current",
      agentId: "codex",
      workspaceRef: project.workspaceRef,
      name: "Current work",
      runtimeSessionId: "thread-current",
      isCurrent: true,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-release",
      agentId: "codex",
      workspaceRef: project.workspaceRef,
      name: "Release prep",
      runtimeSessionId: "thread-release",
      isCurrent: false,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-non-project",
      agentId: "codex",
      workspaceRef: null,
      name: "Unrelated Non-Project work",
      runtimeSessionId: "thread-non-project",
      isCurrent: false,
    });
    const discovered: SelectableRuntimeThread[] = [
      {
        runtimeThreadId: "thread-external",
        name: "Fix login flow",
        updatedAt: 2,
        sessionRef: await store.getOrCreateSessionRef({
          chatId: "chat-1",
          agentId: "codex",
          runtimeSessionId: "thread-external",
        }),
      },
    ];
    const base = {
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      closeRuntimeSession: mock(async () => true),
      discoverRuntimeThreads: mock(async () => discovered),
    };

    const listed = await handleChatCommand({ ...base, message: message("/sessions") });
    expect(listed.text).toContain("Current work");
    expect(listed.text).toContain("(current)");
    expect(listed.text).toContain("Release prep");
    expect(listed.text).toContain("Fix login flow");
    expect(listed.text).toContain("(available)");
    expect(listed.text).not.toContain("Unrelated Non-Project work");
    expect(listed.text).not.toContain("session-release");
    expect(listed.text).not.toContain("thread-external");

    const release = (await store.listRuntimeSessions("chat-1", "codex")).find(
      (session) => session.name === "Release prep",
    );
    if (!release) throw new Error("expected release Session");
    expect(listed.text).toContain(release.sessionRef);
    expect(listed.text).toContain(discovered[0].sessionRef);
    await expect(
      handleChatCommand({ ...base, message: message(`/switch ${release.sessionRef.toLowerCase()}`) }),
    ).resolves.toMatchObject({
      text: `Switched to Session \`Release prep\` (\`${release.sessionRef}\`).`,
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      sessionId: "session-release",
    });

    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-release-duplicate",
      agentId: "codex",
      workspaceRef: project.workspaceRef,
      name: "Release prep",
      runtimeSessionId: "thread-release-duplicate",
      isCurrent: false,
    });
    const duplicate = (await store.listRuntimeSessions("chat-1", "codex")).find(
      (session) => session.sessionId === "session-release-duplicate",
    );
    if (!duplicate) throw new Error("expected duplicate named Session");
    const ambiguous = await handleChatCommand({ ...base, message: message("/switch Release prep") });
    expect(ambiguous.text).toContain(release.sessionRef);
    expect(ambiguous.text).toContain(duplicate.sessionRef);
    expect(ambiguous.text).not.toContain("session-release");

    await expect(
      handleChatCommand({ ...base, message: message(`/switch ${discovered[0].sessionRef}`) }),
    ).resolves.toMatchObject({
      text: `Imported and switched to Runtime Thread \`Fix login flow\` (\`${discovered[0].sessionRef}\`).`,
    });
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      name: "Fix login flow",
      runtimeSessionId: "thread-external",
      sessionRef: discovered[0].sessionRef,
      workspaceRef: project.workspaceRef,
    });
    await store.close();
  });

  it("switches a Client Catalog Session Ref without waiting for Runtime Thread discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-catalog-switch-"));
    const root = join(directory, "repo");
    await mkdir(root);
    const generatedRefs = ["ABCDEFGH", "NKEP79B8"];
    const store = createStateStore({
      dbPath: join(directory, "state.sqlite"),
      sessionRefFactory: () => generatedRefs.shift() ?? "JKLMNPQR",
    });
    const workspaces = new WorkspaceCatalog(store);
    const project = await workspaces.add("codex", root);
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-current",
      agentId: "codex",
      workspaceRef: project.workspaceRef,
      runtimeSessionId: "thread-current",
      isCurrent: true,
    });
    const catalogRef = await store.getOrCreateSessionRef({
      chatId: "__connect_client_catalog__",
      agentId: "codex",
      runtimeSessionId: "thread-catalog",
    });
    expect(catalogRef).toBe("NKEP79B8");

    const switched = await Promise.race([
      handleChatCommand({
        message: message(`/switch ${catalogRef}`),
        agentId: "codex",
        ownerUserId: "usr",
        config,
        stateStore: store,
        workspaces,
        closeRuntimeSession: mock(async () => true),
        discoverRuntimeThreads: async () => await new Promise<SelectableRuntimeThread[]>(() => undefined),
      }),
      Bun.sleep(50).then(() => ({ handled: true, text: "timed out waiting for Runtime Thread discovery" })),
    ]);

    expect(switched.text).toBe(`Imported and switched to Session \`${catalogRef}\`.`);
    await expect(store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-catalog",
      sessionRef: catalogRef,
      workspaceRef: project.workspaceRef,
      isCurrent: true,
    });
    await store.close();
  });

  it("lists only the current Session in a Non-Project workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-non-project-list-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "codex", testBinding());
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-old",
      agentId: "codex",
      name: "Old isolated work",
      isCurrent: false,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-current",
      agentId: "codex",
      name: "Current isolated work",
      isCurrent: true,
    });

    const listed = await handleChatCommand({
      message: message("/sessions"),
      agentId: "codex",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
    });
    expect(listed.text).toContain("Current isolated work");
    expect(listed.text).not.toContain("Old isolated work");
    await store.close();
  });

  it("lists and switches both CodeBuddy Sessions and WorkBuddy Tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-workbuddy-session-list-"));
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const config = upsertAgentBinding(defaultConfig(), "workbuddy", testBinding({ profile: "workbuddy-cn" }));
    const workspace = await workspaces.ensureDefault("workbuddy");
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-desktop-task",
      agentId: "workbuddy",
      runtimeSessionId: "task-native-1",
      name: "Desktop task",
      workspaceRef: workspace.workspaceRef,
      isCurrent: false,
    });
    await store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-connect-only",
      agentId: "workbuddy",
      runtimeSessionId: "codebuddy-session:session-native-1",
      name: "Connect-only work",
      workspaceRef: workspace.workspaceRef,
      isCurrent: true,
    });
    const sessions = await store.listRuntimeSessions("chat-1", "workbuddy");
    const desktopTask = sessions.find((session) => session.sessionId === "session-desktop-task");
    if (!desktopTask) throw new Error("expected desktop Task Session");

    const listed = await handleChatCommand({
      message: message("/sessions"),
      agentId: "workbuddy",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      runtimeFamilyFor: () => "workbuddy",
    });
    expect(listed.text).toContain("Connect-only work");
    expect(listed.text).toContain("CodeBuddy Session · Connect-only");
    expect(listed.text).toContain("Desktop task");
    expect(listed.text).toContain("WorkBuddy Task · desktop-synchronized");

    const switched = await handleChatCommand({
      message: message(`/switch ${desktopTask.sessionRef}`),
      agentId: "workbuddy",
      ownerUserId: "usr",
      config,
      stateStore: store,
      workspaces,
      closeRuntimeSession: mock(async () => true),
      runtimeFamilyFor: () => "workbuddy",
    });
    expect(switched.text).toContain("Switched to Session `Desktop task`");
    await expect(store.getCurrentRuntimeSession("chat-1", "workbuddy")).resolves.toMatchObject({
      sessionId: "session-desktop-task",
      runtimeSessionId: "task-native-1",
    });
    await store.close();
  });
});
