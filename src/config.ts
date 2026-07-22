import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  AgentBindingConfig,
  ClientHost,
  CodexAgentBindingConfig,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexWebSearchMode,
  ConnectConfig,
  OutputVisibility,
} from "./types";

export const DEFAULT_BASE_URL = "https://app.clawling.com" as const;
export const DEFAULT_WEBSOCKET_URL = "wss://app.clawling.com/ws" as const;
export const DEFAULT_MEDIA_UPLOAD_URL = "https://app.clawling.com/media/upload" as const;
export const DEFAULT_CLIENT_PORT = 47_823 as const;
export const DEFAULT_CLIENT_HOST = "127.0.0.1" as const;

const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const CODEX_APPROVAL_POLICIES = new Set<CodexApprovalPolicy>(["never", "on-request", "untrusted"]);
const CODEX_WEB_SEARCH_MODES = new Set<CodexWebSearchMode>(["disabled", "cached", "live"]);
const CLIENT_HOSTS = new Set<ClientHost>(["127.0.0.1", "0.0.0.0"]);

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

function normalizeAgentBinding(agentId: string, raw: unknown): AgentBindingConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (record.kind !== "codex")
    throw new Error(
      `Agent Binding ${agentId} Runtime kind is not supported in this release: ${readString(record.kind) || "(missing)"}`,
    );
  return normalizeCodexAgentBinding(record);
}

function normalizeCodexAgentBinding(record: Record<string, unknown>): CodexAgentBindingConfig {
  for (const field of ["command", "args", "processCwd", "authMethod", "mode", "skipGitRepoCheck"]) {
    if (field in record) throw new Error(`legacy agent config field is not supported: ${field}`);
  }
  const env = readEnv(record.env);
  const additionalDirectories = readAbsolutePathArray(record.additionalDirectories, "additionalDirectories");
  const sandboxMode = readOptionalEnum(record.sandboxMode, CODEX_SANDBOX_MODES, "sandboxMode");
  const modelReasoningEffort = readOptionalEnum(
    record.modelReasoningEffort,
    CODEX_REASONING_EFFORTS,
    "modelReasoningEffort",
  );
  const approvalPolicy = readOptionalEnum(record.approvalPolicy, CODEX_APPROVAL_POLICIES, "approvalPolicy");
  const webSearchMode = readOptionalEnum(record.webSearchMode, CODEX_WEB_SEARCH_MODES, "webSearchMode");
  const networkAccessEnabled = readOptionalBoolean(record.networkAccessEnabled, "networkAccessEnabled");
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
    ...(networkAccessEnabled !== undefined ? { networkAccessEnabled } : {}),
    ...(additionalDirectories ? { additionalDirectories } : {}),
  };
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

function readAbsolutePathArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of absolute paths`);
  const paths = value.map((item, index) => {
    const path = readString(item);
    if (!path) throw new Error(`${label}[${index}] must be a non-empty absolute path`);
    return requireAbsolutePath(path, `${label}[${index}]`);
  });
  return paths.length > 0 ? [...new Set(paths)] : undefined;
}

function readOptionalEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T | undefined {
  if (value === undefined) return undefined;
  const text = readString(value) as T;
  if (!allowed.has(text)) throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
  return text;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
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
  const ownersByKind = new Map<string, string>();
  for (const [agentId, binding] of Object.entries(agents)) {
    const existing = ownersByKind.get(binding.kind);
    if (existing) {
      throw new Error(
        `Runtime kind ${binding.kind} may be configured only once (Agent Bindings: ${existing}, ${agentId})`,
      );
    }
    ownersByKind.set(binding.kind, agentId);
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

export function getAgentBinding(config: ConnectConfig, agentId = config.defaultAgent): AgentBindingConfig {
  if (!agentId) {
    throw new Error("No clawchat-connect agent is configured; run `clawchat-connect agent add <id> --kind codex`.");
  }
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown clawchat-connect agent: ${agentId}`);
  return agent;
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
