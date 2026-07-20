export const PLATFORM_ID = "clawchat-connect" as const;
export const AGENT_TYPE = "clawbot" as const;

export type OutputVisibility = "minimal" | "normal" | "full";
export type ChatType = "direct" | "group";

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

export type AgentConfig = CodexAgentConfig;

export interface ConnectConfig {
  baseUrl: string;
  websocketUrl: string;
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

export interface ProjectRecord {
  projectId: string;
  name: string;
  rootPath: string;
  additionalDirectories: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeWorkspace {
  projectId: string | null;
  workingDirectory: string;
  additionalDirectories: string[];
  skipGitRepoCheck: boolean;
}

export interface RuntimeSessionRecord {
  chatId: string;
  sessionId: string;
  agentId: string;
  runtimeSessionId: string | null;
  projectId: string | null;
  name: string | null;
  mode: string | null;
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
