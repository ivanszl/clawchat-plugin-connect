import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ClientExtensionGraphView, ClientExtensionView } from "../client-contract";
import type { ConnectPluginClientExtensionCapabilityManifest, RuntimeCapabilityRef } from "./sdk";
import type { InstalledPluginLockEntry } from "./store";

export const CLIENT_EXTENSION_ARTIFACT_PREFIX = "/client/v1/plugin-artifacts";

export interface ResolvedClientExtensionArtifact {
  readonly path: string;
  readonly integrity: string;
  readonly contentType: "text/css; charset=utf-8" | "text/javascript; charset=utf-8";
}

export function deriveClientExtensionGraph(
  installed: readonly InstalledPluginLockEntry[],
  managedWebApp: Readonly<RuntimeCapabilityRef>,
): ClientExtensionGraphView {
  const activePlugins = installed.filter((plugin) => plugin.status === "active");
  const extensions = activePlugins
    .flatMap((plugin) =>
      plugin.manifest.capabilities
        .filter(
          (capability): capability is ConnectPluginClientExtensionCapabilityManifest =>
            capability.type === "client-extension" &&
            sameCapabilityRef(capability.managedWebApp, managedWebApp),
        )
        .map((capability): ClientExtensionView => {
          const artifactBase = `${CLIENT_EXTENSION_ARTIFACT_PREFIX}/${encodeURIComponent(managedWebApp.pluginId)}/${encodeURIComponent(managedWebApp.capabilityId)}/${encodeURIComponent(plugin.pluginId)}/${plugin.activationGeneration}/${encodeURIComponent(capability.id)}`;
          return {
            pluginId: plugin.pluginId,
            capabilityId: capability.id,
            version: plugin.version,
            activationGeneration: plugin.activationGeneration,
            configuration: structuredClone(plugin.capabilityConfigurations[capability.id] ?? {}),
            entry: `${artifactBase}/${encodeBundlePath(capability.browser.entry)}`,
            integrity: capability.browser.integrity,
            styles: capability.browser.styles
              .map((style) => ({
                href: `${artifactBase}/${encodeBundlePath(style.entry)}`,
                integrity: style.integrity,
              }))
              .sort((left, right) => left.href.localeCompare(right.href)),
            slots: capability.browser.slots
              .map((slot) => ({ ...slot }))
              .sort(
                (left, right) =>
                  left.priority - right.priority ||
                  left.id.localeCompare(right.id) ||
                  left.interfaceVersion.localeCompare(right.interfaceVersion),
              ),
          };
        }),
    )
    .sort(compareClientExtensions);
  const selectedBundles = activePlugins
    .filter((plugin) =>
      plugin.manifest.capabilities.some(
        (capability) =>
          capability.type === "client-extension" &&
          sameCapabilityRef(capability.managedWebApp, managedWebApp),
      ),
    )
    .map((plugin) => ({
      pluginId: plugin.pluginId,
      version: plugin.version,
      integrity: plugin.integrity,
      activationGeneration: plugin.activationGeneration,
      configurationRevision: `sha256-${createHash("sha256")
        .update(canonicalJson([plugin.installationConfiguration, plugin.capabilityConfigurations]))
        .digest("base64")}`,
    }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  const hash = `sha256-${createHash("sha256")
    .update(canonicalJson({ managedWebApp, selectedBundles, extensions }))
    .digest("base64")}`;
  return { managedWebApp: { ...managedWebApp }, hash, epoch: hash, extensions };
}

export function assertCurrentClientExtensionEpoch(graph: ClientExtensionGraphView, receivedEpoch: string): void {
  if (receivedEpoch !== graph.epoch) {
    throw new Error("stale Client Extension graph epoch");
  }
}

export function resolveClientExtensionArtifact(
  installed: readonly InstalledPluginLockEntry[],
  managedWebApp: Readonly<RuntimeCapabilityRef>,
  pluginId: string,
  activationGeneration: number,
  capabilityId: string,
  artifactEntry: string,
): ResolvedClientExtensionArtifact | null {
  const plugin = installed.find(
    (candidate) =>
      candidate.pluginId === pluginId &&
      candidate.activationGeneration === activationGeneration &&
      candidate.status === "active",
  );
  if (!plugin) return null;
  const capability = plugin.manifest.capabilities.find(
    (candidate): candidate is ConnectPluginClientExtensionCapabilityManifest =>
      candidate.id === capabilityId && candidate.type === "client-extension",
  );
  if (!capability || !sameCapabilityRef(capability.managedWebApp, managedWebApp)) return null;
  const style = capability.browser.styles.find((candidate) => candidate.entry === artifactEntry);
  const integrity = artifactEntry === capability.browser.entry ? capability.browser.integrity : style?.integrity;
  if (!integrity) return null;
  const root = dirname(plugin.manifestPath);
  const path = resolve(root, artifactEntry);
  const relativePath = relative(root, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
  return {
    path,
    integrity,
    contentType: style ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
  };
}

function sameCapabilityRef(
  left: Readonly<RuntimeCapabilityRef>,
  right: Readonly<RuntimeCapabilityRef>,
): boolean {
  return left.pluginId === right.pluginId && left.capabilityId === right.capabilityId;
}

function compareClientExtensions(left: ClientExtensionView, right: ClientExtensionView): number {
  const leftPriority = left.slots[0]?.priority ?? 0;
  const rightPriority = right.slots[0]?.priority ?? 0;
  return (
    leftPriority - rightPriority ||
    left.pluginId.localeCompare(right.pluginId) ||
    left.capabilityId.localeCompare(right.capabilityId)
  );
}

function encodeBundlePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
