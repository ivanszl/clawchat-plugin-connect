import type {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  ConnectDurableStateHostCapability,
  ConnectPluginArtifactManifest,
  ConnectPluginBundleV1,
  ConnectPluginCapabilityId,
  ConnectPluginCapabilityManifest,
  ConnectPluginConfiguration,
  ConnectPluginContext,
  ConnectPluginDisposer,
  ConnectPluginDurableState,
  ConnectPluginHostCapabilityDependency,
  ConnectPluginId,
  ConnectPluginJsonSchema,
  ConnectPluginManifestV1,
  ConnectRuntimeProviderHostCapability,
} from "./sdk";

export interface OfficialConnectPluginExposureCapabilityManifest {
  id: ConnectPluginCapabilityId;
  type: "exposure";
  interfaceVersion: typeof CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION;
  configurationSchema: ConnectPluginJsonSchema;
  durableState?: import("./sdk").ConnectPluginDurableStateManifest;
}

export interface OfficialExposureProviderHostCapabilityDependency {
  type: "host";
  id: "exposure-provider";
  interfaceVersion: typeof CONNECT_HOST_CAPABILITY_INTERFACE_VERSION;
}

export type ManagedConnectPluginCapabilityManifest =
  | ConnectPluginCapabilityManifest
  | OfficialConnectPluginExposureCapabilityManifest;

export type ManagedConnectPluginHostCapabilityDependency =
  | ConnectPluginHostCapabilityDependency
  | OfficialExposureProviderHostCapabilityDependency;

export interface ManagedConnectPluginManifestV1 extends Omit<ConnectPluginManifestV1, "dependencies" | "capabilities"> {
  manifestVersion: typeof CONNECT_PLUGIN_MANIFEST_VERSION;
  interfaceVersion: typeof CONNECT_PLUGIN_INTERFACE_VERSION;
  pluginId: ConnectPluginId;
  dependencies: ManagedConnectPluginHostCapabilityDependency[];
  capabilities: ManagedConnectPluginCapabilityManifest[];
  artifacts: ConnectPluginArtifactManifest[];
}

export interface ManagedConnectPluginBundleV1 extends Omit<ConnectPluginBundleV1, "manifest"> {
  format: typeof CONNECT_PLUGIN_BUNDLE_FORMAT;
  manifest: ManagedConnectPluginManifestV1;
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

export interface ManagedConnectPluginHostCapabilities {
  get(id: "runtime-provider"): ConnectRuntimeProviderHostCapability;
  get(id: "durable-state"): ConnectDurableStateHostCapability;
  get(id: "exposure-provider"): ConnectExposureProviderHostCapability;
}

export interface ManagedConnectPluginContext extends Omit<ConnectPluginContext, "hostCapabilities"> {
  readonly hostCapabilities: ManagedConnectPluginHostCapabilities;
}

export interface ManagedConnectPluginEntry {
  migrateDurableState?: import("./sdk").ConnectPluginEntry["migrateDurableState"];
  activate(
    context: ManagedConnectPluginContext,
  ): ConnectPluginDisposer | undefined | Promise<ConnectPluginDisposer | undefined>;
}
