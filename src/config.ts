import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

export const DEFAULT_BASE_URL = "https://app.clawling.com" as const;
export const DEFAULT_WEBSOCKET_URL = "wss://app.clawling.com/ws" as const;

const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const CODEX_APPROVAL_POLICIES = new Set<CodexApprovalPolicy>(["never", "on-request", "on-failure", "untrusted"]);
const CODEX_WEB_SEARCH_MODES = new Set<CodexWebSearchMode>(["disabled", "cached", "live"]);

export function defaultDataDir(): string {
  return join(homedir(), ".clawchat-connect");
}

export function defaultConfigPath(): string {
  return process.env.CLAWCHAT_CONNECT_CONFIG || join(defaultDataDir(), "config.json");
}

export function defaultStateDbPath(): string {
  return process.env.CLAWCHAT_CONNECT_STATE_DB || join(defaultDataDir(), "state.sqlite");
}

function isOutputVisibility(value: unknown): value is OutputVisibility {
  return value === "minimal" || value === "normal" || value === "full";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => readString(item)).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function readEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    env[name] = typeof raw === "string" ? raw : String(raw ?? "");
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function normalizeAgent(agentId: string, raw: unknown): AgentConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return shouldUseFirstPartyCodex(agentId, record) ? normalizeCodexAgent(record) : normalizeAcpAgent(record);
}

function normalizeAcpAgent(record: Record<string, unknown>): AgentConfig {
  const args = readStringArray(record.args);
  const env = readEnv(record.env);
  return {
    kind: "acp",
    command: readString(record.command),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(readString(record.processCwd) ? { processCwd: resolve(readString(record.processCwd)) } : {}),
    ...(readString(record.authMethod) ? { authMethod: readString(record.authMethod) } : {}),
    ...(readString(record.displayName) ? { displayName: readString(record.displayName) } : {}),
    ...(readString(record.mode) ? { mode: readString(record.mode) } : {}),
  };
}

function normalizeCodexAgent(record: Record<string, unknown>): CodexAgentConfig {
  const env = readEnv(record.env);
  const additionalDirectories = readStringArray(record.additionalDirectories)?.map((path) => resolve(path));
  const sandboxMode = readEnum(record.sandboxMode ?? record.mode, CODEX_SANDBOX_MODES);
  const modelReasoningEffort = readEnum(record.modelReasoningEffort, CODEX_REASONING_EFFORTS);
  const approvalPolicy = readEnum(record.approvalPolicy, CODEX_APPROVAL_POLICIES);
  const webSearchMode = readEnum(record.webSearchMode, CODEX_WEB_SEARCH_MODES);
  return {
    kind: "codex",
    ...(readString(record.codexPathOverride) ? { codexPathOverride: readString(record.codexPathOverride) } : {}),
    ...(env ? { env } : {}),
    ...(readString(record.displayName) ? { displayName: readString(record.displayName) } : {}),
    ...(readString(record.model) ? { model: readString(record.model) } : {}),
    ...(sandboxMode ? { sandboxMode } : {}),
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(webSearchMode ? { webSearchMode } : {}),
    ...(typeof record.networkAccessEnabled === "boolean" ? { networkAccessEnabled: record.networkAccessEnabled } : {}),
    ...(typeof record.skipGitRepoCheck === "boolean" ? { skipGitRepoCheck: record.skipGitRepoCheck } : {}),
    ...(additionalDirectories ? { additionalDirectories } : {}),
  };
}

function readEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  const text = readString(value) as T;
  return allowed.has(text) ? text : undefined;
}

function shouldUseFirstPartyCodex(agentId: string, record: Record<string, unknown>): boolean {
  if (record.kind === "codex") return true;
  if (agentId !== "codex" || (record.kind !== undefined && record.kind !== "acp")) return false;
  const command = readString(record.command);
  const args = readStringArray(record.args) ?? [];
  if (!command && args.length === 0) return true;
  if ((command === "codex" || command === "codex-acp") && args.length === 0) return true;
  if ((command === "npx" || command === "npx.cmd") && isCodexAcpArgs(args)) return true;
  return false;
}

function isCodexAcpArgs(args: string[]): boolean {
  return (
    args.length > 0 &&
    args.every((arg) => arg === "-y" || arg === "--yes" || arg === "@agentclientprotocol/codex-acp") &&
    args.includes("@agentclientprotocol/codex-acp")
  );
}

export function defaultConfig(): ConnectConfig {
  return {
    baseUrl: DEFAULT_BASE_URL,
    websocketUrl: DEFAULT_WEBSOCKET_URL,
    mediaBaseUrl: DEFAULT_BASE_URL,
    stateDbPath: defaultStateDbPath(),
    defaultAgent: null,
    outputVisibility: "normal",
    agents: {},
  };
}

export function normalizeConfig(raw: unknown): ConnectConfig {
  const fallback = defaultConfig();
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawAgents =
    record.agents && typeof record.agents === "object" && !Array.isArray(record.agents)
      ? (record.agents as Record<string, unknown>)
      : {};
  const agents: Record<string, AgentConfig> = {};
  for (const [agentId, value] of Object.entries(rawAgents)) {
    const id = agentId.trim();
    if (id) agents[id] = normalizeAgent(id, value);
  }
  const firstAgent = Object.keys(agents)[0] ?? null;
  const requestedDefault = readString(record.defaultAgent) || null;
  const defaultAgent = requestedDefault && agents[requestedDefault] ? requestedDefault : firstAgent;
  return {
    baseUrl: readString(record.baseUrl) || fallback.baseUrl,
    websocketUrl: readString(record.websocketUrl) || fallback.websocketUrl,
    mediaBaseUrl: readString(record.mediaBaseUrl) || fallback.mediaBaseUrl,
    stateDbPath: readString(record.stateDbPath) || fallback.stateDbPath,
    defaultAgent,
    outputVisibility: isOutputVisibility(record.outputVisibility) ? record.outputVisibility : fallback.outputVisibility,
    agents,
    ...(typeof record.maxConcurrentTurns === "number" && Number.isFinite(record.maxConcurrentTurns)
      ? { maxConcurrentTurns: Math.max(1, Math.trunc(record.maxConcurrentTurns)) }
      : {}),
    ...(typeof record.maxPendingPerChat === "number" && Number.isFinite(record.maxPendingPerChat)
      ? { maxPendingPerChat: Math.max(1, Math.trunc(record.maxPendingPerChat)) }
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

export function getAgent(config: ConnectConfig, agentId = config.defaultAgent): AgentConfig {
  if (!agentId) {
    throw new Error(
      "No clawchat-connect agent is configured; run `clawchat-connect init --agent codex` or `clawchat-connect agent add <id> --command <command>`.",
    );
  }
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown clawchat-connect agent: ${agentId}`);
  if (agent.kind === "acp" && !agent.command.trim()) {
    throw new Error(`clawchat-connect ACP agent ${agentId} is missing command`);
  }
  return agent;
}

export function upsertAgent(config: ConnectConfig, agentId: string, agent: AgentConfig): ConnectConfig {
  const id = agentId.trim();
  if (!id) throw new Error("agent id is required");
  config.agents[id] = normalizeAgent(id, agent);
  if (!config.defaultAgent) config.defaultAgent = id;
  return normalizeConfig(config);
}
