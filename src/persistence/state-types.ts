import type {
  ClientViewEvent,
  TranscriptBlock,
  TurnSubmissionErrorView,
  TurnSubmissionState,
} from "../client-contract";
import type { RuntimeSlashSelection } from "../runtime/types";
import type { RuntimeModelSelection } from "../types";

export interface ConnectStateOptions {
  dbPath?: string;
  sessionRefFactory?: () => string;
  clientEventRetentionLimit?: number;
  storageCompactionThresholdBytes?: number;
}

export type GroupReplyMode = "all" | "mention";

export interface GroupSettingsRecord {
  conversationId: string;
  muted: boolean;
  replyMode: GroupReplyMode;
  batchDelaySeconds: number;
  version: number;
}

export interface GroupSettingsSnapshotRecord {
  authoritative: boolean;
  stale: boolean;
  rows: GroupSettingsRecord[];
}

export type InboundHandlingOutcome = "runtime" | "mention-context" | "muted" | "oversized" | "policy-discarded";

export interface HandledInboundMessage {
  messageId: string;
  raw: unknown;
}

export type ToolRequestState = "pending" | "running" | "succeeded" | "failed" | "expired" | "indeterminate";
export interface ToolRequestRecord {
  requestId: string;
  bindingId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolRequestState;
  result: unknown;
  error: string | null;
  resultTruncated: boolean;
  errorTruncated: boolean;
  sessionRef: string | null;
  turnId: string | null;
  origin: string | null;
  createdAt: number;
  claimedAt: number | null;
  settledAt: number | null;
  expiresAt: number;
  attemptCount: number;
}

export interface SessionRefTarget {
  chatId: string;
  agentId: string;
  sessionId?: string | null;
  runtimeSessionId?: string | null;
}

export interface SessionRefRecord {
  sessionRef: string;
  chatId: string;
  agentId: string;
  sessionId: string | null;
  runtimeSessionId: string | null;
}

export interface MessageInput {
  agentId?: string | null;
  direction: "inbound" | "outbound";
  kind: "message" | "thinking";
  eventType: string;
  traceId?: string | null;
  chatId?: string | null;
  messageId?: string | null;
  text?: string | null;
  raw?: unknown;
  createdAt?: number;
}
export interface ProtocolDeliveryInput {
  agentId: string;
  ackEpoch: string;
  dseq: number;
  eventKey: string;
  eventType: string;
  traceId: string;
  chatId?: string | null;
  messageId?: string | null;
  raw: unknown;
}
export interface ProtocolDeliveryState {
  ackEpoch: string;
  lastReadDseq: number;
  ackHighWater: number;
}
export interface ProtocolDeliveryQuarantineInput {
  agentId: string;
  ackEpoch: string;
  dseq: number;
  eventType: string;
  traceId: string;
  raw: unknown;
  error: string;
}
export interface ProtocolDeliveryQuarantineRecord {
  ackEpoch: string;
  dseq: number;
  eventType: string;
  traceId: string;
  raw: unknown;
  error: string;
  createdAt: number;
}
export interface InsertWorkspaceInput {
  bindingId: string;
  workspaceRef: string;
  runtimeIdentityKey: string | null;
  source: "default" | "runtime";
  name: string;
  rootPath: string;
  selectable: boolean;
}
export interface ReconcileWorkspaceCatalogInput {
  bindingId: string;
  status: "complete" | "partial" | "unavailable";
  identities: readonly {
    workspaceRef: string;
    runtimeIdentityKey: string;
    name: string;
    rootPath: string | null;
  }[];
}
export interface UpsertRuntimeSessionInput {
  chatId: string;
  sessionId: string;
  agentId: string;
  runtimeSessionId?: string | null;
  workspaceRef?: string | null;
  name?: string | null;
  mode?: string | null;
  model?: RuntimeModelSelection | null;
  reasoningEffort?: string | null;
  sessionOptions?: Record<string, string>;
  hasMessages?: boolean;
  isCurrent?: boolean;
}
export interface AdoptRuntimeThreadRefInput {
  sessionRef: string;
  chatId: string;
  sessionId: string;
  agentId: string;
  workspaceRef: string | null;
  name?: string | null;
  mode?: string | null;
  model?: RuntimeModelSelection | null;
  reasoningEffort?: string | null;
  sessionOptions?: Record<string, string>;
}
export interface SetSessionIntentInput {
  chatId: string;
  agentId: string;
  workspaceRef: string | null;
  name?: string | null;
  mode?: string | null;
  model?: RuntimeModelSelection | null;
  reasoningEffort?: string | null;
  sessionOptions?: Record<string, string>;
}

export interface ResolveOrMaterializeRuntimeSessionInput {
  chatId: string;
  agentId: string;
  sessionId: string;
  acceptedTurn?: boolean;
}

export type SessionBindingLockReason = "accepted-turn" | "runtime-thread";

export type ChangeSessionBindingResult =
  | { changed: true }
  | { changed: false; reason: "session-not-found" | "binding-locked"; lockReason?: SessionBindingLockReason };

export interface AcceptSessionTurnInput {
  sessionRef: string;
  bindingId: string;
}
export type SessionLifecycleAction = "archive" | "restore" | "delete";
export type SessionLifecycleOperationState = "intent" | "native-confirmed" | "complete";

export interface SessionLifecycleOperationRecord {
  operationId: string;
  sessionRef: string;
  action: SessionLifecycleAction;
  bindingId: string;
  runtimeThreadId: string;
  state: SessionLifecycleOperationState;
  createdAt: number;
  updatedAt: number;
}

export interface StoredClientEvent {
  cursor: number;
  event: ClientViewEvent;
  createdAt: number;
}

export type ClientCommandClaim =
  | { state: "claimed" }
  | { state: "pending" }
  | { state: "conflict" }
  | { state: "complete"; responseStatus: number; responseBody: unknown };

export type ClientCommandOutcome =
  | { state: "missing" }
  | { state: "pending"; commandKind: string; entityRef: string }
  | {
      state: "complete";
      commandKind: string;
      entityRef: string;
      responseStatus: number;
      responseBody: unknown;
    };
export interface TurnOutboxRecord {
  submissionId: string;
  sessionRef: string;
  messageId: string;
  digest: string;
  prompt: string;
  selection: RuntimeSlashSelection | null;
  stagingRef: string;
  state: TurnSubmissionState;
  turnId: string | null;
  error: TurnSubmissionErrorView | null;
  createdAt: number;
  updatedAt: number;
}
export interface CreateTurnOutboxInput {
  submissionId: string;
  sessionRef: string;
  messageId: string;
  digest: string;
  prompt: string;
  selection: RuntimeSlashSelection | null;
  stagingRef: string;
}

export type CreateTurnOutboxResult =
  | { created: true; record: TurnOutboxRecord }
  | { created: false; reason: "reserved" }
  | { created: false; reason: "conflict"; record: TurnOutboxRecord }
  | { created: false; reason: "existing"; record: TurnOutboxRecord };

export type TranscriptBlockInput<T extends TranscriptBlock = TranscriptBlock> = T extends TranscriptBlock
  ? Omit<T, "sequence" | "revision" | "createdAt" | "updatedAt"> & {
      id: string;
      sequence?: number;
      revision?: number;
      createdAt?: string;
      updatedAt?: string;
    }
  : never;
