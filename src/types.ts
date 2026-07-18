export const PLATFORM_ID = "clawchat-connect" as const;
export const AGENT_TYPE = "clawbot" as const;

export type OutputVisibility = "minimal" | "normal" | "full";
export type ChatType = "direct" | "group";

export interface AcpAgentConfig {
  kind: "acp";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  processCwd?: string;
  authMethod?: string;
  displayName?: string;
  mode?: string;
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexWebSearchMode = "disabled" | "cached" | "live";

export interface CodexAgentConfig {
  kind: "codex";
  codexPathOverride?: string;
  env?: Record<string, string>;
  displayName?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  modelReasoningEffort?: CodexReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
  webSearchMode?: CodexWebSearchMode;
  networkAccessEnabled?: boolean;
  skipGitRepoCheck?: boolean;
  additionalDirectories?: string[];
}

export type AgentConfig = AcpAgentConfig | CodexAgentConfig;

export interface ConnectConfig {
  baseUrl: string;
  websocketUrl: string;
  mediaBaseUrl?: string;
  stateDbPath: string;
  defaultAgent: string | null;
  outputVisibility: OutputVisibility;
  agents: Record<string, AgentConfig>;
  maxConcurrentTurns?: number;
  maxPendingPerChat?: number;
}

export interface ActivationCredentials {
  localAgentId: string;
  accessToken: string;
  refreshToken: string | null;
  serverAgentId: string | null;
  userId: string;
  ownerUserId: string;
  conversationId: string | null;
}

export interface RuntimeSessionRecord {
  chatId: string;
  sessionId: string;
  agentId: string;
  runtimeSessionId: string | null;
  name: string | null;
  mode: string | null;
  cwd: string | null;
  isCurrent: boolean;
  updatedAt: number;
}

export interface RuntimeStatus {
  updatedAt: number;
  websocketConnected: boolean | null;
  activeAgent: string | null;
  activeChats: number;
  globalRunning: number;
  globalQueued: number;
  recentError: string | null;
}

export type ToolCallStatus = "ok" | "error";
