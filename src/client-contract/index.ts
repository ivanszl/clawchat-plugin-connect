export const CLIENT_API_PREFIX = "/client/v1" as const;
export const SESSION_REF_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u;

export type TranscriptOrigin = "client" | "clawchat" | "runtime";
export type TranscriptState = "pending" | "streaming" | "complete" | "error" | "cancelled";

export interface TranscriptBlockContentBase {
  id: string;
  origin: TranscriptOrigin;
  state: TranscriptState;
  plainText: string;
}

export interface TranscriptBlockMetadata {
  revision: number;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export type TranscriptBlockBase = TranscriptBlockContentBase & TranscriptBlockMetadata;

export interface MessageBlockContent extends TranscriptBlockContentBase {
  type: "message";
  role: "user" | "assistant";
  author: string;
  markdown: string;
}

export interface ReasoningSummaryBlockContent extends TranscriptBlockContentBase {
  type: "reasoning-summary";
  markdown: string;
}

export interface PlanBlockContent extends TranscriptBlockContentBase {
  type: "plan";
  markdown: string;
}

export interface ToolCallBlockContent extends TranscriptBlockContentBase {
  type: "tool-call";
  title: string;
  status: string;
  detail: string;
}

export interface CommandBlockContent extends TranscriptBlockContentBase {
  type: "command";
  command: string;
  output: string;
  status: string;
  exitCode: number | null;
}

export interface FileChangeBlockContent extends TranscriptBlockContentBase {
  type: "file-change";
  status: string;
  files: Array<{ path: string; kind: string; diff: string }>;
}

export interface ProgressBlockContent extends TranscriptBlockContentBase {
  type: "progress";
  label: string;
}

export interface UsageBlockContent extends TranscriptBlockContentBase {
  type: "usage";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface RuntimeInteractionBlockContent extends TranscriptBlockContentBase {
  type: "runtime-interaction";
  interactionId: string;
  interactionType: "approval" | "user-input";
  title: string;
  description: string;
  responseState: "pending" | "submitting" | "resolved" | "expired";
  options: Array<{ id: string; label: string; description?: string }>;
  resolvedOptionId: string | null;
}

export interface ErrorBlockContent extends TranscriptBlockContentBase {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
}

export interface UnknownBlockContent extends TranscriptBlockContentBase {
  type: "unknown";
  label: string;
  detail: string;
}

export interface SubagentBlockContent extends TranscriptBlockContentBase {
  type: "subagent";
  title: string;
  role: string | null;
  activityKind: "started" | "interacted" | "interrupted" | "unknown";
  blocks: EmbeddedTranscriptBlock[];
}

export type EmbeddedTranscriptBlock =
  | MessageBlockContent
  | ReasoningSummaryBlockContent
  | PlanBlockContent
  | ToolCallBlockContent
  | CommandBlockContent
  | FileChangeBlockContent
  | ProgressBlockContent
  | UsageBlockContent
  | RuntimeInteractionBlockContent
  | ErrorBlockContent
  | UnknownBlockContent
  | SubagentBlockContent;

export type TranscriptBlock = EmbeddedTranscriptBlock & TranscriptBlockMetadata;
export type MessageBlock = MessageBlockContent & TranscriptBlockMetadata;
export type ReasoningSummaryBlock = ReasoningSummaryBlockContent & TranscriptBlockMetadata;
export type PlanBlock = PlanBlockContent & TranscriptBlockMetadata;
export type ToolCallBlock = ToolCallBlockContent & TranscriptBlockMetadata;
export type CommandBlock = CommandBlockContent & TranscriptBlockMetadata;
export type FileChangeBlock = FileChangeBlockContent & TranscriptBlockMetadata;
export type ProgressBlock = ProgressBlockContent & TranscriptBlockMetadata;
export type UsageBlock = UsageBlockContent & TranscriptBlockMetadata;
export type RuntimeInteractionBlock = RuntimeInteractionBlockContent & TranscriptBlockMetadata;
export type ErrorBlock = ErrorBlockContent & TranscriptBlockMetadata;
export type UnknownBlock = UnknownBlockContent & TranscriptBlockMetadata;
export type SubagentBlock = SubagentBlockContent & TranscriptBlockMetadata;

export interface TranscriptPageView {
  sessionRef: string;
  blocks: TranscriptBlock[];
  beforeCursor: string | null;
  hasOlder: boolean;
  completeness: "complete" | "partial" | "live-only";
}

export type SessionCatalogAction = "open" | "send" | "cancel" | "adopt" | "archive" | "unarchive" | "delete";
export type SessionAction = "send" | "cancel" | "archive" | "unarchive" | "delete";

export interface SessionCatalogEntryView {
  sessionRef: string;
  entryKind: "session" | "runtime-thread";
  bindingId: string;
  bindingKind: string;
  projectId: string | null;
  projectName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  name: string;
  isArchived: boolean;
  status: "idle" | "running" | "queued" | "offline" | "error";
  updatedAt: string;
  isCurrent: boolean;
  isAdopted: boolean;
  unreadCount: number;
  pendingInteractionCount: number;
  allowedActions: SessionCatalogAction[];
}

export interface SessionCatalogBindingView {
  bindingId: string;
  displayName: string;
  kind: string;
  status: "connected" | "disconnected" | "unknown";
  entries: SessionCatalogEntryView[];
}

export interface SessionCatalogView {
  revision: number;
  bindings: SessionCatalogBindingView[];
}

export interface SessionView {
  revision: number;
  sessionRef: string;
  bindingId: string;
  bindingKind: string;
  projectId: string | null;
  projectName: string | null;
  workspaceName: string | null;
  name: string;
  isArchived: boolean;
  mode: string | null;
  status: "idle" | "running" | "queued" | "offline" | "error";
  runtimeThreadAvailable: boolean;
  activeTurnId: string | null;
  transcriptCompleteness: "complete" | "partial" | "live-only";
  pendingInteractions: RuntimeInteractionBlock[];
  allowedActions: SessionAction[];
  updatedAt: string;
}

export interface BindingPreferenceView {
  bindingId: string;
  displayName: string;
  model: string | null;
  modelReasoningEffort: string | null;
}

export interface BootstrapView {
  apiVersion: 1;
  eventCursor: number;
  outputVisibility: "minimal" | "normal" | "full";
  bindings: BindingPreferenceView[];
  capabilities: {
    localTurns: boolean;
    cancellation: boolean;
    runtimeInteractions: boolean;
    preferenceEditing: boolean;
  };
}

export type ClientViewEvent =
  | { type: "catalog.changed"; cursor: number; revision: number; catalog: SessionCatalogView }
  | { type: "session.changed"; cursor: number; sessionRef: string; revision: number; session: SessionView }
  | {
      type: "transcript.block-upserted";
      cursor: number;
      sessionRef: string;
      revision: number;
      block: TranscriptBlock;
    }
  | {
      type: "transcript.block-removed";
      cursor: number;
      sessionRef: string;
      revision: number;
      blockId: string;
    }
  | {
      type: "snapshot-required";
      cursor: number;
      reason: "cursor-expired" | "revision-gap";
    };

export interface ClientErrorView {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    diagnosticRef?: string;
  };
}

export interface StartTurnRequest {
  requestId: string;
  prompt: string;
}

export interface StartTurnResponse {
  accepted: true;
  turnId: string;
  sessionRef: string;
}

export interface CancelTurnRequest {
  requestId: string;
}

export interface CancelTurnResponse {
  cancelled: boolean;
  sessionRef: string;
}

export interface SessionMutationRequest {
  requestId: string;
}

export interface SessionArchiveResponse {
  sessionRef: string;
  archived: boolean;
}

export interface SessionDeleteResponse {
  sessionRef: string;
  deleted: true;
}

export interface UpdateBindingPreferencesRequest {
  requestId: string;
  displayName?: string;
  model?: string | null;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  outputVisibility?: "minimal" | "normal" | "full";
}

export function normalizeSessionRef(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return SESSION_REF_PATTERN.test(normalized) ? normalized : null;
}
