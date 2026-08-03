import { isAbsolute } from "node:path";
import type {
  AgentBindingConfig,
  CodexAgentBindingConfig,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexWebSearchMode,
  OutputVisibility,
  WorkBuddyAgentBindingConfig,
} from "../types";
import { createCodexRuntimeAdapter } from "./codex-adapter";
import { createOpenCodeRuntimeAdapter } from "./opencode-adapter";
import { RuntimeAdapterRegistry } from "./registry";
import type { ConnectRuntimeAdapter } from "./types";
import { createWorkBuddyRuntimeAdapter } from "./workbuddy-adapter";
import {
  WORKBUDDY_AI_COMPATIBILITY,
  WORKBUDDY_CN_COMPATIBILITY,
  type WorkBuddyProfileCompatibility,
} from "./workbuddy-task-discovery";

export const DEFAULT_CODEX_APPROVAL_POLICY = "on-request" as const;

export interface ReleasedRuntimeAdapterMetadata {
  kind: AgentBindingConfig["kind"];
  displayName: string;
  profiles: readonly ReleasedRuntimeAdapterProfileMetadata[];
}

export interface ReleasedRuntimeAdapterProfileMetadata {
  id: string;
  displayName: string;
  applicationVersion: string;
  embeddedRuntime: { name: string; version: string };
  protocol: { name: string; version: number };
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
const OUTPUT_VISIBILITIES = new Set<OutputVisibility>(["minimal", "normal", "full"]);
const WORKBUDDY_PROFILE_METADATA = [
  releasedWorkBuddyProfile(WORKBUDDY_AI_COMPATIBILITY),
  releasedWorkBuddyProfile(WORKBUDDY_CN_COMPATIBILITY),
] as const;
const WORKBUDDY_PROFILES = new Set<WorkBuddyAgentBindingConfig["profile"]>(
  WORKBUDDY_PROFILE_METADATA.map((profile) => profile.id),
);

const RELEASED_RUNTIME_ADAPTERS: readonly ReleasedRuntimeAdapterDefinition[] = [
  {
    metadata: { kind: "codex", displayName: "Codex", profiles: [] },
    normalize: normalizeCodexAgentBinding,
    create: createCodexRuntimeAdapter,
  },
  {
    metadata: { kind: "opencode", displayName: "OpenCode", profiles: [] },
    normalize: normalizeOpenCodeAgentBinding,
    create: createOpenCodeRuntimeAdapter,
  },
  {
    metadata: { kind: "workbuddy", displayName: "WorkBuddy", profiles: WORKBUDDY_PROFILE_METADATA },
    normalize: normalizeWorkBuddyAgentBinding,
    create: createWorkBuddyRuntimeAdapter,
  },
];

export function releasedRuntimeAdapters(): readonly ReleasedRuntimeAdapterMetadata[] {
  return RELEASED_RUNTIME_ADAPTERS.map((definition) => definition.metadata);
}

export function createReleasedAgentBinding(
  kind: string | undefined,
  options: { executablePath?: string; profile?: string } = {},
): AgentBindingConfig {
  const normalizedKind = kind?.trim().toLowerCase() ?? "";
  return normalizeReleasedAgentBinding("CLI", {
    kind: normalizedKind,
    ...(options.profile?.trim() ? { profile: options.profile.trim() } : {}),
    ...(options.executablePath?.trim() ? { executablePathOverride: options.executablePath.trim() } : {}),
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
  return new RuntimeAdapterRegistry(
    RELEASED_RUNTIME_ADAPTERS.map((definition) => ({
      kind: definition.metadata.kind,
      create: definition.create,
    })),
  );
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
  const outputVisibility = readOptionalEnum(record.outputVisibility, OUTPUT_VISIBILITIES, "outputVisibility");
  return {
    kind: "codex",
    ...(readString(record.executablePathOverride)
      ? { executablePathOverride: readString(record.executablePathOverride) }
      : {}),
    ...(outputVisibility ? { outputVisibility } : {}),
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

const OPENCODE_MANAGED_ENV = new Set([
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_HOSTNAME",
  "OPENCODE_SERVER_PORT",
  "OPENCODE_SERVER_CORS",
  "OPENCODE_SERVER_MDNS",
]);

function normalizeOpenCodeAgentBinding(record: Record<string, unknown>): AgentBindingConfig {
  const env = readEnv(record.env);
  const outputVisibility = readOptionalEnum(record.outputVisibility, OUTPUT_VISIBILITIES, "outputVisibility");
  for (const name of Object.keys(env ?? {})) {
    if (OPENCODE_MANAGED_ENV.has(name)) throw new Error(`${name} is managed by Connect`);
  }
  const sessionOptions = readStringRecord(record.sessionOptions, "sessionOptions");
  return {
    kind: "opencode",
    ...(readString(record.executablePathOverride)
      ? { executablePathOverride: readString(record.executablePathOverride) }
      : {}),
    ...(outputVisibility ? { outputVisibility } : {}),
    ...(env ? { env } : {}),
    ...(readString(record.displayName) ? { displayName: readString(record.displayName) } : {}),
    ...(readAbsolutePathArray(record.additionalDirectories, "additionalDirectories")
      ? { additionalDirectories: readAbsolutePathArray(record.additionalDirectories, "additionalDirectories") }
      : {}),
    ...(sessionOptions ? { sessionOptions } : {}),
  };
}

function normalizeWorkBuddyAgentBinding(record: Record<string, unknown>): WorkBuddyAgentBindingConfig {
  const allowedFields = new Set(["kind", "profile", "outputVisibility", "displayName"]);
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      throw new Error(`WorkBuddy Agent Binding field is managed by the selected desktop distribution: ${field}`);
    }
  }
  const profile = readString(record.profile) as WorkBuddyAgentBindingConfig["profile"];
  if (!WORKBUDDY_PROFILES.has(profile)) {
    throw new Error("WorkBuddy profile must be explicitly set to one of: workbuddy-ai, workbuddy-cn");
  }
  const outputVisibility = readOptionalEnum(record.outputVisibility, OUTPUT_VISIBILITIES, "outputVisibility");
  return {
    kind: "workbuddy",
    profile,
    ...(outputVisibility ? { outputVisibility } : {}),
    ...(readString(record.displayName) ? { displayName: readString(record.displayName) } : {}),
  };
}

function releasedWorkBuddyProfile(
  compatibility: WorkBuddyProfileCompatibility,
): ReleasedRuntimeAdapterProfileMetadata & { id: WorkBuddyAgentBindingConfig["profile"] } {
  return {
    id: compatibility.profile,
    displayName: compatibility.displayName,
    applicationVersion: compatibility.applicationVersion,
    embeddedRuntime: { name: "CodeBuddy", version: compatibility.embeddedCodeBuddyVersion },
    protocol: { name: "ACP", version: compatibility.acpVersion },
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

function readStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    const text = readString(rawValue);
    if (!key || !text) throw new Error(`${label} keys and values must be non-empty strings`);
    result[key] = text;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
