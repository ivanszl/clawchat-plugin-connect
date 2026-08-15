import type { RuntimeOutputKind } from "../clawchat/output-visibility";
import type { AgentBindingConfig, RuntimeWorkspace } from "../types";

export interface RuntimeInputMessageIdentity {
  messageId: string;
  contentDigest: string;
}

export interface RuntimeInputIdentity {
  origin: "clawchat";
  anchor: RuntimeInputMessageIdentity;
  actionable: RuntimeInputMessageIdentity[];
  context: RuntimeInputMessageIdentity[];
}

export interface RuntimeInputReceiptSnapshot {
  identities: RuntimeInputIdentity[];
  complete: boolean;
}

export type RuntimeInputReconciliation =
  | { outcome: "accepted"; identity: RuntimeInputIdentity; receipts?: RuntimeInputReceiptSnapshot }
  | { outcome: "absent"; receipts?: RuntimeInputReceiptSnapshot }
  | { outcome: "unknown"; receipts?: RuntimeInputReceiptSnapshot };

/** Parses the structured ClawChat context prefix without treating visible prompt text as identity. */
export function runtimeInputIdentity(text: string): RuntimeInputIdentity | null {
  const match = /^<clawchat_turn_context>\n([^\n]+)\n<\/clawchat_turn_context>/u.exec(text);
  if (!match?.[1]) return null;
  try {
    const value = recordValue(JSON.parse(match[1]));
    if (value?.origin !== "clawchat") return null;
    const anchor = inputMessageIdentity(value);
    if (!anchor) return null;

    const groupBatch = value.group_batch === undefined ? null : recordValue(value.group_batch);
    if (value.group_batch !== undefined && !groupBatch) return null;
    const rawActionable = groupBatch?.messages;
    if (groupBatch && !Array.isArray(rawActionable)) return null;
    const actionable = groupBatch ? inputMessageIdentities(rawActionable as unknown[]) : [anchor];
    if (!actionable || actionable.length === 0) return null;

    const rawContext = value.recent_group_context;
    if (rawContext !== undefined && !Array.isArray(rawContext)) return null;
    const context = rawContext === undefined ? [] : inputMessageIdentities(rawContext);
    if (!context) return null;
    if (!hasUniqueMessageIds(actionable) || !hasUniqueMessageIds(context)) return null;
    const actionableMessageIds = new Set(actionable.map((item) => item.messageId));
    if (context.some((item) => actionableMessageIds.has(item.messageId))) return null;
    if (groupBatch) {
      const matchingAnchors = actionable.filter((item) => item.messageId === anchor.messageId);
      if (matchingAnchors.length !== 1 || matchingAnchors[0]?.contentDigest !== anchor.contentDigest) return null;
    }
    return { origin: "clawchat", anchor, actionable, context };
  } catch {
    return null;
  }
}

export function runtimeInputIdentityContains(
  identity: RuntimeInputIdentity,
  candidate: RuntimeInputMessageIdentity,
): boolean {
  return [...identity.actionable, ...identity.context].some(
    (item) => item.messageId === candidate.messageId && item.contentDigest === candidate.contentDigest,
  );
}

function inputMessageIdentities(values: unknown[]): RuntimeInputMessageIdentity[] | null {
  const identities = values.map((value) => inputMessageIdentity(recordValue(value)));
  return identities.every((identity): identity is RuntimeInputMessageIdentity => identity !== null) ? identities : null;
}

function inputMessageIdentity(value: Record<string, unknown> | null): RuntimeInputMessageIdentity | null {
  if (!value) return null;
  const messageId = value.message_id;
  const contentDigest = value.content_digest;
  return typeof messageId === "string" &&
    messageId.length > 0 &&
    typeof contentDigest === "string" &&
    contentDigest.length > 0
    ? { messageId, contentDigest }
    : null;
}

function hasUniqueMessageIds(identities: readonly RuntimeInputMessageIdentity[]): boolean {
  return new Set(identities.map((identity) => identity.messageId)).size === identities.length;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface ConnectRuntimePrompt {
  prompt: string;
  skill?: RuntimeSkillSummary;
  command?: RuntimeCommandSummary;
  media?: ConnectRuntimeMedia[];
  trustedMediaOrigins?: string[];
  workspace: RuntimeWorkspace;
  mode?: string;
  model?: string;
  reasoningEffort?: string;
  sessionOptions?: Record<string, string>;
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

export interface RuntimeSkillSummary {
  /** Runtime Adapter-owned opaque identity safe to expose through the Client Interface. */
  id: string;
  name: string;
  description?: string;
}

export interface RuntimeCommandSummary {
  /** Runtime Adapter-owned opaque identity safe to expose through the Client Interface. */
  id: string;
  name: string;
  description?: string;
}

export type RuntimeSlashSelection =
  | ({ kind: "skill" } & RuntimeSkillSummary)
  | ({ kind: "command" } & RuntimeCommandSummary);

export interface QueuedClientTurn {
  turnId: string;
  sessionRef: string;
  prompt: string;
  selection: RuntimeSlashSelection | null;
  attachments: Array<{ name: string }>;
  createdAt: string;
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

export interface ClawChatInteractionRoute {
  chatId: string;
  chatType: "direct" | "group";
  sourceMessageId: string | null;
  sourceSender?: { id: string; displayName: string };
  sourceFragments?: import("../clawchat/protocol").Fragment[];
}

export interface RuntimeInteractionContext {
  sessionRef: string;
  turnId: string;
  origin: "client" | "clawchat";
  deliveryConfirmation: Promise<void>;
  signal?: AbortSignal;
  clawchat?: ClawChatInteractionRoute;
}

export interface RuntimeInteractionPort {
  request(request: RuntimeInteractionRequest, context: RuntimeInteractionContext): Promise<RuntimeInteractionResponse>;
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

export interface RuntimeSessionOptionValue {
  id: string;
  displayName: string;
  description?: string;
  unavailable?: boolean;
  availableWhen?: Record<string, string>;
}

export interface RuntimeSessionOption {
  id: string;
  displayName: string;
  description: string;
  category: "agent" | "model" | "variant" | "execution" | "other";
  changePolicy: "in-place" | "new-runtime-session";
  defaultValue?: string;
  values: RuntimeSessionOptionValue[];
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
  configPath?: string;
  stateDbPath?: string;
  onRuntimeSessionId(runtimeSessionId: string): Promise<void>;
  cacheMedia?(media: ConnectRuntimeMedia, trustedOrigins?: readonly string[]): Promise<string>;
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
    | "turn"
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
  inputIdentity?: RuntimeInputIdentity;
  data?: RuntimeActivityData;
  children?: RuntimeActivity[];
}

export interface RuntimeActivityData extends Record<string, unknown> {
  deliveryDisposition?: "projection-only";
  recoveredWhileDisconnected?: boolean;
}

export function isProjectionOnlyRuntimeActivity(activity: RuntimeActivity): boolean {
  return activity.data?.deliveryDisposition === "projection-only";
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
  modesFor?(binding: AgentBindingConfig, scope?: RuntimeCatalogScope): readonly string[];
  listModels?(binding: AgentBindingConfig, scope?: RuntimeCatalogScope): Promise<RuntimeModelOption[]>;
  listSessionOptions?(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    scope?: RuntimeCatalogScope,
  ): Promise<RuntimeSessionOption[]>;
  listSkills?(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    options?: { forceRefresh?: boolean; runtimeThreadId?: string },
  ): Promise<RuntimeSkillSummary[]>;
  onSkillsChanged?(listener: () => void): () => void;
  listCommands?(
    binding: AgentBindingConfig,
    workspace: RuntimeWorkspace,
    options?: { forceRefresh?: boolean; runtimeThreadId?: string },
  ): Promise<RuntimeCommandSummary[]>;
  onCommandsChanged?(listener: () => void): () => void;
  onCatalogsChanged?(listener: () => void): () => void;
  discoverThreads?(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]>;
  discoverAllThreads?(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]>;
  discoverArchivedThreads?(binding: AgentBindingConfig): Promise<RuntimeThreadSummary[]>;
  verifyThreadReady?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  readActivity?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<RuntimeActivitySnapshot>;
  reconcileInput?(
    binding: AgentBindingConfig,
    runtimeThreadId: string,
    candidate: RuntimeInputMessageIdentity,
  ): Promise<RuntimeInputReconciliation>;
  archiveThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  unarchiveThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  deleteThread?(binding: AgentBindingConfig, runtimeThreadId: string): Promise<void>;
  start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession>;
  close?(): Promise<void>;
}

export interface RuntimeCatalogScope {
  runtimeThreadId?: string;
  workspace?: RuntimeWorkspace;
}
