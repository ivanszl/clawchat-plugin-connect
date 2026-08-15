import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AgentBindingConfig } from "../types";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectHostCapabilityId,
  type ConnectPluginArtifactManifest,
  type ConnectPluginBundleV1,
  type ConnectPluginCapabilityManifest,
  type ConnectPluginConfiguration,
  type ConnectPluginHostCapabilityDependency,
  type ConnectPluginJsonSchema,
  type ConnectPluginManifestV1,
  type ConnectPluginSource,
} from "./sdk";

export const CONNECT_PLUGIN_LOCK_FORMAT = "clawchat-connect-plugin-lock-v1" as const;

export type InstalledPluginStatus = "active" | "disabled" | "error";

export interface InstalledPluginVersion {
  source: ConnectPluginSource;
  version: string;
  target: string;
  integrity: string;
  activeArtifact: string;
  manifestPath: string;
  manifest: ConnectPluginManifestV1;
  installationConfiguration: ConnectPluginConfiguration;
  exposureConfigurations: Readonly<Record<string, ConnectPluginConfiguration>>;
}

export interface InstalledPluginLockEntry extends InstalledPluginVersion {
  pluginId: string;
  status: InstalledPluginStatus;
  error: string | null;
  retainedVersions: InstalledPluginVersion[];
}

export interface ConnectPluginLockfileV1 {
  format: typeof CONNECT_PLUGIN_LOCK_FORMAT;
  plugins: Record<string, InstalledPluginLockEntry>;
}

export interface InstallLocalPluginOptions {
  configPath: string;
  bundlePath: string;
  target?: string;
  installationConfiguration?: Record<string, unknown>;
  exposureConfigurations?: Record<string, unknown>;
}
export interface StagePluginBundleOptions {
  configPath: string;
  source: ConnectPluginSource;
  bundle: ConnectPluginBundleV1;
  target?: string;
  installationConfiguration?: Record<string, unknown>;
  exposureConfigurations?: Record<string, unknown>;
}

export interface PluginInstallationPaths {
  root: string;
  store: string;
  lockfile: string;
}

export interface StagedPlugin {
  readonly entry: InstalledPluginLockEntry;
  readonly artifactRoot: string;
  readonly createdArtifact: boolean;
}

export function currentConnectPluginTarget(): string {
  return `${process.platform}-${process.arch}`;
}

export function pluginInstallationPaths(configPath: string): PluginInstallationPaths {
  const root = dirname(resolve(configPath));
  return {
    root,
    store: resolve(root, "plugins"),
    lockfile: resolve(root, "plugins.lock.json"),
  };
}

export async function stageLocalPlugin(options: InstallLocalPluginOptions): Promise<StagedPlugin> {
  const sourcePath = resolve(options.bundlePath);
  return await stagePluginBundle({
    ...options,
    source: { type: "local", path: sourcePath },
    bundle: await readConnectPluginBundle(sourcePath),
  });
}

export async function stagePluginBundle(options: StagePluginBundleOptions): Promise<StagedPlugin> {
  const { source, bundle } = options;
  if (source.type !== "local" && source.version !== bundle.manifest.version) {
    throw new Error(
      `Resolved ${source.type} source version ${source.version} does not match Bundle version ${bundle.manifest.version}`,
    );
  }
  const target = options.target ?? currentConnectPluginTarget();
  const artifact = selectArtifact(bundle.manifest, target);
  const installationConfiguration = validatePluginConfiguration(
    bundle.manifest.installationConfigurationSchema,
    options.installationConfiguration ?? {},
    `Plugin ${bundle.manifest.pluginId} installation configuration`,
  );
  const exposureConfigurations = validateExposureConfigurations(bundle.manifest, options.exposureConfigurations ?? {});
  const entryBytes = connectPluginBundleFileBytes(bundle, artifact.entry);
  verifyConnectPluginIntegrity(entryBytes, artifact.integrity, `${bundle.manifest.pluginId} ${artifact.entry}`);
  if (bundle.manifest.probe) {
    verifyConnectPluginIntegrity(
      connectPluginBundleFileBytes(bundle, bundle.manifest.probe.entry),
      bundle.manifest.probe.integrity,
      `${bundle.manifest.pluginId} runtime probe`,
    );
  }

  const paths = pluginInstallationPaths(options.configPath);
  await mkdir(paths.store, { recursive: true, mode: 0o700 });
  const identitySegment = createHash("sha256").update(bundle.manifest.pluginId).digest("hex");
  const versionSegment = encodeURIComponent(bundle.manifest.version);
  const artifactSegment = createHash("sha256").update(entryBytes).digest("hex");
  const installedRoot = resolve(paths.store, identitySegment, versionSegment, artifactSegment);
  assertWithin(paths.store, installedRoot, "Plugin artifact");
  const stagingRoot = resolve(paths.store, ".staging", randomUUID());
  const activeArtifact = resolve(installedRoot, artifact.entry);
  const manifestPath = resolve(installedRoot, "connect-plugin.json");
  const createdArtifact = !existsSync(installedRoot);

  try {
    if (createdArtifact) {
      await writeStagedBundle(stagingRoot, bundle);
      await mkdir(dirname(installedRoot), { recursive: true, mode: 0o700 });
      try {
        await rename(stagingRoot, installedRoot);
      } catch (error) {
        if (!existsSync(installedRoot)) throw error;
      }
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const installedBytes = new Uint8Array(await readFile(activeArtifact));
  verifyConnectPluginIntegrity(installedBytes, artifact.integrity, `${bundle.manifest.pluginId} installed artifact`);
  return {
    artifactRoot: installedRoot,
    createdArtifact,
    entry: {
      pluginId: bundle.manifest.pluginId,
      source,
      version: bundle.manifest.version,
      target,
      integrity: artifact.integrity,
      activeArtifact,
      manifestPath,
      manifest: structuredClone(bundle.manifest),
      installationConfiguration,
      exposureConfigurations,
      status: "active",
      error: null,
      retainedVersions: [],
    },
  };
}
export async function installLocalPlugin(options: InstallLocalPluginOptions): Promise<InstalledPluginLockEntry> {
  const sourcePath = resolve(options.bundlePath);
  return await installPluginBundle({
    ...options,
    source: { type: "local", path: sourcePath },
    bundle: await readConnectPluginBundle(sourcePath),
  });
}

export async function installPluginBundle(options: StagePluginBundleOptions): Promise<InstalledPluginLockEntry> {
  const staged = await stagePluginBundle(options);
  try {
    return await commitStagedPlugin(options.configPath, staged, "install");
  } catch (error) {
    await discardStagedPlugin(options.configPath, staged).catch(() => undefined);
    throw error;
  }
}

export async function commitStagedPlugin(
  configPath: string,
  staged: StagedPlugin,
  operation: "install" | "update" | "select",
): Promise<InstalledPluginLockEntry> {
  const paths = pluginInstallationPaths(configPath);
  let committed!: InstalledPluginLockEntry;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const existing = lockfile.plugins[staged.entry.pluginId];
    if (operation === "install" && existing) {
      throw new Error(`Plugin identity is already installed: ${staged.entry.pluginId}`);
    }
    if (operation !== "install" && !existing) {
      throw new Error(`Plugin is not installed: ${staged.entry.pluginId}`);
    }
    if (
      operation === "update" &&
      existing &&
      pluginSourceIdentity(existing.source) !== pluginSourceIdentity(staged.entry.source)
    ) {
      throw new Error(`Plugin ${staged.entry.pluginId} source is immutable during update`);
    }
    const retained = existing
      ? deduplicateVersions([...existing.retainedVersions, installedVersion(existing)]).filter(
          (candidate) => !samePluginVersion(candidate, staged.entry),
        )
      : [];
    committed = {
      ...staged.entry,
      status: "active",
      error: null,
      retainedVersions: retained,
    };
    return { ...lockfile, plugins: { ...lockfile.plugins, [committed.pluginId]: committed } };
  });
  return committed;
}

export async function listInstalledPlugins(configPath: string): Promise<InstalledPluginLockEntry[]> {
  const paths = pluginInstallationPaths(configPath);
  const lockfile = await readPluginLockfile(paths.lockfile);
  return Object.values(lockfile.plugins)
    .map((entry) => validateLockEntry(entry, paths.store))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export async function removeInstalledPlugin(configPath: string, pluginId: string): Promise<InstalledPluginLockEntry> {
  const id = requireIdentity(pluginId, "Plugin ID");
  const paths = pluginInstallationPaths(configPath);
  let removed: InstalledPluginLockEntry | undefined;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    removed = lockfile.plugins[id];
    if (!removed) throw new Error(`Plugin is not installed: ${id}`);
    const plugins = { ...lockfile.plugins };
    delete plugins[id];
    return { ...lockfile, plugins };
  });
  return validateLockEntry(removed, paths.store);
}

export async function setInstalledPluginStatus(
  configPath: string,
  pluginId: string,
  status: InstalledPluginStatus,
  error: unknown = null,
): Promise<InstalledPluginLockEntry> {
  const paths = pluginInstallationPaths(configPath);
  let updated!: InstalledPluginLockEntry;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const installed = lockfile.plugins[pluginId];
    if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
    updated = {
      ...installed,
      status,
      error: error === null ? null : error instanceof Error ? error.message : String(error),
    };
    return { ...lockfile, plugins: { ...lockfile.plugins, [pluginId]: updated } };
  });
  return validateLockEntry(updated, paths.store);
}
export async function updateInstalledPluginConfiguration(
  configPath: string,
  pluginId: string,
  installationConfiguration: unknown,
  exposureConfigurations: unknown,
): Promise<InstalledPluginLockEntry> {
  const paths = pluginInstallationPaths(configPath);
  let updated!: InstalledPluginLockEntry;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const installed = lockfile.plugins[pluginId];
    if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
    const validatedInstallation = validatePluginConfiguration(
      installed.manifest.installationConfigurationSchema,
      installationConfiguration,
      `Plugin ${pluginId} installation configuration`,
    );
    const validatedExposures = validateExposureConfigurations(installed.manifest, exposureConfigurations);
    updated = {
      ...installed,
      installationConfiguration: validatedInstallation,
      exposureConfigurations: validatedExposures,
      error: null,
    };
    return { ...lockfile, plugins: { ...lockfile.plugins, [pluginId]: updated } };
  });
  return validateLockEntry(updated, paths.store);
}

export async function recordInstalledPluginError(
  configPath: string,
  pluginId: string,
  error: unknown,
  preserveActive = false,
): Promise<void> {
  const paths = pluginInstallationPaths(configPath);
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const installed = lockfile.plugins[pluginId];
    if (!installed) return lockfile;
    return {
      ...lockfile,
      plugins: {
        ...lockfile.plugins,
        [pluginId]: {
          ...installed,
          status: preserveActive && installed.status === "active" ? "active" : "error",
          error: error instanceof Error ? error.message : String(error),
        },
      },
    };
  });
}

export async function selectInstalledPluginVersion(
  configPath: string,
  pluginId: string,
  version: string,
  integrity?: string,
): Promise<StagedPlugin> {
  const installed = (await listInstalledPlugins(configPath)).find((candidate) => candidate.pluginId === pluginId);
  if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
  const selected = installed.retainedVersions.find(
    (candidate) => candidate.version === version && (!integrity || candidate.integrity === integrity),
  );
  if (!selected) {
    throw new Error(
      `Plugin ${pluginId} has no retained version ${version}${integrity ? ` with integrity ${integrity}` : ""}`,
    );
  }
  return {
    artifactRoot: dirname(selected.manifestPath),
    createdArtifact: false,
    entry: {
      pluginId,
      ...structuredClone(selected),
      status: "active",
      error: null,
      retainedVersions: [],
    },
  };
}

export async function revalidateInstalledPlugin(entry: InstalledPluginLockEntry): Promise<void> {
  const manifestValue = JSON.parse(await readFile(entry.manifestPath, "utf8")) as unknown;
  if (!isRecord(manifestValue)) throw new Error(`Installed Plugin ${entry.pluginId} manifest is malformed`);
  const manifest = validateManifest(manifestValue);
  if (manifest.pluginId !== entry.pluginId || manifest.version !== entry.version) {
    throw new Error(`Installed Plugin ${entry.pluginId} manifest changed after installation`);
  }
  const bytes = new Uint8Array(await readFile(entry.activeArtifact));
  verifyConnectPluginIntegrity(bytes, entry.integrity, `${entry.pluginId} installed artifact`);
}

export async function discardStagedPlugin(configPath: string, staged: StagedPlugin): Promise<void> {
  if (!staged.createdArtifact) return;
  const installed = await listInstalledPlugins(configPath);
  const referenced = installed.some(
    (entry) =>
      entry.activeArtifact === staged.entry.activeArtifact ||
      entry.retainedVersions.some((candidate) => candidate.activeArtifact === staged.entry.activeArtifact),
  );
  if (!referenced) await rm(staged.artifactRoot, { recursive: true, force: true });
}

export async function removePluginArtifacts(configPath: string, pluginId: string): Promise<void> {
  const paths = pluginInstallationPaths(configPath);
  const identitySegment = createHash("sha256").update(pluginId).digest("hex");
  const identityRoot = resolve(paths.store, identitySegment);
  assertWithin(paths.store, identityRoot, "Plugin artifact");
  await rm(identityRoot, { recursive: true, force: true });
}

export async function readConnectPluginBundle(path: string): Promise<ConnectPluginBundleV1> {
  try {
    return parseConnectPluginBundle(await readFile(path, "utf8"), path);
  } catch (error) {
    throw new Error(
      `Could not read Connect Plugin Bundle ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseConnectPluginBundle(value: string | Uint8Array, label = "source"): ConnectPluginBundleV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)) as unknown;
  } catch (error) {
    throw new Error(
      `Connect Plugin Bundle ${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateBundle(parsed);
}

async function writeStagedBundle(root: string, bundle: ConnectPluginBundleV1): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [path, file] of Object.entries(bundle.files)) {
    const outputPath = resolve(root, path);
    assertWithin(root, outputPath, "Bundle file");
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, connectPluginBundleFileBytes(bundle, path), { mode: 0o600 });
  }
  await writeFile(resolve(root, "connect-plugin.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readPluginLockfile(path: string): Promise<ConnectPluginLockfileV1> {
  if (!existsSync(path)) return { format: CONNECT_PLUGIN_LOCK_FORMAT, plugins: {} };
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(value) || value.format !== CONNECT_PLUGIN_LOCK_FORMAT || !isRecord(value.plugins)) {
    throw new Error(`Unsupported or malformed Connect Plugin lockfile: ${path}`);
  }
  return value as unknown as ConnectPluginLockfileV1;
}

async function updatePluginLockfile(
  path: string,
  update: (lockfile: ConnectPluginLockfileV1) => ConnectPluginLockfileV1,
): Promise<void> {
  const next = update(await readPluginLockfile(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateBundle(value: unknown): ConnectPluginBundleV1 {
  if (!isRecord(value) || value.format !== CONNECT_PLUGIN_BUNDLE_FORMAT || !isRecord(value.manifest)) {
    throw new Error("Unsupported or malformed Connect Plugin Bundle");
  }
  const manifest = validateManifest(value.manifest);
  if (!isRecord(value.files)) throw new Error("Connect Plugin Bundle files are required");
  const files: ConnectPluginBundleV1["files"] = {};
  for (const [path, file] of Object.entries(value.files)) {
    requireBundlePath(path);
    if (
      !isRecord(file) ||
      (file.encoding !== "utf8" && file.encoding !== "base64") ||
      typeof file.content !== "string"
    ) {
      throw new Error(`Connect Plugin Bundle file ${path} is malformed`);
    }
    files[path] = { encoding: file.encoding, content: file.content };
  }
  for (const artifact of manifest.artifacts) {
    if (!files[artifact.entry]) throw new Error(`Connect Plugin entry artifact is missing: ${artifact.entry}`);
  }
  if (manifest.probe && !files[manifest.probe.entry]) {
    throw new Error(`Connect Plugin probe artifact is missing: ${manifest.probe.entry}`);
  }
  return { format: CONNECT_PLUGIN_BUNDLE_FORMAT, manifest, files };
}

function validateManifest(value: Record<string, unknown>): ConnectPluginManifestV1 {
  assertOnlyKeys(
    value,
    [
      "manifestVersion",
      "interfaceVersion",
      "pluginId",
      "version",
      "dependencies",
      "installationConfigurationSchema",
      "capabilities",
      "artifacts",
      "probe",
    ],
    "Connect Plugin manifest",
  );
  if (value.manifestVersion !== CONNECT_PLUGIN_MANIFEST_VERSION) {
    throw new Error(`Unsupported Connect Plugin manifest version: ${String(value.manifestVersion)}`);
  }
  if (value.interfaceVersion !== CONNECT_PLUGIN_INTERFACE_VERSION) {
    throw new Error(`Unsupported Connect Plugin interface version: ${String(value.interfaceVersion)}`);
  }
  const pluginId = requireIdentity(value.pluginId, "Plugin ID");
  const version = requireText(value.version, "Plugin version");
  const installationConfigurationSchema = validateConfigurationSchema(
    value.installationConfigurationSchema,
    `Plugin ${pluginId} installation configuration schema`,
  );
  if (!Array.isArray(value.dependencies))
    throw new Error(`Plugin ${pluginId} Host Capability dependencies are required`);
  const dependencyIds = new Set<ConnectHostCapabilityId>();
  const dependencies = value.dependencies.map((candidate): ConnectPluginHostCapabilityDependency => {
    if (!isRecord(candidate)) throw new Error(`Plugin ${pluginId} dependency is malformed`);
    if (candidate.type !== "host") {
      throw new Error(
        `Plugin ${pluginId} may depend only on Connect Host Capabilities; user-plugin dependencies are prohibited`,
      );
    }
    assertOnlyKeys(candidate, ["type", "id", "interfaceVersion"], `Plugin ${pluginId} Host Capability dependency`);
    if (candidate.id !== "runtime-provider" && candidate.id !== "exposure-provider") {
      throw new Error(`Plugin ${pluginId} requests unsupported Host Capability: ${String(candidate.id)}`);
    }
    if (candidate.interfaceVersion !== CONNECT_HOST_CAPABILITY_INTERFACE_VERSION) {
      throw new Error(
        `Plugin ${pluginId} requests unsupported ${candidate.id} Host Capability interface version: ${String(candidate.interfaceVersion)}`,
      );
    }
    if (dependencyIds.has(candidate.id)) {
      throw new Error(`Plugin ${pluginId} declares Host Capability ${candidate.id} more than once`);
    }
    dependencyIds.add(candidate.id);
    return {
      type: "host",
      id: candidate.id,
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
    };
  });
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new Error("Connect Plugin must declare at least one capability");
  }
  const capabilityIds = new Set<string>();
  const capabilities = value.capabilities.map((candidate): ConnectPluginCapabilityManifest => {
    if (!isRecord(candidate)) throw new Error(`Plugin ${pluginId} capability is malformed`);
    if (candidate.type !== "runtime" && candidate.type !== "exposure") {
      throw new Error(`Plugin ${pluginId} declares unsupported capability type: ${String(candidate.type)}`);
    }
    assertOnlyKeys(
      candidate,
      candidate.type === "runtime"
        ? ["id", "type", "interfaceVersion", "family", "configurationSchema"]
        : ["id", "type", "interfaceVersion", "configurationSchema"],
      `Plugin ${pluginId} ${candidate.type} capability`,
    );
    const id = requireIdentity(candidate.id, "Capability ID");
    if (capabilityIds.has(id)) throw new Error(`Duplicate Plugin capability ID: ${id}`);
    capabilityIds.add(id);
    if (candidate.interfaceVersion !== CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION) {
      throw new Error(
        `Plugin ${pluginId}/${id} uses unsupported ${candidate.type} capability interface version: ${String(candidate.interfaceVersion)}`,
      );
    }
    const requiredHostCapability = candidate.type === "runtime" ? "runtime-provider" : "exposure-provider";
    if (!dependencyIds.has(requiredHostCapability)) {
      throw new Error(`Plugin ${pluginId}/${id} must declare Host Capability ${requiredHostCapability}`);
    }
    const configurationSchema = validateConfigurationSchema(
      candidate.configurationSchema,
      `Plugin ${pluginId}/${id} configuration schema`,
    );
    return candidate.type === "runtime"
      ? {
          id,
          type: "runtime",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          family: requireIdentity(candidate.family, "Runtime family"),
          configurationSchema,
        }
      : {
          id,
          type: "exposure",
          interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
          configurationSchema,
        };
  });
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error("Connect Plugin must declare at least one target artifact");
  }
  const targets = new Set<string>();
  const artifacts = value.artifacts.map((candidate): ConnectPluginArtifactManifest => {
    if (!isRecord(candidate)) throw new Error("Connect Plugin artifact is malformed");
    assertOnlyKeys(candidate, ["target", "entry", "integrity"], `Plugin ${pluginId} artifact`);
    const target = requireIdentity(candidate.target, "Plugin target");
    if (targets.has(target)) throw new Error(`Duplicate Plugin target artifact: ${target}`);
    targets.add(target);
    const entry = requireBundlePath(candidate.entry);
    const integrity = requireSha256Integrity(candidate.integrity, "Plugin artifact integrity");
    return { target, entry, integrity };
  });
  let probe: ConnectPluginManifestV1["probe"];
  if (value.probe !== undefined) {
    if (!isRecord(value.probe)) throw new Error(`Plugin ${pluginId} probe is malformed`);
    assertOnlyKeys(value.probe, ["entry", "integrity"], `Plugin ${pluginId} probe`);
    probe = {
      entry: requireBundlePath(value.probe.entry),
      integrity: requireSha256Integrity(value.probe.integrity, "Plugin probe integrity"),
    };
  }
  return {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId,
    version,
    dependencies,
    installationConfigurationSchema,
    capabilities,
    artifacts,
    ...(probe ? { probe } : {}),
  };
}

function requireSha256Integrity(value: unknown, label: string): string {
  const integrity = requireText(value, label);
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/u.test(integrity)) {
    throw new Error(`${label} must be an exact sha256 SRI value`);
  }
  return integrity;
}

function selectArtifact(manifest: ConnectPluginManifestV1, target: string): ConnectPluginArtifactManifest {
  const artifact = manifest.artifacts.find((candidate) => candidate.target === target);
  if (!artifact) throw new Error(`Plugin ${manifest.pluginId} does not support Connect target ${target}`);
  return artifact;
}

export function connectPluginBundleFileBytes(bundle: ConnectPluginBundleV1, path: string): Uint8Array {
  const file = bundle.files[path];
  if (!file) throw new Error(`Connect Plugin Bundle file is missing: ${path}`);
  return file.encoding === "utf8"
    ? new TextEncoder().encode(file.content)
    : Uint8Array.from(Buffer.from(file.content, "base64"));
}

export function verifyConnectPluginIntegrity(bytes: Uint8Array, expected: string, label: string): void {
  const actual = `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
  if (actual !== expected) throw new Error(`${label} integrity mismatch: expected ${expected}, received ${actual}`);
}

function validateLockEntry(value: unknown, store: string): InstalledPluginLockEntry {
  if (!isRecord(value)) throw new Error("Malformed installed Plugin lock entry");
  const pluginId = requireIdentity(value.pluginId, "Installed Plugin ID");
  const active = validateInstalledVersion(value, store, pluginId);
  if (value.status !== "active" && value.status !== "disabled" && value.status !== "error") {
    throw new Error(`Installed Plugin ${pluginId} status is malformed`);
  }
  if (value.error !== null && value.error !== undefined && typeof value.error !== "string") {
    throw new Error(`Installed Plugin ${pluginId} diagnostic is malformed`);
  }
  if (value.retainedVersions !== undefined && !Array.isArray(value.retainedVersions)) {
    throw new Error(`Installed Plugin ${pluginId} retained versions are malformed`);
  }
  const retainedVersions = (value.retainedVersions ?? []).map((candidate) =>
    validateInstalledVersion(candidate, store, pluginId),
  );
  return {
    pluginId,
    ...active,
    status: value.status,
    error: typeof value.error === "string" ? value.error : null,
    retainedVersions: deduplicateVersions(retainedVersions).filter(
      (candidate) => !samePluginVersion(candidate, active),
    ),
  };
}

function validateInstalledVersion(value: unknown, store: string, pluginId: string): InstalledPluginVersion {
  if (!isRecord(value)) throw new Error(`Installed Plugin ${pluginId} version is malformed`);
  const source = validatePluginSource(value.source, pluginId);
  if (typeof value.activeArtifact !== "string" || typeof value.manifestPath !== "string") {
    throw new Error(`Installed Plugin ${pluginId} artifact paths are malformed`);
  }
  if (!isAbsolute(value.activeArtifact) || !isAbsolute(value.manifestPath)) {
    throw new Error(`Installed Plugin ${pluginId} artifact paths must be absolute`);
  }
  assertWithin(store, value.activeArtifact, `Installed Plugin ${pluginId} artifact`);
  assertWithin(store, value.manifestPath, `Installed Plugin ${pluginId} manifest`);
  if (!isRecord(value.manifest)) throw new Error(`Installed Plugin ${pluginId} manifest is malformed`);
  const manifest = validateManifest(value.manifest);
  if (manifest.pluginId !== pluginId || manifest.version !== value.version) {
    throw new Error(`Installed Plugin ${pluginId} identity does not match its locked manifest`);
  }
  const installationConfiguration = validatePluginConfiguration(
    manifest.installationConfigurationSchema,
    value.installationConfiguration,
    `Installed Plugin ${pluginId} installation configuration`,
  );
  const exposureConfigurations = validateExposureConfigurations(manifest, value.exposureConfigurations);
  const selectedArtifact = selectArtifact(manifest, value.target as string);
  const expectedArtifactPath = resolve(dirname(value.manifestPath), selectedArtifact.entry);
  if (selectedArtifact.integrity !== value.integrity || expectedArtifactPath !== value.activeArtifact) {
    throw new Error(`Installed Plugin ${pluginId} locked artifact is not coherent with its manifest`);
  }
  if (typeof value.target !== "string" || typeof value.integrity !== "string") {
    throw new Error(`Installed Plugin ${pluginId} target or integrity is malformed`);
  }
  return {
    source,
    version: manifest.version,
    target: value.target,
    integrity: value.integrity,
    activeArtifact: value.activeArtifact,
    manifestPath: value.manifestPath,
    manifest,
    installationConfiguration,
    exposureConfigurations,
  };
}

function validatePluginSource(value: unknown, pluginId: string): ConnectPluginSource {
  if (!isRecord(value)) throw new Error(`Installed Plugin ${pluginId} source is malformed`);
  if (value.type === "local" && typeof value.path === "string" && isAbsolute(value.path)) {
    return { type: "local", path: value.path };
  }
  if (
    value.type === "npm" &&
    typeof value.package === "string" &&
    typeof value.registry === "string" &&
    typeof value.version === "string" &&
    typeof value.tarball === "string"
  ) {
    return {
      type: "npm",
      package: value.package,
      registry: value.registry,
      version: value.version,
      tarball: value.tarball,
    };
  }
  if (
    value.type === "github" &&
    typeof value.repository === "string" &&
    typeof value.apiBase === "string" &&
    typeof value.version === "string" &&
    typeof value.release === "string" &&
    typeof value.asset === "string"
  ) {
    return {
      type: "github",
      repository: value.repository,
      apiBase: value.apiBase,
      version: value.version,
      release: value.release,
      asset: value.asset,
    };
  }
  throw new Error(`Installed Plugin ${pluginId} source is malformed`);
}

function installedVersion(entry: InstalledPluginLockEntry): InstalledPluginVersion {
  return {
    source: entry.source,
    version: entry.version,
    target: entry.target,
    integrity: entry.integrity,
    activeArtifact: entry.activeArtifact,
    manifestPath: entry.manifestPath,
    manifest: entry.manifest,
    installationConfiguration: entry.installationConfiguration,
    exposureConfigurations: entry.exposureConfigurations,
  };
}

function samePluginVersion(left: InstalledPluginVersion, right: InstalledPluginVersion): boolean {
  return left.activeArtifact === right.activeArtifact && left.integrity === right.integrity;
}

function deduplicateVersions(versions: InstalledPluginVersion[]): InstalledPluginVersion[] {
  const unique = new Map<string, InstalledPluginVersion>();
  for (const version of versions) unique.set(`${version.activeArtifact}\0${version.integrity}`, version);
  return [...unique.values()];
}

export function pluginSourceIdentity(source: ConnectPluginSource): string {
  if (source.type === "local") return `local:${source.path}`;
  if (source.type === "npm") return `npm:${source.registry}:${source.package}`;
  return `github:${source.apiBase}:${source.repository}`;
}

export type PluginConfigurationValidator = (value: unknown) => ConnectPluginConfiguration;

export function compilePluginConfigurationValidator(
  schema: ConnectPluginJsonSchema,
  label: string,
): PluginConfigurationValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  let validate: ValidateFunction;
  try {
    if (!ajv.validateSchema(schema)) {
      throw new Error(formatSchemaErrors(ajv.errors));
    }
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (value: unknown) => {
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    const configuration = structuredClone(value);
    if (!validate(configuration)) {
      throw new Error(`${label} is invalid: ${formatSchemaErrors(validate.errors)}`);
    }
    return configuration;
  };
}

export function validatePluginConfiguration(
  schema: ConnectPluginJsonSchema,
  value: unknown,
  label: string,
): ConnectPluginConfiguration {
  return compilePluginConfigurationValidator(schema, label)(value);
}

function validateConfigurationSchema(value: unknown, label: string): ConnectPluginJsonSchema {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON Schema object`);
  const schema = structuredClone(value);
  compilePluginConfigurationValidator(schema, label);
  return schema;
}

function validateExposureConfigurations(
  manifest: ConnectPluginManifestV1,
  value: unknown,
): Readonly<Record<string, ConnectPluginConfiguration>> {
  if (!isRecord(value)) throw new Error(`Plugin ${manifest.pluginId} Exposure configurations must be a JSON object`);
  const exposures = manifest.capabilities.filter((capability) => capability.type === "exposure");
  const declared = new Set(exposures.map((capability) => capability.id));
  for (const capabilityId of Object.keys(value)) {
    if (!declared.has(capabilityId)) {
      throw new Error(`Plugin ${manifest.pluginId} has no Exposure capability ${capabilityId}`);
    }
  }
  return Object.fromEntries(
    exposures.map((capability) => [
      capability.id,
      validatePluginConfiguration(
        capability.configurationSchema,
        value[capability.id] ?? {},
        `Plugin ${manifest.pluginId}/${capability.id} Exposure configuration`,
      ),
    ]),
  );
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "unknown JSON Schema validation error";
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new Error(`${label} contains unsupported field: ${unsupported.sort().join(", ")}`);
}

function requireIdentity(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!/^[a-z0-9](?:[a-z0-9._@/-]*[a-z0-9])?$/u.test(text)) {
    throw new Error(`${label} must be a stable lowercase identifier`);
  }
  return text;
}

function requireText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requireBundlePath(value: unknown): string {
  const path = requireText(value, "Bundle path");
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Bundle path must be a normalized relative path: ${path}`);
  }
  return path;
}

function assertWithin(root: string, path: string, label: string): void {
  const offset = relative(resolve(root), resolve(path));
  if (!offset || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
  throw new Error(`${label} escapes the installation Plugin store`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function pluginDependents(config: { agents: Record<string, AgentBindingConfig> }, pluginId: string): string[] {
  return Object.entries(config.agents)
    .filter(([, binding]) => binding.kind === "plugin" && binding.runtime.pluginId === pluginId)
    .map(([bindingId]) => bindingId)
    .sort();
}
