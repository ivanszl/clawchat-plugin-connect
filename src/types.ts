import type { RuntimeCapabilityRef } from "./plugin/sdk";

export const PLATFORM_ID = "clawchat-connect" as const;
export const AGENT_TYPE = "clawbot" as const;

export type OutputVisibility = "minimal" | "normal" | "full";
export type ChatType = "direct" | "group";
export type ClientHost = "127.0.0.1" | "0.0.0.0";
export type LivewareAccessPolicy = "off" | "private" | "public";

export interface AgentBindingConfigBase {
  outputVisibility?: OutputVisibility;
  displayName?: string;
  sessionOptions?: Record<string, string>;
}

export interface AgentBindingConfig extends AgentBindingConfigBase {
  runtime: RuntimeCapabilityRef;
  runtimeConfig: Record<string, unknown>;
  model?: string;
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
  clientHost: ClientHost;
  clientPort: number;
  livewareAccessPolicy: LivewareAccessPolicy;
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

export interface LivewareExposureRecord {
  ownerUserId: string;
  localAgentId: string;
  appId: string;
  publicUrl: string;
  accessPolicy: Exclude<LivewareAccessPolicy, "off">;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeWorkspace {
  projectId: string | null;
  workingDirectory: string;
  skipGitRepoCheck: boolean;
}

export interface RuntimeSessionRecord {
  chatId: string;
  sessionId: string;
  sessionRef: string;
  agentId: string;
  runtimeSessionId: string | null;
  projectId: string | null;
  name: string | null;
  mode: string | null;
  model: string | null;
  reasoningEffort: string | null;
  sessionOptions?: Record<string, string>;
  hasMessages: boolean;
  isCurrent: boolean;
  updatedAt: number;
}

export interface SessionIntentRecord {
  chatId: string;
  agentId: string;
  projectId: string | null;
  name: string | null;
  mode: string | null;
  model: string | null;
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
