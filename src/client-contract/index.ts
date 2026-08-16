export const CLIENT_API_PREFIX = "/client/v1" as const;
export const PLUGIN_MANAGER_CONFIG_HEADER = "X-ClawChat-Connect-Config-Path" as const;
export const SESSION_REF_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u;
export const MAX_PLUGIN_BUNDLE_BYTES = 16 * 1024 * 1024;

export type PluginJsonSchemaView = Readonly<Record<string, unknown>>;

export type PluginSourceView =
  | { type: "local"; path: string }
  | { type: "npm"; package: string; registry: string; version: string; tarball: string }
  | {
      type: "github";
      repository: string;
      apiBase: string;
      version: string;
      release: string;
      asset: string;
    };

export type PluginDiagnosticStage = "import" | "validation" | "activation" | "provider" | "probe" | "update";

export interface PluginDiagnosticView {
  stage: PluginDiagnosticStage;
  message: string;
}

export interface PluginCapabilityInstanceView {
  instanceId: string;
  bindingId: string | null;
  displayName: string;
  configuration: Record<string, unknown>;
}

export interface PluginCapabilityView {
  id: string;
  type: "runtime" | "exposure";
  family: string | null;
  configurationSchema: PluginJsonSchemaView;
  instances: PluginCapabilityInstanceView[];
}

export interface RetainedPluginVersionView {
  source: PluginSourceView;
  version: string;
  target: string;
  integrity: string;
}

export type PluginUpdateAvailabilityView =
  | { status: "current"; version: string; integrity: string; diagnostic: null }
  | { status: "available"; version: string; integrity: string; diagnostic: null }
  | { status: "check-failed"; version: null; integrity: null; diagnostic: string }
  | { status: "not-installed"; version: string | null; integrity: string | null; diagnostic: null };

export interface InstalledPluginView {
  kind: "installed";
  pluginId: string;
  name: string;
  source: PluginSourceView;
  version: string;
  target: string;
  integrity: string;
  status: "active" | "disabled" | "error";
  dependentBindings: Array<{ bindingId: string; displayName: string; capabilityId: string }>;
  updateAvailability: PluginUpdateAvailabilityView;
  retainedVersions: RetainedPluginVersionView[];
  installationConfigurationSchema: PluginJsonSchemaView;
  installationConfiguration: Record<string, unknown>;
  capabilities: PluginCapabilityView[];
  diagnostics: PluginDiagnosticView[];
}

export interface AvailablePluginView {
  kind: "available";
  pluginId: string;
  name: string;
  sourceReference: string;
  source: PluginSourceView | null;
  version: string | null;
  target: string;
  integrity: string | null;
  status: "available" | "unavailable";
  dependentBindings: [];
  updateAvailability: PluginUpdateAvailabilityView;
  installationConfigurationSchema: PluginJsonSchemaView | null;
  installationConfiguration: Record<string, unknown>;
  capabilities: PluginCapabilityView[];
  detected: boolean;
  compatible: boolean;
  selected: boolean;
  diagnostics: PluginDiagnosticView[];
}

export interface PluginAdministrationView {
  installed: InstalledPluginView[];
  available: AvailablePluginView[];
  catalogOrigin: "remote" | "cache" | null;
  diagnostics: PluginDiagnosticView[];
}

export interface ManagePluginRequest {
  source: string;
  target?: string;
  installationConfiguration?: Record<string, unknown>;
  exposureConfigurations?: Record<string, Record<string, unknown>>;
}

export interface ConfigurePluginRequest {
  installationConfiguration: Record<string, unknown>;
  exposureConfigurations: Record<string, Record<string, unknown>>;
  runtimeConfigurations: Record<string, Record<string, unknown>>;
}

export interface SelectPluginVersionRequest {
  version: string;
  integrity?: string;
}

export type TranscriptOrigin = "client" | "clawchat" | "runtime";
export type TranscriptState = "pending" | "streaming" | "complete" | "error" | "cancelled";

export interface TranscriptBlockContentBase {
  id: string;
  origin: TranscriptOrigin;
  state: TranscriptState;
  plainText: string;
  runtimeSource?: "live" | "history" | "fallback";
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
  sender?: {
    id: string;
    displayName: string | null;
  };
  conversationType?: "direct" | "group";
  markdown: string;
  media?: Array<{
    kind: "image" | "file" | "audio" | "video";
    url: string;
    name: string | null;
    mime: string | null;
    width: number | null;
    height: number | null;
  }>;
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
  action: "command" | "file-change" | null;
  title: string;
  description: string;
  responseState: "pending" | "submitting" | "resolved" | "expired";
  options: Array<{ id: string; label: string; description?: string }>;
  questions: RuntimeInteractionQuestionView[];
  command: string | null;
  cwd: string | null;
  files: Array<{ path: string; diff?: string }>;
  autoResolutionAt: string | null;
  resolvedOptionId: string | null;
  resolvedBy: "client" | "clawchat" | "system" | null;
}

export interface RuntimeInteractionQuestionView {
  id: string;
  header: string;
  prompt: string;
  secret: boolean;
  allowOther: boolean;
  options: Array<{ id: string; label: string; description?: string }> | null;
}

export interface RespondToRuntimeInteractionRequest {
  requestId: string;
  optionId?: string;
  answers?: Record<string, string[]>;
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
  bindingLocked: boolean;
  bindingLockReason: "accepted-turn" | "runtime-thread" | null;
  projectId: string | null;
  projectName: string | null;
  workspaceName: string | null;
  name: string;
  isArchived: boolean;
  mode: string | null;
  model: string | null;
  reasoningEffort: string | null;
  sessionOptions: Record<string, string>;
  sessionOptionDefinitions: RuntimeSessionOptionView[];
  effectiveModel: string | null;
  effectiveReasoningEffort: string | null;
  modelSource: "session" | "binding" | "runtime";
  modelAvailable: boolean;
  modelOptions: RuntimeModelOptionView[];
  status: "idle" | "running" | "queued" | "offline" | "error";
  runtimeThreadAvailable: boolean;
  activeTurnId: string | null;
  queuedTurns: QueuedTurnView[];
  transcriptCompleteness: "complete" | "partial" | "live-only";
  pendingInteractions: RuntimeInteractionBlock[];
  turnSubmissionCapability: TurnSubmissionCapability;
  allowedActions: SessionAction[];
  updatedAt: string;
}

export interface QueuedTurnView {
  turnId: string;
  prompt: string;
  selection: SlashSuggestionView | null;
  attachments: Array<{ name: string }>;
  createdAt: string;
}

export interface TurnSubmissionCapability {
  prompt: {
    allowed: boolean;
    required: boolean;
    maxCharacters: number;
  };
  attachments: {
    allowedKinds: Array<"image" | "file" | "audio" | "video">;
    allowedMediaTypes: string[];
    maxCount: number;
    maxBytesEach: number;
    maxBytesTotal: number;
  };
}

export interface RuntimeModelOptionView {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  inputModalities: Array<"text" | "image" | "audio">;
}

export interface RuntimeSessionOptionView {
  id: string;
  displayName: string;
  description: string;
  category: "agent" | "model" | "variant" | "execution" | "other";
  changePolicy: "in-place" | "new-runtime-session";
  defaultValue?: string;
  values: Array<{
    id: string;
    displayName: string;
    description?: string;
    unavailable?: boolean;
    availableWhen?: Record<string, string>;
  }>;
}

export interface ProjectView {
  projectId: string;
  workspaceId: string;
  name: string;
  rootPath: string;
}

export type ProjectDirectoryRequest =
  | { kind: "existing-directory"; rootPath: string }
  | { kind: "new-directory"; parentPath: string; name: string };

export interface HostDirectoryLocationView {
  id: string;
  kind: "home" | "filesystem-root" | "mounted-volume" | "project" | "runtime-workspace";
  name: string;
  path: string;
}

export interface HostDirectoryEntryView {
  name: string;
  path: string;
  canonicalPath: string;
  isSymbolicLink: boolean;
}

export interface HostDirectoryListingView {
  currentPath: string | null;
  parentPath: string | null;
  separator: string;
  locations: HostDirectoryLocationView[];
  entries: HostDirectoryEntryView[];
}

export interface BindingPreferenceView {
  bindingId: string;
  displayName: string;
  clawChatUserId: string | null;
  runtimeKind: string;
  runtimeProfile: string | null;
  outputVisibility: "minimal" | "normal" | "full";
  model: string | null;
  modelReasoningEffort: string | null;
  modelOptions: RuntimeModelOptionView[];
  modeOptions: string[];
}

export interface RuntimeAdapterProfileMetadataView {
  id: string;
  displayName: string;
  protocol: { name: string; version: number };
}

export interface RuntimeAdapterMetadataView {
  kind: string;
  displayName: string;
  profiles: RuntimeAdapterProfileMetadataView[];
}

export interface BootstrapView {
  apiVersion: 1;
  eventCursor: number;
  outputVisibility: "minimal" | "normal" | "full";
  bindings: BindingPreferenceView[];
  runtimeAdapters: RuntimeAdapterMetadataView[];
  capabilities: {
    localTurns: boolean;
    cancellation: boolean;
    runtimeInteractions: boolean;
    preferenceEditing: boolean;
  };
}

export type ClientViewEvent = {
  cursor: number;
  /** Cursor of the immediately preceding committed event; cursors need not be numerically adjacent. */
  previousCursor?: number;
} & (
  | { type: "catalog.changed"; revision: number; catalog: SessionCatalogView }
  | { type: "session.changed"; sessionRef: string; revision: number; session: SessionView }
  | {
      type: "transcript.block-upserted";
      sessionRef: string;
      revision: number;
      block: TranscriptBlock;
    }
  | {
      type: "transcript.block-removed";
      sessionRef: string;
      revision: number;
      blockId: string;
    }
  | {
      type: "snapshot-required";
      reason: "cursor-expired" | "revision-gap";
    }
);

export interface ClientEventBatchView {
  cursor: number;
  events: ClientViewEvent[];
}

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
  selection?: SlashSuggestionView;
  media?: ClientMediaAttachment[];
}

export interface SlashSuggestionView {
  kind: "skill" | "command";
  id: string;
  name: string;
  description?: string;
}

export interface SlashSuggestionListView {
  supported: boolean;
  entries: SlashSuggestionView[];
}

export interface ClientMediaAttachment {
  kind: "image" | "file" | "audio" | "video";
  url: string;
  name: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export interface CreateSessionRequest {
  requestId: string;
  bindingId: string;
  workspace:
    | { kind: "none" }
    | { kind: "existing"; workspaceId: string }
    | { kind: "new-project"; directory: ProjectDirectoryRequest };
  name: string | null;
  mode: string | null;
  model: string | null;
  reasoningEffort: string | null;
  sessionOptions?: Record<string, string>;
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

export interface ChangeSessionBindingRequest extends SessionMutationRequest {
  bindingId: string;
}

export interface ContinueSessionRequest extends SessionMutationRequest {
  bindingId: string;
}

export interface UpdateSessionPreferencesRequest {
  requestId: string;
  model: string | null;
  reasoningEffort: string | null;
  sessionOptions?: Record<string, string>;
}

export interface AddProjectRequest {
  requestId: string;
  directory: ProjectDirectoryRequest;
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
  modelReasoningEffort?: string | null;
  outputVisibility?: "minimal" | "normal" | "full";
}

export function normalizeSessionRef(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return SESSION_REF_PATTERN.test(normalized) ? normalized : null;
}
