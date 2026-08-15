import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { normalizePluginAgentBinding } from "./plugin/binding";
import { normalizeReleasedAgentBinding } from "./runtime/released-adapters";
import type { AgentBindingConfig, ClientHost, ConnectConfig, LivewareAccessPolicy, OutputVisibility } from "./types";

export { DEFAULT_CODEX_APPROVAL_POLICY } from "./runtime/released-adapters";

export const DEFAULT_BASE_URL = "https://app.clawling.com" as const;
export const DEFAULT_WEBSOCKET_URL = "wss://app.clawling.com/ws" as const;
export const DEFAULT_MEDIA_UPLOAD_URL = "https://app.clawling.com/media/upload" as const;
export const DEFAULT_CLIENT_PORT = 47_823 as const;
export const DEFAULT_CLIENT_HOST = "127.0.0.1" as const;
const CLIENT_HOSTS = new Set<ClientHost>(["127.0.0.1", "0.0.0.0"]);
const LIVEWARE_ACCESS_POLICIES = new Set<LivewareAccessPolicy>(["off", "private", "public"]);

export function defaultDataDir(): string {
  return join(homedir(), ".clawchat-connect");
}

export function defaultConfigPath(): string {
  return process.env.CLAWCHAT_CONNECT_CONFIG || join(defaultDataDir(), "config.json");
}

export function defaultStateDbPath(): string {
  return requireAbsolutePath(
    process.env.CLAWCHAT_CONNECT_STATE_DB || join(defaultDataDir(), "state.sqlite"),
    "stateDbPath",
  );
}

function isOutputVisibility(value: unknown): value is OutputVisibility {
  return value === "minimal" || value === "normal" || value === "full";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAgentBinding(agentId: string, raw: unknown): AgentBindingConfig {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw && raw.kind === "plugin") {
    return normalizePluginAgentBinding(agentId, raw);
  }
  return normalizeReleasedAgentBinding(agentId, raw);
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

function readOptionalEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T | undefined {
  if (value === undefined) return undefined;
  const text = readString(value) as T;
  if (!allowed.has(text)) throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
  return text;
}

export function defaultConfig(): ConnectConfig {
  return {
    baseUrl: DEFAULT_BASE_URL,
    websocketUrl: DEFAULT_WEBSOCKET_URL,
    mediaUploadUrl: DEFAULT_MEDIA_UPLOAD_URL,
    stateDbPath: defaultStateDbPath(),
    defaultAgent: null,
    outputVisibility: "normal",
    agents: {},
    clientHost: DEFAULT_CLIENT_HOST,
    clientPort: DEFAULT_CLIENT_PORT,
    livewareAccessPolicy: "private",
  };
}

export function normalizeConfig(raw: unknown): ConnectConfig {
  const fallback = defaultConfig();
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const baseUrl = readString(record.baseUrl) || fallback.baseUrl;
  const rawAgents =
    record.agents && typeof record.agents === "object" && !Array.isArray(record.agents)
      ? (record.agents as Record<string, unknown>)
      : {};
  const agents: Record<string, AgentBindingConfig> = {};
  for (const [agentId, value] of Object.entries(rawAgents)) {
    const id = agentId.trim();
    if (id) agents[id] = normalizeAgentBinding(id, value);
  }
  const firstAgent = Object.keys(agents)[0] ?? null;
  const requestedDefault = readString(record.defaultAgent) || null;
  const defaultAgent = requestedDefault && agents[requestedDefault] ? requestedDefault : firstAgent;
  const configuredMediaUploadUrl = readString(record.mediaUploadUrl);
  const mediaUploadUrl =
    !configuredMediaUploadUrl || (configuredMediaUploadUrl === fallback.mediaUploadUrl && baseUrl !== fallback.baseUrl)
      ? new URL("/media/upload", baseUrl).toString()
      : configuredMediaUploadUrl;
  return {
    baseUrl,
    websocketUrl: readString(record.websocketUrl) || fallback.websocketUrl,
    mediaUploadUrl,
    stateDbPath: requireAbsolutePath(readString(record.stateDbPath) || fallback.stateDbPath, "stateDbPath"),
    defaultAgent,
    outputVisibility: isOutputVisibility(record.outputVisibility) ? record.outputVisibility : fallback.outputVisibility,
    agents,
    clientHost: readOptionalEnum(record.clientHost, CLIENT_HOSTS, "clientHost") ?? fallback.clientHost,
    clientPort:
      typeof record.clientPort === "number" &&
      Number.isInteger(record.clientPort) &&
      record.clientPort >= 1_024 &&
      record.clientPort <= 65_535
        ? record.clientPort
        : fallback.clientPort,
    livewareAccessPolicy:
      readOptionalEnum(record.livewareAccessPolicy, LIVEWARE_ACCESS_POLICIES, "livewareAccessPolicy") ??
      fallback.livewareAccessPolicy,
    ...(typeof record.maxConcurrentTurns === "number" && Number.isFinite(record.maxConcurrentTurns)
      ? { maxConcurrentTurns: Math.max(1, Math.trunc(record.maxConcurrentTurns)) }
      : {}),
    ...(typeof record.maxPendingPerSession === "number" && Number.isFinite(record.maxPendingPerSession)
      ? { maxPendingPerSession: Math.max(1, Math.trunc(record.maxPendingPerSession)) }
      : {}),
  };
}

export async function loadConfig(path = defaultConfigPath()): Promise<ConnectConfig> {
  if (!existsSync(path)) return defaultConfig();
  return normalizeConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export async function saveConfig(config: ConnectConfig, path = defaultConfigPath()): Promise<string> {
  const normalized = normalizeConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await chmod(tempPath, 0o600).catch(() => undefined);
  await rename(tempPath, path);
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export function getAgentBinding(config: ConnectConfig, agentId = config.defaultAgent): AgentBindingConfig {
  if (!agentId) {
    throw new Error("No clawchat-connect agent is configured; run `clawchat-connect agent add <id> --kind codex`.");
  }
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown clawchat-connect agent: ${agentId}`);
  return {
    ...agent,
    env: {
      ...(agent.env ?? {}),
      CLAWCHAT_CONNECT_AGENT_ID: agentId,
    },
  };
}

export function upsertAgentBinding(config: ConnectConfig, agentId: string, binding: AgentBindingConfig): ConnectConfig {
  const id = agentId.trim();
  if (!id) throw new Error("agent id is required");
  return normalizeConfig({
    ...config,
    defaultAgent: config.defaultAgent || id,
    agents: { ...config.agents, [id]: normalizeAgentBinding(id, binding) },
  });
}
