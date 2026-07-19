import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { cac } from "cac";
import { type ActivateConnectResult, activateConnect as activateConnectDefault } from "./activation";
import { handleChatCommand } from "./chat-commands";
import { defaultConfig, defaultConfigPath, getAgent, loadConfig, saveConfig, upsertAgent } from "./config";
import { startMcpStdioServer as startMcpStdioServerDefault } from "./mcp/server";
import { buildTextMessagePayload } from "./message-mapper";
import { ProjectCatalog } from "./projects";
import { EVENT, type NormalizedInboundMessage } from "./protocol";
import { ConnectRuntime } from "./runtime/connect-runtime";
import { type ConnectStateStore, createStateStore } from "./state";
import type {
  AgentConfig,
  CodexAgentConfig,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexWebSearchMode,
  ConnectConfig,
  OutputVisibility,
} from "./types";
import { ConnectWsClient } from "./ws-client";

export interface CliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface StartServiceResult {
  connected: boolean;
  websocketUrl: string;
  deviceId: string;
  agentId: string;
}

export interface ConnectCliDeps extends Partial<CliIo> {
  activateConnect?: typeof activateConnectDefault;
  startService?: (options: StartServiceOptions) => Promise<StartServiceResult>;
  startMcpStdioServer?: typeof startMcpStdioServerDefault;
  waitUntilShutdown?: () => Promise<void>;
}

export interface StartServiceOptions {
  agentId?: string;
  configPath?: string;
  config?: ConnectConfig;
  stateStore?: ConnectStateStore;
  waitUntilShutdown?: () => Promise<void>;
  io?: CliIo;
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
  "  run --agent <agentId> [--config <path>]",
  "  mcp-server --agent <agentId> [--config <path>]",
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
        config = upsertAgent(config, options.agent, agentConfigFromCli(options));
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
      const config = upsertAgent(await loadConfig(options.config), id, agentConfigFromCli(options));
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
    .option("--agent <id>", "Agent id")
    .action(async (options: { config?: string; agent?: string }) => {
      commandRan = true;
      const result = await (deps.startService ?? startConnectService)({
        agentId: options.agent,
        configPath: options.config,
        waitUntilShutdown: deps.waitUntilShutdown,
        io,
      });
      io.writeStdout(`Connected ${result.agentId} to ${result.websocketUrl} as ${result.deviceId}\n`);
    });

  cli
    .command("mcp-server", "Run stdio MCP server")
    .option("--config <path>", "Config path")
    .option("--agent <id>", "Agent id")
    .action(async (options: { config?: string; agent?: string }) => {
      commandRan = true;
      await (deps.startMcpStdioServer ?? startMcpStdioServerDefault)({
        agentId: options.agent,
        configPath: options.config,
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
      if (agentId) getAgent(config, agentId);
      const store = createStateStore({ dbPath: config.stateDbPath });
      const activation = agentId ? await store.getActivation(agentId) : null;
      const status = await store.getRuntimeStatus();
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

export async function startConnectService(options: StartServiceOptions): Promise<StartServiceResult> {
  const io = options.io ?? defaultIo;
  const configPath = resolve(options.configPath ?? defaultConfigPath());
  const config = options.config ?? (await loadConfig(configPath));
  const agentId = options.agentId ?? config.defaultAgent;
  if (!agentId) throw new Error("agent is required; pass --agent or configure defaultAgent");
  getAgent(config, agentId);
  const store = options.stateStore ?? createStateStore({ dbPath: config.stateDbPath });
  const activation = await store.getActivation(agentId);
  if (!activation)
    throw new Error(
      `clawchat-connect agent ${agentId} is not activated; run \`clawchat-connect activate ${agentId} <code>\` first`,
    );
  const deviceId = (await store.getDeviceId()) ?? randomUUID();
  await store.setDeviceId(deviceId);
  const wsClient = new ConnectWsClient({
    url: config.websocketUrl,
    token: activation.accessToken,
    stateStore: store,
    deviceId,
  });
  const projects = new ProjectCatalog(store);
  const runtime = new ConnectRuntime({ agentId, config, configPath, stateStore: store, wsClient, projects });
  wsClient.on("message", (message: NormalizedInboundMessage) => {
    void dispatchInboundMessage({
      message,
      agentId,
      ownerUserId: activation.ownerUserId,
      config,
      store,
      wsClient,
      runtime,
      projects,
    }).catch((error) => io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`));
  });
  await wsClient.connect();
  await store.upsertRuntimeStatus({
    websocketConnected: true,
    activeAgent: agentId,
    activeChats: 0,
    globalRunning: 0,
    globalQueued: 0,
    recentError: null,
  });
  await (options.waitUntilShutdown ?? waitForShutdown)();
  wsClient.close();
  await runtime.dispose();
  await store.close();
  return { connected: true, websocketUrl: config.websocketUrl, deviceId, agentId };
}

async function dispatchInboundMessage(params: {
  message: NormalizedInboundMessage;
  agentId: string;
  ownerUserId: string;
  config: ConnectConfig;
  store: ConnectStateStore;
  wsClient: ConnectWsClient;
  runtime: ConnectRuntime;
  projects: ProjectCatalog;
}): Promise<void> {
  const routeCommand = async (): Promise<boolean> => {
    const command = await handleChatCommand({
      message: params.message,
      agentId: params.agentId,
      ownerUserId: params.ownerUserId,
      config: params.config,
      stateStore: params.store,
      projects: params.projects,
      closeRuntimeSession: (chatId) => params.runtime.closeSession(chatId),
      invalidateRuntimeSession: (chatId) => params.runtime.invalidateSession(chatId),
      cancelRuntimeTurn: (chatId) => params.runtime.cancelTurn(chatId),
    });
    if (!command.handled) return false;
    if (command.text) {
      await params.wsClient.sendMessageEnvelope(
        EVENT.MESSAGE_REPLY,
        params.message.chatId,
        buildTextMessagePayload(command.text),
        { toType: params.message.chatType },
      );
    }
    return true;
  };
  if (params.message.text.trim().split(/\s+/u)[0] === "/cancel") {
    await routeCommand();
    return;
  }
  await params.runtime.handleInboundMessage(params.message, routeCommand);
}

async function maybeRunNestedAgentCommand(argv: string[], io: CliIo): Promise<number | null> {
  if (argv[0] !== "agent") return null;
  const action = argv[1];
  const id = argv[2];
  const configPath = optionValue(argv, "--config");
  try {
    if (action === "add") {
      if (!id) throw new Error("agent id is required");
      const config = upsertAgent(
        await loadConfig(configPath),
        id,
        agentConfigFromCli({
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

function agentConfigFromCli(options: AgentCliOptions): AgentConfig {
  const kind = options.kind?.trim().toLowerCase();
  if (kind !== "codex") throw new Error("--kind codex is required");
  return {
    kind: "codex",
    ...(options.codexPath?.trim() ? { codexPathOverride: options.codexPath.trim() } : {}),
  };
}

function formatAgentListRow(id: string, agent: AgentConfig, isDefault: boolean): string {
  const selected = isDefault ? " (default)" : "";
  return `- ${id}${selected}: codex-sdk${agent.codexPathOverride ? ` (${agent.codexPathOverride})` : ""}`;
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
  if (key === "mediaBaseUrl") {
    config.mediaBaseUrl = value;
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
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown clawchat-connect agent: ${agentId}`);
  if (field === "displayName") {
    agent.displayName = value;
    return;
  }
  setCodexConfigValue(agent, field, value, key);
}

function setCodexConfigValue(agent: CodexAgentConfig, field: string, value: string, key: string): void {
  if (field === "codexPathOverride") agent.codexPathOverride = value;
  else if (field === "model") agent.model = value;
  else if (field === "sandboxMode")
    agent.sandboxMode = parseCodexEnum<CodexSandboxMode>(
      value,
      ["read-only", "workspace-write", "danger-full-access"],
      field,
    );
  else if (field === "modelReasoningEffort")
    agent.modelReasoningEffort = parseCodexEnum<CodexReasoningEffort>(
      value,
      ["minimal", "low", "medium", "high", "xhigh"],
      field,
    );
  else if (field === "approvalPolicy")
    agent.approvalPolicy = parseCodexEnum<CodexApprovalPolicy>(
      value,
      ["never", "on-request", "on-failure", "untrusted"],
      field,
    );
  else if (field === "webSearchMode")
    agent.webSearchMode = parseCodexEnum<CodexWebSearchMode>(value, ["disabled", "cached", "live"], field);
  else if (field === "networkAccessEnabled") agent.networkAccessEnabled = parseBoolean(value, field);
  else if (field === "skipGitRepoCheck") agent.skipGitRepoCheck = parseBoolean(value, field);
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

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}
