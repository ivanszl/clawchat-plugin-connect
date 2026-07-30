import type { RuntimeOutputKind } from "../output-visibility";
import type { AgentBindingConfig, RuntimeWorkspace } from "../types";

export interface ConnectRuntimePrompt {
  prompt: string;
  media?: ConnectRuntimeMedia[];
  trustedMediaOrigins?: string[];
  workspace: RuntimeWorkspace;
  mode?: string;
  model?: string;
  reasoningEffort?: string;
  turnId?: string;
  turnOrigin?: "client" | "clawchat";
  interactionPort?: RuntimeInteractionPort;
  onAccepted?: () => Promise<void>;
  metadata?: Record<string, string>;
  outputPolicy?: {
    mode: string;
    allowedKinds: RuntimeOutputKind[];
  };
}

export type RuntimeInteractionRequest =
  | {
      kind: "approval";
      action: "command" | "file-change";
      title: string;
      description: string;
      command?: string;
      cwd?: string;
      files?: Array<{ path: string; diff?: string }>;
      options: Array<{ id: "approve-once" | "approve-session" | "deny"; label: string; description?: string }>;
    }
  | {
      kind: "user-input";
      title: string;
      description: string;
      questions: Array<{
        id: string;
        header: string;
        prompt: string;
        secret: boolean;
        allowOther: boolean;
        options: Array<{ id: string; label: string; description?: string }> | null;
      }>;
      autoResolutionMs: number | null;
    };

export type RuntimeInteractionResponse =
  | { kind: "approval"; optionId: "approve-once" | "approve-session" | "deny" | "cancel" }
  | { kind: "user-input"; answers: Record<string, string[]> };

export interface RuntimeInteractionPort {
  request(
    request: RuntimeInteractionRequest,
    context: {
      sessionRef: string;
      turnId: string;
      origin: "client" | "clawchat";
      signal?: AbortSignal;
    },
  ): Promise<RuntimeInteractionResponse>;
}

export interface RuntimeModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  inputModalities: Array<"text" | "image" | "audio">;
  turnSubmissionCapability?: RuntimeTurnSubmissionCapability;
}

export interface RuntimeTurnSubmissionCapability {
  prompt: {
    allowed: boolean;
    required: boolean;
    maxCharacters?: number;
  };
  attachments: {
    allowedKinds: Array<"image" | "file" | "audio" | "video">;
    allowedMediaTypes: string[];
    maxCount?: number;
    maxBytesEach?: number;
    maxBytesTotal?: number;
  };
}

export interface ConnectRuntimeMedia {
  kind: "image" | "file" | "audio" | "video";
  url: string;
  /** Connect-owned local input accepted with a Client Turn; never supplied by a remote Turn Surface. */
  stagedPath?: string;
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
  workspaceIdentity?: RuntimeWorkspaceIdentity;
}

export interface RuntimeWorkspaceIdentity {
  key: string;
  kind: "persistent" | "transient";
  localRoot: string | null;
}

export interface RuntimeLifecycleCapabilities {
  archive: boolean;
  restore: boolean;
  delete: boolean;
}

export type RuntimeLifecycleErrorCode = "not-found" | "conflict" | "unsupported";

export class RuntimeLifecycleError extends Error {
  constructor(
    readonly code: RuntimeLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeLifecycleError";
  }
}

export interface SelectableRuntimeThread extends RuntimeThreadSummary {
  sessionRef: string;
}

export type RuntimeTranscriptSource = "history" | "fallback";
export type RuntimeTranscriptCompleteness = "complete" | "partial" | "live-only";

export interface RuntimeTranscriptEntry {
  id: string;
  aliases?: string[];
  position?: string;
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
  source: RuntimeTranscriptSource;
  data?: Record<string, unknown>;
  children?: RuntimeTranscriptEntry[];
}

export interface RuntimeActivity {
  id: string;
  aliases?: string[];
  /** Runtime Thread-local `<turn ordinal>.<item ordinal>`; ordinals are zero-based and decimal. */
  position: string;
  parentId: string | null;
  kind: RuntimeTranscriptEntry["kind"] | "error";
  text: string;
  state: RuntimeTranscriptEntry["state"] | "pending";
  source: "live" | RuntimeTranscriptSource;
  data?: Record<string, unknown>;
  children?: RuntimeActivity[];
}

export function runtimeActivityOrdinal(position: string): { turn: number; item: number } | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(position);
  if (!match) return null;
  const turn = Number(match[1]);
  const item = Number(match[2]);
  return Number.isSafeInteger(turn) && Number.isSafeInteger(item) ? { turn, item } : null;
}

export interface RuntimeActivitySnapshot {
  activities: RuntimeActivity[];
  completeness: RuntimeTranscriptCompleteness;
  limitations: Array<"identity" | "correlation" | "ordering">;
}

export interface RuntimeTranscriptSnapshot {
  entries: RuntimeTranscriptEntry[];
  completeness: RuntimeTranscriptCompleteness;
}

export interface ConnectRuntimeSession {
  prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeActivity>;
  close(): Promise<void>;
  cancel?(): Promise<boolean>;
}

export interface ConnectRuntimeAdapter {
  readonly kind: string;
  readonly modes: readonly string[];
  readonly lifecycleCapabilities?: RuntimeLifecycleCapabilities;
  prepare?(binding: AgentBindingConfig): Promise<void>;
  listModels?(binding: AgentBindingConfig): Promise<RuntimeModelOption[]>;
  discoverThreads?(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]>;
  discoverAllThreads?(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]>;
  discoverArchivedThreads?(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]>;
  readActivity?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<RuntimeActivitySnapshot>;
  archiveThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  unarchiveThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  deleteThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession>;
  close?(): Promise<void>;
}
