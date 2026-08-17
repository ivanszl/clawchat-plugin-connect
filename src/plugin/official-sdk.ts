import type {
  ConnectExposureProviderHostCapability,
  ConnectPluginBundleV1,
  ConnectPluginCapabilityManifest,
  ConnectPluginClientExposure,
  ConnectPluginContext,
  ConnectPluginEntry,
  ConnectPluginExposureActivation,
  ConnectPluginExposureCapabilityManifest,
  ConnectPluginExposureProvider,
  ConnectPluginHostCapabilities,
  ConnectPluginHostCapabilityDependency,
  ConnectPluginManifestV1,
} from "./sdk";

/**
 * Compatibility names retained for Core code while Client Exposure is moved
 * into the public Plugin SDK.
 */
export type OfficialConnectPluginExposureCapabilityManifest = ConnectPluginExposureCapabilityManifest;
export type OfficialExposureProviderHostCapabilityDependency = Omit<ConnectPluginHostCapabilityDependency, "id"> & {
  id: "exposure-provider";
};
export type ManagedConnectPluginCapabilityManifest = ConnectPluginCapabilityManifest;
export type ManagedConnectPluginHostCapabilityDependency = ConnectPluginHostCapabilityDependency;
export type ManagedConnectPluginManifestV1 = ConnectPluginManifestV1;
export type ManagedConnectPluginBundleV1 = ConnectPluginBundleV1;
export type ManagedConnectPluginHostCapabilities = ConnectPluginHostCapabilities;
export type ManagedConnectPluginContext = ConnectPluginContext;
export type ManagedConnectPluginEntry = ConnectPluginEntry;

export type {
  ConnectExposureProviderHostCapability,
  ConnectPluginClientExposure,
  ConnectPluginExposureActivation,
  ConnectPluginExposureProvider,
};
