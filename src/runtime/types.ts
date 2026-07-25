import type { RuntimeOutputEvent, RuntimeOutputKind } from "../output-visibility";
import type { AgentBindingConfig, RuntimeWorkspace } from "../types";

export interface ConnectRuntimePrompt {
  prompt: string;
  media?: ConnectRuntimeMedia[];
  trustedMediaOrigins?: string[];
  workspace: RuntimeWorkspace;
  mode?: string;
  model?: string;
  reasoningEffort?: string;
  onAccepted?: () => Promise<void>;
  metadata?: Record<string, string>;
  outputPolicy?: {
    mode: string;
    allowedKinds: RuntimeOutputKind[];
  };
}

export interface RuntimeModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  inputModalities: Array<"text" | "image" | "audio">;
}

export interface ConnectRuntimeMedia {
  kind: "image" | "file" | "audio" | "video";
  url: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export interface ConnectRuntimeStartContext {
  agentId: string;
  chatId: string;
  sessionId: string;
  runtimeSessionId: string | null;
  configPath: string;
  stateDbPath: string;
  onRuntimeSessionId(runtimeSessionId: string): Promise<void>;
}

export interface RuntimeThreadSummary {
  runtimeThreadId: string;
  parentRuntimeThreadId?: string | null;
  isArchived?: boolean;
  name: string | null;
  updatedAt: number;
  workingDirectory?: string | null;
  workspaceKind?: "persistent" | "transient";
}

export interface SelectableRuntimeThread extends RuntimeThreadSummary {
  sessionRef: string;
}

export interface RuntimeTranscriptEntry {
  id: string;
  kind:
    | "user"
    | "assistant"
    | "reasoning"
    | "plan"
    | "command"
    | "file-change"
    | "tool"
    | "progress"
    | "subagent"
    | "unknown";
  text: string;
  state: "streaming" | "complete" | "error" | "cancelled";
  data?: Record<string, unknown>;
  children?: RuntimeTranscriptEntry[];
}

export interface ConnectRuntimeSession {
  prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeOutputEvent>;
  close(): Promise<void>;
  cancel?(): Promise<boolean>;
}

export interface ConnectRuntimeAdapter {
  readonly kind: string;
  readonly modes: readonly string[];
  prepare?(binding: AgentBindingConfig): Promise<void>;
  listModels?(binding: AgentBindingConfig): Promise<RuntimeModelOption[]>;
  discoverThreads?(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]>;
  discoverAllThreads?(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]>;
  discoverArchivedThreads?(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]>;
  readTranscript?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<RuntimeTranscriptEntry[]>;
  archiveThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  unarchiveThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  deleteThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession>;
  close?(): Promise<void>;
}
