import type { RuntimeCapabilityRef } from "./plugin/sdk";

export const PLATFORM_ID = "clawchat-connect" as const;
export const AGENT_TYPE = "clawbot" as const;

export type OutputVisibility = "minimal" | "normal" | "full";
export type ChatType = "direct" | "group";
export type ClientListenHost = "127.0.0.1" | "0.0.0.0";
export interface RuntimeModelSelection {
  provider?: string;
  model: string;
}

export interface AgentBindingConfigBase {
  outputVisibility?: OutputVisibility;
  displayName?: string;
  sessionOptions?: Record<string, string>;
}

export interface AgentBindingConfig extends AgentBindingConfigBase {
  runtime: RuntimeCapabilityRef;
  runtimeConfig: Record<string, unknown>;
  model?: RuntimeModelSelection;
  modelReasoningEffort?: string;
}

export interface ConnectConfig {
  baseUrl: string;
  websocketUrl: string;
  mediaUploadUrl: string;
  stateDbPath: string;
  defaultAgent: string | null;
  outputVisibility: OutputVisibility;
  agents: Record<string, AgentBindingConfig>;
  maxConcurrentTurns?: number;
  maxPendingPerSession?: number;
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

export interface WorkspaceRecord {
  bindingId: string;
  workspaceRef: string;
  runtimeIdentityKey: string | null;
  source: "default" | "runtime";
  name: string;
  rootPath: string;
  selectable: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeWorkspace {
  workspaceRef: string;
  workingDirectory: string;
  skipGitRepoCheck: boolean;
}

export interface RuntimeSessionRecord {
  chatId: string;
  sessionId: string;
  sessionRef: string;
  agentId: string;
  runtimeSessionId: string | null;
  workspaceRef: string | null;
  name: string | null;
  mode: string | null;
  model: RuntimeModelSelection | null;
  reasoningEffort: string | null;
  sessionOptions?: Record<string, string>;
  hasMessages: boolean;
  isCurrent: boolean;
  updatedAt: number;
}

export interface SessionIntentRecord {
  chatId: string;
  agentId: string;
  workspaceRef: string | null;
  name: string | null;
  mode: string | null;
  model: RuntimeModelSelection | null;
  reasoningEffort: string | null;
  sessionOptions?: Record<string, string>;
  updatedAt: number;
}

export interface RuntimeStatus {
  updatedAt: number;
  runtimeAvailability: "available" | "startup-unavailable" | null;
  websocketConnected: boolean | null;
  activeAgent: string | null;
  activeChats: number;
  globalRunning: number;
  globalQueued: number;
  recentError: string | null;
}
