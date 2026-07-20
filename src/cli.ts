import { resolve } from "node:path";
import { cac } from "cac";
import { type ActivateConnectResult, activateConnect as activateConnectDefault } from "./activation";
import {
  type BackgroundServiceAction,
  manageBackgroundService as manageBackgroundServiceDefault,
} from "./background-service";
import {
  defaultConfig,
  defaultConfigPath,
  getAgentBinding,
  loadConfig,
  saveConfig,
  upsertAgentBinding,
} from "./config";
import { startConnectService as startConnectServiceDefault } from "./connect-service";
import { type AccountProfilePatch, updateAccountProfile as updateAccountProfileDefault } from "./profile";
import { type ConnectStateStore, createStateStore } from "./state";
import type {
  AgentBindingConfig,
  CodexAgentBindingConfig,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexWebSearchMode,
  ConnectConfig,
  OutputVisibility,
} from "./types";

export interface CliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface ConnectCliDeps extends Partial<CliIo> {
  activateConnect?: typeof activateConnectDefault;
  updateAccountProfile?: typeof updateAccountProfileDefault;
  manageBackgroundService?: typeof manageBackgroundServiceDefault;
  startConnectService?: typeof startConnectServiceDefault;
  waitUntilShutdown?: () => Promise<void>;
}

interface AgentCliOptions {
  kind?: string;
  codexPath?: string;
}

const HELP_TEXT = `${[
  "clawchat-connect <command>",
  "",
  "Commands:",
  "  init [--agent <id> --kind codex] [--config <path>]",
  "  agent add <id> --kind codex [--codex-path <path>] [--config <path>]",
  "  agent list [--config <path>]",
  "  agent remove <id> [--config <path>]",
  "  activate <agentId> <code> [--config <path>]",
  "  profile update [--agent <id>] [--nickname <text>] [--avatar-url <url>] [--bio <text>] [--config <path>]",
  "  run [--config <path>]",
  "  service install|start|stop|restart|status [--config <path>]",
  "  service logs [--lines <count>] [--follow] [--config <path>]",
  "  status [--agent <agentId>] [--config <path>]",
  "  config get [key] [--config <path>]",
  "  config set <key> <value> [--config <path>]",
  "  doctor [--config <path>]",
].join("\n")}\n`;

const defaultIo: CliIo = {
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

export async function runConnectCli(argv: string[], deps: ConnectCliDeps = {}): Promise<number> {
  const io: CliIo = {
    writeStdout: deps.writeStdout ?? defaultIo.writeStdout,
    writeStderr: deps.writeStderr ?? defaultIo.writeStderr,
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    io.writeStdout(HELP_TEXT);
    return 0;
  }
  const nestedAgentResult = await maybeRunNestedAgentCommand(argv, io);
  if (nestedAgentResult !== null) return nestedAgentResult;
  const nestedProfileResult = await maybeRunNestedProfileCommand(
    argv,
    io,
    deps.updateAccountProfile ?? updateAccountProfileDefault,
  );
  if (nestedProfileResult !== null) return nestedProfileResult;
  const nestedServiceResult = await maybeRunNestedServiceCommand(
    argv,
    io,
    deps.manageBackgroundService ?? manageBackgroundServiceDefault,
  );
  if (nestedServiceResult !== null) return nestedServiceResult;

  const cli = cac("clawchat-connect");
  let commandRan = false;
  cli
    .command("init", "Create config")
    .option("--config <path>", "Config path")
    .option("--agent <id>", "Agent id")
    .option("--kind <kind>", "Agent kind: codex")
    .option("--codex-path <path>", "Codex executable override")
    .action(async (options: { config?: string; agent?: string; kind?: string; codexPath?: string }) => {
      commandRan = true;
      let config = defaultConfig();
      if (options.agent || options.kind || options.codexPath) {
        if (!options.agent) throw new Error("init requires --agent when agent options are provided");
        config = upsertAgentBinding(config, options.agent, agentBindingFromCli(options));
      }
      io.writeStdout(`Wrote config: ${await saveConfig(config, options.config)}\n`);
    });

  cli
    .command("agent add <id>", "Add/update agent")
    .option("--config <path>", "Config path")
    .option("--kind <kind>", "Agent kind: codex")
    .option("--codex-path <path>", "Codex executable override")
    .action(async (id: string, options: { config?: string; kind?: string; codexPath?: string }) => {
      commandRan = true;
      const config = upsertAgentBinding(await loadConfig(options.config), id, agentBindingFromCli(options));
      io.writeStdout(`Updated agent ${id}: ${await saveConfig(config, options.config)}\n`);
    });

  cli
    .command("agent list", "List agents")
    .option("--config <path>", "Config path")
    .action(async (options: { config?: string }) => {
      commandRan = true;
      const config = await loadConfig(options.config);
      const rows = Object.entries(config.agents).map(([id, agent]) =>
        formatAgentListRow(id, agent, id === config.defaultAgent),
      );
      io.writeStdout(rows.length ? `${rows.join("\n")}\n` : "No agents configured.\n");
    });

  cli
    .command("agent remove <id>", "Remove agent")
    .option("--config <path>", "Config path")
    .action(async (id: string, options: { config?: string }) => {
      commandRan = true;
      const config = await loadConfig(options.config);
      delete config.agents[id];
      if (config.defaultAgent === id) config.defaultAgent = Object.keys(config.agents)[0] ?? null;
      io.writeStdout(`Removed agent ${id}: ${await saveConfig(config, options.config)}\n`);
    });

  cli
    .command("activate <agentId> <code>", "Activate agent")
    .option("--config <path>", "Config path")
    .action(async (agentId: string, code: string, options: { config?: string }) => {
      commandRan = true;
      const result = await (deps.activateConnect ?? activateConnectDefault)({
        agentId,
        code,
        configPath: options.config,
      });
      io.writeStdout(formatActivation(result));
    });

  cli
    .command("run", "Run service")
    .option("--config <path>", "Config path")
    .action(async (options: { config?: string }) => {
      commandRan = true;
      await (deps.startConnectService ?? startConnectServiceDefault)({
        configPath: options.config,
        waitUntilShutdown: deps.waitUntilShutdown,
        writeOutput: io.writeStdout,
        writeError: io.writeStderr,
      });
    });

  cli
    .command("status", "Show status")
    .option("--config <path>", "Config path")
    .option("--agent <id>", "Agent id")
    .action(async (options: { config?: string; agent?: string }) => {
      commandRan = true;
      const config = await loadConfig(options.config);
      const agentId = options.agent ?? config.defaultAgent;
      if (agentId) getAgentBinding(config, agentId);
      const store = createStateStore({ dbPath: config.stateDbPath });
      const activation = agentId ? await store.getActivation(agentId) : null;
      const status = agentId ? await store.getRuntimeStatus(agentId) : null;
      await store.close();
      io.writeStdout(formatStatus(config, agentId, activation !== null, status));
    });

  cli
    .command("config get [key]", "Read config")
    .option("--config <path>", "Config path")
    .action(async (key: string | undefined, options: { config?: string }) => {
      commandRan = true;
      const config = await loadConfig(options.config);
      io.writeStdout(`${JSON.stringify(key ? readConfigValue(config, key) : config, null, 2)}\n`);
    });

  cli
    .command("config set <key> <value>", "Set config")
    .option("--config <path>", "Config path")
    .action(async (key: string, value: string, options: { config?: string }) => {
      commandRan = true;
      const config = await loadConfig(options.config);
      setConfigValue(config, key, value);
      io.writeStdout(`Updated config: ${await saveConfig(config, options.config)}\n`);
    });

  cli
    .command("doctor", "Check config")
    .option("--config <path>", "Config path")
    .action(async (options: { config?: string }) => {
      commandRan = true;
      const config = await loadConfig(options.config);
      const problems = [config.defaultAgent ? null : "defaultAgent is not set"].filter(Boolean);
      io.writeStdout(
        problems.length === 0
          ? "clawchat-connect doctor: ok\n"
          : `clawchat-connect doctor:\n- ${problems.join("\n- ")}\n`,
      );
    });

  try {
    cli.parse(["node", "clawchat-connect", ...argv], { run: false });
    await cli.runMatchedCommand();
    if (!commandRan) {
      io.writeStdout(HELP_TEXT);
      return 1;
    }
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunNestedAgentCommand(argv: string[], io: CliIo): Promise<number | null> {
  if (argv[0] !== "agent") return null;
  const action = argv[1];
  const id = argv[2];
  const configPath = optionValue(argv, "--config");
  try {
    if (action === "add") {
      if (!id) throw new Error("agent id is required");
      const config = upsertAgentBinding(
        await loadConfig(configPath),
        id,
        agentBindingFromCli({
          kind: optionValue(argv, "--kind"),
          codexPath: optionValue(argv, "--codex-path"),
        }),
      );
      io.writeStdout(`Updated agent ${id}: ${await saveConfig(config, configPath)}\n`);
      return 0;
    }
    if (action === "list") {
      const config = await loadConfig(configPath);
      const rows = Object.entries(config.agents).map(([agentId, agent]) =>
        formatAgentListRow(agentId, agent, agentId === config.defaultAgent),
      );
      io.writeStdout(rows.length ? `${rows.join("\n")}\n` : "No agents configured.\n");
      return 0;
    }
    if (action === "remove") {
      if (!id) throw new Error("agent id is required");
      const config = await loadConfig(configPath);
      delete config.agents[id];
      if (config.defaultAgent === id) config.defaultAgent = Object.keys(config.agents)[0] ?? null;
      io.writeStdout(`Removed agent ${id}: ${await saveConfig(config, configPath)}\n`);
      return 0;
    }
    io.writeStdout(HELP_TEXT);
    return 1;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunNestedProfileCommand(
  argv: string[],
  io: CliIo,
  updateAccountProfile: typeof updateAccountProfileDefault,
): Promise<number | null> {
  if (argv[0] !== "profile") return null;
  if (argv[1] !== "update") {
    io.writeStdout(HELP_TEXT);
    return 1;
  }
  try {
    const patch: AccountProfilePatch = {};
    const nickname = optionValue(argv, "--nickname");
    const avatarUrl = optionValue(argv, "--avatar-url");
    const bio = optionValue(argv, "--bio");
    if (nickname !== undefined) patch.nickname = nickname;
    if (avatarUrl !== undefined) patch.avatar_url = avatarUrl;
    if (bio !== undefined) patch.bio = bio;
    if (Object.keys(patch).length === 0)
      throw new Error("profile update requires at least one Profile field: nickname, avatar URL, or bio");
    const result = await updateAccountProfile({
      agentId: optionValue(argv, "--agent"),
      configPath: optionValue(argv, "--config"),
      patch,
    });
    io.writeStdout(`Updated ClawChat Profile for ${result.agentId}.\n`);
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunNestedServiceCommand(
  argv: string[],
  io: CliIo,
  manageBackgroundService: typeof manageBackgroundServiceDefault,
): Promise<number | null> {
  if (argv[0] !== "service") return null;
  try {
    const action = argv[1];
    if (!isBackgroundServiceAction(action)) {
      throw new Error("service action must be one of: install, start, stop, restart, status, logs");
    }
    if (argv.includes("--agent")) {
      throw new Error(
        "the Connect Service manages all activated Agent Bindings; service commands do not accept --agent",
      );
    }
    const configPath = resolve(optionValue(argv, "--config") ?? defaultConfigPath());
    if (action === "install" && Object.keys((await loadConfig(configPath)).agents).length === 0) {
      throw new Error("configure at least one Agent Binding before installing the Connect Service");
    }
    const linesValue = optionValue(argv, "--lines");
    const lines = linesValue === undefined ? undefined : Number(linesValue);
    const result = await manageBackgroundService({
      action,
      configPath,
      ...(lines !== undefined ? { lines } : {}),
      ...(argv.includes("--follow") ? { follow: true } : {}),
    });
    io.writeStdout(result.message);
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isBackgroundServiceAction(value: string | undefined): value is BackgroundServiceAction {
  return (
    value === "install" ||
    value === "start" ||
    value === "stop" ||
    value === "restart" ||
    value === "status" ||
    value === "logs"
  );
}

function agentBindingFromCli(options: AgentCliOptions): AgentBindingConfig {
  const kind = options.kind?.trim().toLowerCase();
  if (kind !== "codex") throw new Error("--kind codex is required");
  return {
    kind: "codex",
    ...(options.codexPath?.trim() ? { codexPathOverride: options.codexPath.trim() } : {}),
  };
}

function formatAgentListRow(id: string, binding: AgentBindingConfig, isDefault: boolean): string {
  const selected = isDefault ? " (default)" : "";
  return `- ${id}${selected}: ${binding.kind}${binding.codexPathOverride ? ` (${binding.codexPathOverride})` : ""}`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function formatActivation(result: ActivateConnectResult): string {
  return `${[
    `ClawChat Connect agent \`${result.localAgentId}\` activated.`,
    `agent user: ${result.userId}`,
    `owner user: ${result.ownerUserId}`,
  ].join("\n")}\n`;
}

function formatStatus(
  config: ConnectConfig,
  agentId: string | null,
  activated: boolean,
  status: Awaited<ReturnType<ConnectStateStore["getRuntimeStatus"]>>,
): string {
  return `${[
    "ClawChat Connect status",
    `agent: ${agentId ?? "not selected"}`,
    `configured agents: ${Object.keys(config.agents).length}`,
    `activated: ${activated ? "yes" : "no"}`,
    `websocket: ${config.websocketUrl}`,
    `runtime: ${status?.websocketConnected === true ? "connected" : status?.websocketConnected === false ? "disconnected" : "unknown"}`,
    `running: ${status?.globalRunning ?? 0}`,
    `queued: ${status?.globalQueued ?? 0}`,
  ].join("\n")}\n`;
}

function readConfigValue(config: ConnectConfig, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) => (value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined),
      config,
    );
}

function setConfigValue(config: ConnectConfig, key: string, value: string): void {
  if (key === "baseUrl") {
    config.baseUrl = value;
    return;
  }
  if (key === "websocketUrl") {
    config.websocketUrl = value;
    return;
  }
  if (key === "defaultAgent") {
    config.defaultAgent = value;
    return;
  }
  if (key === "outputVisibility") {
    config.outputVisibility = parseOutputVisibility(value);
    return;
  }
  const match = key.match(/^agents\.([^.]+)\.([A-Za-z]+)$/u);
  if (!match) throw new Error(`Unsupported config key: ${key}`);
  const agentId = match[1];
  const field = match[2];
  if (!agentId || !field) throw new Error(`Unsupported config key: ${key}`);
  const binding = config.agents[agentId];
  if (!binding) throw new Error(`Unknown clawchat-connect agent: ${agentId}`);
  if (field === "displayName") {
    binding.displayName = value;
    return;
  }
  setCodexConfigValue(binding, field, value, key);
}

function setCodexConfigValue(binding: CodexAgentBindingConfig, field: string, value: string, key: string): void {
  if (field === "codexPathOverride") binding.codexPathOverride = value;
  else if (field === "model") binding.model = value;
  else if (field === "sandboxMode")
    binding.sandboxMode = parseCodexEnum<CodexSandboxMode>(
      value,
      ["read-only", "workspace-write", "danger-full-access"],
      field,
    );
  else if (field === "modelReasoningEffort")
    binding.modelReasoningEffort = parseCodexEnum<CodexReasoningEffort>(
      value,
      ["minimal", "low", "medium", "high", "xhigh"],
      field,
    );
  else if (field === "approvalPolicy")
    binding.approvalPolicy = parseCodexEnum<CodexApprovalPolicy>(
      value,
      ["never", "on-request", "on-failure", "untrusted"],
      field,
    );
  else if (field === "webSearchMode")
    binding.webSearchMode = parseCodexEnum<CodexWebSearchMode>(value, ["disabled", "cached", "live"], field);
  else if (field === "networkAccessEnabled") binding.networkAccessEnabled = parseBoolean(value, field);
  else if (field === "skipGitRepoCheck") binding.skipGitRepoCheck = parseBoolean(value, field);
  else throw new Error(`Unsupported Codex config key: ${key}`);
}

function parseCodexEnum<T extends string>(value: string, values: readonly T[], field: string): T {
  if (values.includes(value as T)) return value as T;
  throw new Error(`${field} must be one of: ${values.join(", ")}`);
}

function parseBoolean(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} must be true or false`);
}

function parseOutputVisibility(value: string): OutputVisibility {
  const mode = value.trim().toLowerCase();
  if (mode === "minimal" || mode === "normal" || mode === "full") return mode;
  throw new Error("outputVisibility must be minimal, normal, or full");
}
