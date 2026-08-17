import type * as Astryx from "@astryxdesign/core";
import type * as React from "react";
import type { BindingPreferenceView, UpdateBindingPreferencesRequest } from "../client-contract";
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
  RuntimeWorkspaceSnapshot,
} from "../runtime/types";
import type { RuntimeWorkspace } from "../types";

export const CONNECT_PLUGIN_MANIFEST_VERSION = 1 as const;
export const CONNECT_PLUGIN_INTERFACE_VERSION = "1" as const;
export const CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION = "1" as const;
export const CONNECT_HOST_CAPABILITY_INTERFACE_VERSION = "1" as const;
export const CONNECT_PLUGIN_BUNDLE_FORMAT = "clawchat-connect-plugin-bundle-v1" as const;
export const CONNECT_CLIENT_EXTENSION_SLOT_CATALOG = {
  "kernel.root.after": { interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION },
} as const;
export type ConnectPluginClientExtensionSlotId = keyof typeof CONNECT_CLIENT_EXTENSION_SLOT_CATALOG;

export type ConnectPluginId = string;
export type ConnectPluginCapabilityId = string;
export type ConnectPluginJsonSchema = Readonly<Record<string, unknown>>;

export type ConnectPluginDurableStateLifetime = "installation" | "owner" | "binding";

export interface ConnectPluginDurableStateManifest {
  readonly schemaVersion: number;
  readonly lifetime: ConnectPluginDurableStateLifetime;
  readonly schema: ConnectPluginJsonSchema;
  readonly migrations: readonly { readonly from: number; readonly to: number }[];
}

export interface ConnectPluginDurableStateRecord {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ConnectPluginDurableState {
  read(): Promise<ConnectPluginDurableStateRecord | null>;
  compareAndSwap(
    expectedRevision: number | null,
    value: Readonly<Record<string, unknown>>,
  ): Promise<ConnectPluginDurableStateRecord>;
}

export interface RuntimeCapabilityRef {
  pluginId: ConnectPluginId;
  capabilityId: ConnectPluginCapabilityId;
}

interface ConnectPluginCapabilityManifestBase {
  id: ConnectPluginCapabilityId;
  interfaceVersion: typeof CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION;
  configurationSchema: ConnectPluginJsonSchema;
  durableState?: ConnectPluginDurableStateManifest;
}

export interface ConnectPluginRuntimeCapabilityManifest extends ConnectPluginCapabilityManifestBase {
  type: "runtime";
  family: string;
}

export interface ConnectPluginExposureCapabilityManifest extends ConnectPluginCapabilityManifestBase {
  type: "exposure";
}

export interface ConnectPluginClientExtensionSlotManifest {
  id: ConnectPluginClientExtensionSlotId;
  interfaceVersion: typeof CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION;
  priority: number;
}

export interface ConnectPluginClientExtensionStyleManifest {
  entry: string;
  integrity: string;
}

export interface ConnectPluginClientExtensionBrowserManifest {
  entry: string;
  integrity: string;
  styles: ConnectPluginClientExtensionStyleManifest[];
  slots: ConnectPluginClientExtensionSlotManifest[];
}

export interface ConnectPluginClientExtensionCapabilityManifest
  extends Omit<ConnectPluginCapabilityManifestBase, "durableState"> {
  type: "client-extension";
  browser: ConnectPluginClientExtensionBrowserManifest;
}

export type ConnectPluginCapabilityManifest =
  | ConnectPluginRuntimeCapabilityManifest
  | ConnectPluginExposureCapabilityManifest
  | ConnectPluginClientExtensionCapabilityManifest;

export type ConnectHostCapabilityId = "runtime-provider" | "exposure-provider" | "durable-state";

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

export interface ConnectPluginManifestV1 {
  manifestVersion: typeof CONNECT_PLUGIN_MANIFEST_VERSION;
  interfaceVersion: typeof CONNECT_PLUGIN_INTERFACE_VERSION;
  pluginId: ConnectPluginId;
  version: string;
  dependencies: ConnectPluginHostCapabilityDependency[];
  installationConfigurationSchema: ConnectPluginJsonSchema;
  capabilities: ConnectPluginCapabilityManifest[];
  artifacts: ConnectPluginArtifactManifest[];
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

/**
 * Runtime start data intentionally omits Connect config and persistence paths.
 * A Runtime Plugin can report native Runtime Thread identity only through the
 * supplied callback.
 */
export interface ConnectPluginRuntimeStartContext {
  readonly activationGeneration: number;
  bindingId: string;
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
  discoverWorkspaces?(): Promise<RuntimeWorkspaceSnapshot>;
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

export interface ConnectPluginRuntimeInstanceContext {
  readonly activationGeneration: number;
  readonly durableState?: ConnectPluginDurableState;
}

export interface ConnectPluginRuntimeProvider {
  capabilityId: ConnectPluginCapabilityId;
  family: string;
  create(
    configuration: ConnectPluginConfiguration,
    context: ConnectPluginRuntimeInstanceContext,
  ): ConnectPluginRuntimeAdapter;
}

export interface ConnectRuntimeProviderHostCapability {
  readonly interfaceVersion: typeof CONNECT_HOST_CAPABILITY_INTERFACE_VERSION;

  register(provider: ConnectPluginRuntimeProvider): void;
}

export interface ConnectDurableStateHostCapability {
  readonly interfaceVersion: typeof CONNECT_HOST_CAPABILITY_INTERFACE_VERSION;
  forBinding(capabilityId: ConnectPluginCapabilityId, bindingId: string): ConnectPluginDurableState;
}

export interface ConnectPluginClientExposure {
  fetch(request: Request): Promise<Response>;
}

export interface ConnectPluginExposureActivation {
  readonly activationGeneration: number;
  readonly configuration: ConnectPluginConfiguration;
  readonly client: ConnectPluginClientExposure;
  readonly durableState?: ConnectPluginDurableState;
}

export interface ConnectPluginExposureProvider {
  readonly capabilityId: ConnectPluginCapabilityId;
  activate(
    activation: ConnectPluginExposureActivation,
  ): ConnectPluginDisposer | undefined | Promise<ConnectPluginDisposer | undefined>;
}

export interface ConnectExposureProviderHostCapability {
  readonly interfaceVersion: typeof CONNECT_HOST_CAPABILITY_INTERFACE_VERSION;
  register(provider: ConnectPluginExposureProvider): void;
}
export type ConnectPluginClientExtensionComponent = React.ComponentType;

export interface ConnectPluginClientExtensionServices {
  readonly bindingPreferences: {
    update(
      bindingId: string,
      updates: Omit<UpdateBindingPreferencesRequest, "requestId" | "clientExtensionEpoch">,
    ): Promise<BindingPreferenceView>;
  };
}

export interface ConnectPluginClientExtensionContext {
  readonly epoch: string;
  readonly configuration: ConnectPluginConfiguration;
  readonly React: typeof React;
  readonly Astryx: typeof Astryx;
  readonly slots: {
    register(
      slotId: ConnectPluginClientExtensionSlotId,
      component: ConnectPluginClientExtensionComponent,
    ): ConnectPluginDisposer;
  };
  readonly effects: {
    add(disposer: ConnectPluginDisposer): ConnectPluginDisposer;
    setTimeout(callback: () => void, delay: number): ConnectPluginDisposer;
    setInterval(callback: () => void, delay: number): ConnectPluginDisposer;
  };
  readonly client: ConnectPluginClientExtensionServices;
}

export interface ConnectPluginClientExtensionEntry {
  activate(
    context: ConnectPluginClientExtensionContext,
  ): ConnectPluginDisposer | undefined | Promise<ConnectPluginDisposer | undefined>;
}

export interface ConnectPluginHostCapabilities {
  get(id: "runtime-provider"): ConnectRuntimeProviderHostCapability;
  get(id: "exposure-provider"): ConnectExposureProviderHostCapability;
  get(id: "durable-state"): ConnectDurableStateHostCapability;
}

/**
 * The complete public host facade. It exposes immutable Bundle configuration
 * and only manifest-declared provider registration and Durable State capabilities.
 */
export interface ConnectPluginContext {
  readonly activationGeneration: number;
  readonly interfaceVersion: typeof CONNECT_PLUGIN_INTERFACE_VERSION;
  readonly installationConfiguration: ConnectPluginConfiguration;
  readonly hostCapabilities: ConnectPluginHostCapabilities;
}

export type ConnectPluginDisposer = () => void | Promise<void>;

export interface ConnectPluginDurableStateMigration {
  readonly capabilityId: ConnectPluginCapabilityId;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ConnectPluginDurableStateGenerationMigration {
  readonly capabilityId: ConnectPluginCapabilityId;
  readonly capabilityInstanceId: string;
  readonly schemaVersion: number;
  readonly fromActivationGeneration: number;
  readonly toActivationGeneration: number;
  readonly reactivating: boolean;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ConnectPluginEntry {
  migrateDurableState?(
    migration: ConnectPluginDurableStateMigration,
  ): Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  migrateDurableStateGeneration?(
    migration: ConnectPluginDurableStateGenerationMigration,
  ): Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  activate(
    context: ConnectPluginContext,
  ): ConnectPluginDisposer | undefined | Promise<ConnectPluginDisposer | undefined>;
}

export type { ConnectRuntimePrompt };
