import type {
  ConnectRuntimeMedia,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  RuntimeActivitySnapshot,
  RuntimeCatalogScope,
  RuntimeCommandSummary,
  RuntimeInputMessageIdentity,
  RuntimeInputReconciliation,
  RuntimeLifecycleCapabilities,
  RuntimeModelOption,
  RuntimeSessionOption,
  RuntimeSkillSummary,
  RuntimeThreadSummary,
} from "../runtime/types";
import type { RuntimeWorkspace } from "../types";

export const CONNECT_PLUGIN_MANIFEST_VERSION = 1 as const;
export const CONNECT_PLUGIN_INTERFACE_VERSION = "1" as const;
export const CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION = "1" as const;
export const CONNECT_HOST_CAPABILITY_INTERFACE_VERSION = "1" as const;
export const CONNECT_PLUGIN_BUNDLE_FORMAT = "clawchat-connect-plugin-bundle-v1" as const;

export type ConnectPluginId = string;
export type ConnectPluginCapabilityId = string;
export type ConnectPluginJsonSchema = Readonly<Record<string, unknown>>;

export interface RuntimeCapabilityRef {
  pluginId: ConnectPluginId;
  capabilityId: ConnectPluginCapabilityId;
}

interface ConnectPluginCapabilityManifestBase {
  id: ConnectPluginCapabilityId;
  interfaceVersion: typeof CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION;
  configurationSchema: ConnectPluginJsonSchema;
}

export interface ConnectPluginRuntimeCapabilityManifest extends ConnectPluginCapabilityManifestBase {
  type: "runtime";
  family: string;
}

export interface ConnectPluginExposureCapabilityManifest extends ConnectPluginCapabilityManifestBase {
  type: "exposure";
}

export type ConnectPluginCapabilityManifest =
  | ConnectPluginRuntimeCapabilityManifest
  | ConnectPluginExposureCapabilityManifest;

export type ConnectHostCapabilityId = "runtime-provider" | "exposure-provider";

export interface ConnectPluginHostCapabilityDependency {
  type: "host";
  id: ConnectHostCapabilityId;
  interfaceVersion: typeof CONNECT_HOST_CAPABILITY_INTERFACE_VERSION;
}

export interface ConnectPluginArtifactManifest {
  target: string;
  entry: string;
  integrity: string;
}
export interface ConnectPluginProbeManifest {
  entry: string;
  integrity: string;
}

export interface ConnectPluginManifestV1 {
  manifestVersion: typeof CONNECT_PLUGIN_MANIFEST_VERSION;
  interfaceVersion: typeof CONNECT_PLUGIN_INTERFACE_VERSION;
  pluginId: ConnectPluginId;
  version: string;
  dependencies: ConnectPluginHostCapabilityDependency[];
  installationConfigurationSchema: ConnectPluginJsonSchema;
  capabilities: ConnectPluginCapabilityManifest[];
  artifacts: ConnectPluginArtifactManifest[];
  probe?: ConnectPluginProbeManifest;
}

export interface LocalPluginSource {
  type: "local";
  path: string;
}

export interface NpmPluginSource {
  type: "npm";
  package: string;
  registry: string;
  version: string;
  tarball: string;
}

export interface GitHubPluginSource {
  type: "github";
  repository: string;
  apiBase: string;
  version: string;
  release: string;
  asset: string;
}

export type ConnectPluginSource = LocalPluginSource | NpmPluginSource | GitHubPluginSource;

export interface ConnectPluginBundleV1 {
  format: typeof CONNECT_PLUGIN_BUNDLE_FORMAT;
  manifest: ConnectPluginManifestV1;
  files: Record<string, { encoding: "utf8" | "base64"; content: string }>;
}

export type ConnectPluginConfiguration = Readonly<Record<string, unknown>>;
export interface ConnectPluginRuntimeProbeContext {
  readonly platform: string;
  readonly arch: string;
  findExecutable(command: string): Promise<string | null>;
}

export interface ConnectPluginRuntimeProbeResult {
  detected: boolean;
  compatible: boolean;
  version?: string;
  path?: string;
  detail?: string;
}

export interface ConnectPluginProbeEntry {
  probe(
    context: ConnectPluginRuntimeProbeContext,
  ): ConnectPluginRuntimeProbeResult | Promise<ConnectPluginRuntimeProbeResult>;
}

/**
 * Runtime start data intentionally omits Connect config and persistence paths.
 * A Runtime Plugin can report native Runtime Thread identity only through the
 * supplied callback.
 */
export interface ConnectPluginRuntimeStartContext {
  agentId: string;
  chatId: string;
  sessionId: string;
  runtimeThreadId: string | null;
  onRuntimeThreadId(runtimeThreadId: string): Promise<void>;
  cacheMedia(media: ConnectRuntimeMedia, trustedOrigins?: readonly string[]): Promise<string>;
}

/**
 * The public Runtime Adapter contract. A provider factory receives one
 * Binding's immutable capability configuration, so operations never receive
 * an Agent Binding or any mutable Connect domain module.
 */
export interface ConnectPluginRuntimeAdapter {
  readonly modes: readonly string[];
  readonly lifecycleCapabilities?: RuntimeLifecycleCapabilities;
  prepare?(): Promise<void>;
  modesFor?(scope?: RuntimeCatalogScope): readonly string[];
  listModels?(scope?: RuntimeCatalogScope): Promise<RuntimeModelOption[]>;
  listSessionOptions?(workspace: RuntimeWorkspace, scope?: RuntimeCatalogScope): Promise<RuntimeSessionOption[]>;
  listSkills?(
    workspace: RuntimeWorkspace,
    options?: { forceRefresh?: boolean; runtimeThreadId?: string },
  ): Promise<RuntimeSkillSummary[]>;
  onSkillsChanged?(listener: () => void): () => void;
  listCommands?(
    workspace: RuntimeWorkspace,
    options?: { forceRefresh?: boolean; runtimeThreadId?: string },
  ): Promise<RuntimeCommandSummary[]>;
  onCommandsChanged?(listener: () => void): () => void;
  onCatalogsChanged?(listener: () => void): () => void;
  discoverThreads?(workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]>;
  discoverAllThreads?(): Promise<RuntimeThreadSummary[]>;
  discoverArchivedThreads?(): Promise<RuntimeThreadSummary[]>;
  verifyThreadReady?(runtimeThreadId: string): Promise<void>;
  readActivity?(runtimeThreadId: string): Promise<RuntimeActivitySnapshot>;
  reconcileInput?(runtimeThreadId: string, candidate: RuntimeInputMessageIdentity): Promise<RuntimeInputReconciliation>;
  archiveThread?(runtimeThreadId: string): Promise<void>;
  unarchiveThread?(runtimeThreadId: string): Promise<void>;
  deleteThread?(runtimeThreadId: string): Promise<void>;
  start(context: ConnectPluginRuntimeStartContext): Promise<ConnectRuntimeSession>;
  close?(): Promise<void>;
}

export interface ConnectPluginRuntimeProvider {
  capabilityId: ConnectPluginCapabilityId;
  family: string;
  create(configuration: ConnectPluginConfiguration): ConnectPluginRuntimeAdapter;
}

/**
 * The complete public Client facade available to Exposure capabilities.
 * Requests are forwarded to this Connect installation without revealing its
 * loopback origin or any mutable Connect service module.
 */
export interface ConnectPluginClientExposure {
  fetch(request: Request): Promise<Response>;
}

export interface ConnectPluginExposureActivation {
  readonly configuration: ConnectPluginConfiguration;
  readonly client: ConnectPluginClientExposure;
}

export interface ConnectPluginExposureProvider {
  capabilityId: ConnectPluginCapabilityId;
  activate(
    activation: ConnectPluginExposureActivation,
  ): ConnectPluginDisposer | undefined | Promise<ConnectPluginDisposer | undefined>;
}

export interface ConnectRuntimeProviderHostCapability {
  readonly interfaceVersion: typeof CONNECT_HOST_CAPABILITY_INTERFACE_VERSION;
  register(provider: ConnectPluginRuntimeProvider): void;
}

export interface ConnectExposureProviderHostCapability {
  readonly interfaceVersion: typeof CONNECT_HOST_CAPABILITY_INTERFACE_VERSION;
  register(provider: ConnectPluginExposureProvider): void;
}

export interface ConnectPluginHostCapabilities {
  get(id: "runtime-provider"): ConnectRuntimeProviderHostCapability;
  get(id: "exposure-provider"): ConnectExposureProviderHostCapability;
}

/**
 * The complete public host facade. It exposes immutable Bundle configuration
 * and only manifest-declared Runtime/Exposure registration capabilities.
 */
export interface ConnectPluginContext {
  readonly interfaceVersion: typeof CONNECT_PLUGIN_INTERFACE_VERSION;
  readonly installationConfiguration: ConnectPluginConfiguration;
  readonly hostCapabilities: ConnectPluginHostCapabilities;
}

export type ConnectPluginDisposer = () => void | Promise<void>;

export interface ConnectPluginEntry {
  activate(
    context: ConnectPluginContext,
  ): ConnectPluginDisposer | undefined | Promise<ConnectPluginDisposer | undefined>;
}

export type { ConnectRuntimePrompt };
