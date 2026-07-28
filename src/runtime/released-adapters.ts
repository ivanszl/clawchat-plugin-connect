import { isAbsolute } from "node:path";
import type {
  AgentBindingConfig,
  CodexAgentBindingConfig,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexWebSearchMode,
} from "../types";
import { createCodexRuntimeAdapter } from "./codex-adapter";
import { RuntimeAdapterRegistry } from "./registry";
import type { ConnectRuntimeAdapter } from "./types";

export const DEFAULT_CODEX_APPROVAL_POLICY = "on-request" as const;

export interface ReleasedRuntimeAdapterMetadata {
  kind: AgentBindingConfig["kind"];
  displayName: string;
}

interface ReleasedRuntimeAdapterDefinition {
  metadata: ReleasedRuntimeAdapterMetadata;
  normalize(record: Record<string, unknown>): AgentBindingConfig;
  create(): ConnectRuntimeAdapter;
}

const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const CODEX_APPROVAL_POLICIES = new Set<CodexApprovalPolicy>(["never", "on-request", "untrusted"]);
const CODEX_WEB_SEARCH_MODES = new Set<CodexWebSearchMode>(["disabled", "cached", "live"]);

const RELEASED_RUNTIME_ADAPTERS: readonly ReleasedRuntimeAdapterDefinition[] = [
  {
    metadata: { kind: "codex", displayName: "Codex" },
    normalize: normalizeCodexAgentBinding,
    create: createCodexRuntimeAdapter,
  },
];

export function releasedRuntimeAdapters(): readonly ReleasedRuntimeAdapterMetadata[] {
  return RELEASED_RUNTIME_ADAPTERS.map((definition) => definition.metadata);
}

export function createReleasedAgentBinding(
  kind: string | undefined,
  options: { executablePath?: string } = {},
): AgentBindingConfig {
  const normalizedKind = kind?.trim().toLowerCase() ?? "";
  return normalizeReleasedAgentBinding("CLI", {
    kind: normalizedKind,
    ...(options.executablePath?.trim() ? { codexPathOverride: options.executablePath.trim() } : {}),
  });
}

export function normalizeReleasedAgentBinding(agentId: string, raw: unknown): AgentBindingConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const kind = readString(record.kind);
  const definition = RELEASED_RUNTIME_ADAPTERS.find((candidate) => candidate.metadata.kind === kind);
  if (!definition) {
    throw new Error(`Agent Binding ${agentId} Runtime kind is not supported in this release: ${kind || "(missing)"}`);
  }
  return definition.normalize(record);
}

export function createReleasedRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  return new RuntimeAdapterRegistry(RELEASED_RUNTIME_ADAPTERS.map((definition) => definition.create()));
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
    approvalPolicy: approvalPolicy ?? DEFAULT_CODEX_APPROVAL_POLICY,
    ...(webSearchMode ? { webSearchMode } : {}),
    ...(networkAccessEnabled !== undefined ? { networkAccessEnabled } : {}),
    ...(additionalDirectories ? { additionalDirectories } : {}),
  };
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

function readAbsolutePathArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of absolute paths`);
  const paths = value.map((item, index) => {
    const path = readString(item);
    if (!path) throw new Error(`${label}[${index}] must be a non-empty absolute path`);
    if (!isAbsolute(path)) throw new Error(`${label}[${index}] must be an absolute path`);
    return path;
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
