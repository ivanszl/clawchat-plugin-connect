import { pathToFileURL } from "node:url";
import type { Context, Plugin } from "cordis";
import { PLUGIN_MANAGER_CONFIG_HEADER } from "../client-contract";
import { BINDING_SCOPE_HEADER } from "../client-interface/binding-scoped-gateway";
import { errorResponse } from "../client-interface/client-http";
import { FileTurnSubmissionStaging } from "../client-interface/turn-submission-staging";
import { loadConfig, saveConfig } from "../config";
import type { ConnectStateStore } from "../persistence/state";
import type { ProjectCatalog } from "../projects/projects";
import { cacheRuntimeMedia } from "../runtime/media-cache";
import {
  type RuntimeAdapterDefinition,
  RuntimeAdapterRegistry,
  type RuntimeAdapterReplacement,
} from "../runtime/registry";
import type { ConnectRuntimeAdapter } from "../runtime/types";
import type { AgentBindingConfig, ConnectConfig } from "../types";
import { normalizeAgentBinding } from "./binding";
import { discoverOfficialPlugins, type OfficialCatalogOptions, type OfficialPluginDiscovery } from "./catalog";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  type ConnectExposureProviderHostCapability,
  type ConnectPluginClientExposure,
  type ConnectPluginContext,
  type ConnectPluginDisposer,
  type ConnectPluginEntry,
  type ConnectPluginExposureProvider,
  type ConnectPluginHostCapabilities,
  type ConnectPluginRuntimeProvider,
  type ConnectRuntimeProviderHostCapability,
  type RuntimeCapabilityRef,
} from "./sdk";
import {
  persistUploadedPluginSource,
  pluginSourceIdentity,
  type ResolvedPluginSource,
  resolvePluginSource,
  updateReferenceForSource,
} from "./source";
import {
  commitStagedPlugin,
  compilePluginConfigurationValidator,
  discardStagedPlugin,
  type InstalledPluginLockEntry,
  listInstalledPlugins,
  type PluginConfigurationValidator,
  pluginDependents,
  recordInstalledPluginError,
  removeInstalledPlugin,
  removePluginArtifacts,
  removeUnreferencedManagedPluginUploads,
  revalidateInstalledPlugin,
  type StagedPlugin,
  selectInstalledPluginVersion,
  setInstalledPluginStatus,
  stagePluginBundle,
  updateInstalledPluginConfiguration,
  validatePluginConfiguration,
} from "./store";

interface ActivePlugin {
  installed: InstalledPluginLockEntry;
  dispose(): Promise<void>;
}

interface ActivatedCandidate {
  plugin: ActivePlugin;
  readonly runtimePublished: boolean;
  activateContributions(): Promise<void>;
  publishRuntime(): Promise<void>;
}
interface ResolvedOfficialPlugin {
  resolved: ResolvedPluginSource;
  installationConfiguration?: Record<string, unknown>;
  exposureConfigurations?: Record<string, unknown>;
}

interface ConnectPluginManagementDependencies {
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  projects: ProjectCatalog;
  quiesceRuntimeBindings?<T>(bindingIds: readonly string[], criticalSection: () => Promise<T>): Promise<T>;
  retireRuntimeBindings?(bindingIds: readonly string[]): Promise<void>;
}

type PendingProvider =
  | { type: "runtime"; provider: ConnectPluginRuntimeProvider }
  | { type: "exposure"; provider: ConnectPluginExposureProvider };

export interface ManagePluginOptions {
  source: string;
  target?: string;
  installationConfiguration?: Record<string, unknown>;
  exposureConfigurations?: Record<string, unknown>;
}

export interface ConfigurePluginOptions {
  installationConfiguration: Record<string, unknown>;
  exposureConfigurations: Record<string, Record<string, unknown>>;
  runtimeConfigurations: Record<string, Record<string, unknown>>;
}

export type PluginUpdateCheck =
  | { status: "current" | "available"; version: string; integrity: string; diagnostic: null }
  | { status: "check-failed"; version: null; integrity: null; diagnostic: string };

export const MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS = 4;

interface ClientExposureTarget {
  readonly origin: URL;
  fetch(request: Request): Promise<Response>;
}

export interface ConnectPluginManagement {
  list(): Promise<InstalledPluginLockEntry[]>;
  checkUpdates(): Promise<Record<string, PluginUpdateCheck>>;
  discoverOfficial(): Promise<OfficialPluginDiscovery>;
  install(options: ManagePluginOptions): Promise<InstalledPluginLockEntry>;
  installUpload(
    fileName: string,
    bytes: Uint8Array,
    options?: Omit<ManagePluginOptions, "source">,
  ): Promise<InstalledPluginLockEntry>;
  installOfficial(pluginIds: readonly string[]): Promise<InstalledPluginLockEntry[]>;
  update(pluginId: string, options?: Partial<ManagePluginOptions>): Promise<InstalledPluginLockEntry>;
  reinstall(pluginId: string): Promise<InstalledPluginLockEntry>;
  configure(pluginId: string, options: ConfigurePluginOptions): Promise<InstalledPluginLockEntry>;
  enable(pluginId: string): Promise<InstalledPluginLockEntry>;
  disable(pluginId: string): Promise<InstalledPluginLockEntry>;
  select(pluginId: string, version: string, integrity?: string): Promise<InstalledPluginLockEntry>;
  remove(pluginId: string, force?: boolean): Promise<InstalledPluginLockEntry>;
  upsertBindingProvider(bindingId: string, binding: AgentBindingConfig): Promise<AgentBindingConfig>;
}

export class ConnectPluginHost implements ConnectPluginManagement {
  private readonly active = new Map<string, ActivePlugin>();
  private operationTail = Promise.resolve();
  private readonly officialCandidates = new Map<string, ResolvedOfficialPlugin>();
  private clientExposureTarget: ClientExposureTarget | undefined;
  private readonly clientExposure: ConnectPluginClientExposure = Object.freeze({
    fetch: async (request: Request) => await this.fetchClientExposure(request),
  });

  constructor(
    private readonly configPath: string,
    private readonly runtimeAdapters: RuntimeAdapterRegistry,
    private readonly reportActivationFailure: (pluginId: string, error: unknown) => void,
    private readonly management?: ConnectPluginManagementDependencies,
    private readonly sourceOptions: OfficialCatalogOptions = {},
  ) {}

  bindClientInterface(client: { readonly origin: string; fetch?(request: Request): Promise<Response> }): () => void {
    const fetchClient = client.fetch?.bind(client) ?? (async (request: Request) => await globalThis.fetch(request));
    const target: ClientExposureTarget = Object.freeze({
      origin: new URL(client.origin),
      fetch: fetchClient,
    });
    this.clientExposureTarget = target;
    return () => {
      if (this.clientExposureTarget === target) this.clientExposureTarget = undefined;
    };
  }

  async activateInstalled(): Promise<void> {
    const installedPlugins = await listInstalledPlugins(this.configPath);
    for (const installed of installedPlugins) {
      if (installed.status !== "active") continue;
      let activated: ActivatedCandidate | undefined;
      try {
        await revalidateInstalledPlugin(installed);
        this.validateDependentBindings(installed);
        activated = await this.activateCandidate(installed);
        await activated.activateContributions();
        await activated.publishRuntime();
        this.active.set(installed.pluginId, activated.plugin);
      } catch (error) {
        await activated?.plugin.dispose().catch(() => undefined);
        await recordInstalledPluginError(this.configPath, installed.pluginId, error).catch(() => undefined);
        await this.markDependentBindingsUnavailable(installed.pluginId, error);
        this.reportActivationFailure(installed.pluginId, error);
      }
    }
    await this.markInactiveRuntimeBindings(await listInstalledPlugins(this.configPath));
  }

  activePluginIds(): string[] {
    return [...this.active.keys()].sort();
  }

  async validateRuntimeBinding(binding: AgentBindingConfig): Promise<void> {
    const installed = await this.requireInstalled(binding.runtime.pluginId);
    if (installed.status !== "active") {
      const diagnostic = installed.error ? `: ${installed.error}` : "";
      throw new Error(`Plugin ${installed.pluginId} is not active (status: ${installed.status})${diagnostic}`);
    }
    const capability = installed.manifest.capabilities.find(
      (candidate) => candidate.id === binding.runtime.capabilityId,
    );
    if (capability?.type !== "runtime") {
      throw new Error(
        `Plugin ${installed.pluginId} does not declare Runtime capability ${binding.runtime.capabilityId}`,
      );
    }

    let validationFailure: { error: unknown } | null = null;
    let activated: ActivatedCandidate | undefined;
    try {
      await revalidateInstalledPlugin(installed);
      activated = await this.activateCandidate(installed);
      await activated.activateContributions();
      await activated.publishRuntime();
      await this.runtimeAdapters.prepare(binding);
    } catch (error) {
      validationFailure = { error };
    }
    try {
      await activated?.plugin.dispose();
    } catch (error) {
      if (!validationFailure) throw error;
    }
    if (validationFailure) throw validationFailure.error;
  }

  async upsertBindingProvider(bindingId: string, binding: AgentBindingConfig): Promise<AgentBindingConfig> {
    return await this.runExclusive(async () => {
      const management = this.management;
      if (!management) throw new Error("Agent Binding provider mutation requires the running Connect service");
      const id = bindingId.trim();
      if (!id || id !== bindingId) throw new Error("Agent Binding ID must be a non-empty exact identity");
      const candidate = normalizeAgentBinding(id, binding);
      const installed = await this.requireInstalled(candidate.runtime.pluginId);
      if (installed.status !== "active") {
        throw new Error(`Plugin ${installed.pluginId} is not active (status: ${installed.status})`);
      }
      const capability = installed.manifest.capabilities.find(
        (entry) => entry.id === candidate.runtime.capabilityId && entry.type === "runtime",
      );
      if (capability?.type !== "runtime") {
        throw new Error(
          `Plugin ${installed.pluginId} does not declare Runtime capability ${candidate.runtime.capabilityId}`,
        );
      }
      candidate.runtimeConfig = validatePluginConfiguration(
        capability.configurationSchema,
        candidate.runtimeConfig,
        `Agent Binding ${id} Runtime configuration`,
      );
      if (!this.runtimeAdapters.hasProvider(candidate)) {
        throw new Error(
          `Runtime Plugin capability ${candidate.runtime.pluginId}/${candidate.runtime.capabilityId} is not active`,
        );
      }
      const nextConfig = structuredClone(management.config);
      nextConfig.agents[id] = candidate;
      if (!nextConfig.defaultAgent) nextConfig.defaultAgent = id;
      await saveConfig(nextConfig, this.configPath);
      Object.assign(management.config, nextConfig);
      return structuredClone(candidate);
    });
  }

  async list(): Promise<InstalledPluginLockEntry[]> {
    return await listInstalledPlugins(this.configPath);
  }

  async install(options: ManagePluginOptions): Promise<InstalledPluginLockEntry> {
    const resolved = await resolvePluginSource(options.source, { ...this.sourceOptions, target: options.target });
    return await this.installResolved(resolved, options);
  }

  async installUpload(
    fileName: string,
    bytes: Uint8Array,
    options: Omit<ManagePluginOptions, "source"> = {},
  ): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      try {
        const resolved = await persistUploadedPluginSource(this.configPath, fileName, bytes, options);
        return await this.installResolvedWithinQueue(resolved, options);
      } catch (error) {
        await removeUnreferencedManagedPluginUploads(this.configPath).catch(() => undefined);
        throw error;
      }
    });
  }

  async reinstall(pluginId: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const resolverOptions: OfficialCatalogOptions = { ...this.sourceOptions, target: installed.target };
      if (installed.source.type === "npm") resolverOptions.npmRegistry = installed.source.registry;
      if (installed.source.type === "github") resolverOptions.githubApiBase = installed.source.apiBase;
      const reference =
        installed.source.type === "local"
          ? `local:${installed.source.path}`
          : installed.source.type === "npm"
            ? `npm:${installed.source.package}@${installed.source.version}`
            : `github:${installed.source.repository}@${installed.source.release}`;
      const resolved = await resolvePluginSource(reference, resolverOptions);
      const staged = await stagePluginBundle({
        configPath: this.configPath,
        source: resolved.source,
        bundle: resolved.bundle,
        target: installed.target,
        installationConfiguration: installed.installationConfiguration,
        exposureConfigurations: installed.exposureConfigurations,
      });
      if (staged.entry.pluginId !== pluginId || staged.entry.version !== installed.version) {
        await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
        throw new Error(`Reinstall must preserve exact Plugin identity and version ${pluginId}@${installed.version}`);
      }
      return await this.switchToStaged(staged, "update");
    });
  }

  async checkUpdates(): Promise<Record<string, PluginUpdateCheck>> {
    const installed = await this.list();
    const checks = new Array<readonly [string, PluginUpdateCheck]>(installed.length);
    let nextIndex = 0;
    const checkNext = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        if (index >= installed.length) return;
        nextIndex += 1;
        const entry = installed[index];
        if (!entry) return;
        try {
          const resolverOptions: OfficialCatalogOptions = { ...this.sourceOptions, target: entry.target };
          if (entry.source.type === "npm") resolverOptions.npmRegistry = entry.source.registry;
          if (entry.source.type === "github") resolverOptions.githubApiBase = entry.source.apiBase;
          const resolved = await resolvePluginSource(updateReferenceForSource(entry.source), resolverOptions);
          const artifact = resolved.bundle.manifest.artifacts.find((candidate) => candidate.target === entry.target);
          if (!artifact) throw new Error(`Resolved Plugin does not support target ${entry.target}`);
          if (pluginSourceIdentity(resolved.source) !== pluginSourceIdentity(entry.source)) {
            throw new Error("Update discovery resolved a different Plugin source");
          }
          const status =
            resolved.bundle.manifest.version === entry.version && artifact.integrity === entry.integrity
              ? "current"
              : "available";
          checks[index] = [
            entry.pluginId,
            { status, version: resolved.bundle.manifest.version, integrity: artifact.integrity, diagnostic: null },
          ];
        } catch (error) {
          checks[index] = [
            entry.pluginId,
            {
              status: "check-failed",
              version: null,
              integrity: null,
              diagnostic: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(installed.length, MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS) }, () => checkNext()),
    );
    return Object.fromEntries(checks);
  }

  async configure(pluginId: string, options: ConfigurePluginOptions): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const installationConfiguration = validatePluginConfiguration(
        installed.manifest.installationConfigurationSchema,
        options.installationConfiguration,
        `Plugin ${pluginId} installation configuration`,
      );
      const exposureCapabilities = installed.manifest.capabilities.filter(
        (capability) => capability.type === "exposure",
      );
      const exposureIds = new Set(exposureCapabilities.map((capability) => capability.id));
      const unknownExposures = Object.keys(options.exposureConfigurations).filter((id) => !exposureIds.has(id));
      if (unknownExposures.length > 0) {
        throw new Error(`Plugin ${pluginId} has no Exposure capability ${unknownExposures.join(", ")}`);
      }
      const exposureConfigurations = Object.fromEntries(
        exposureCapabilities.map((capability) => [
          capability.id,
          validatePluginConfiguration(
            capability.configurationSchema,
            options.exposureConfigurations[capability.id] ?? {},
            `Plugin ${pluginId}/${capability.id} Exposure configuration`,
          ),
        ]),
      );
      const nextRuntimeConfigurations = this.validatedRuntimeConfigurations(installed, options.runtimeConfigurations);
      const configuredCandidate: InstalledPluginLockEntry = {
        ...installed,
        installationConfiguration,
        exposureConfigurations,
        error: null,
      };
      const dependentBindingIds = this.validateDependentBindings(
        configuredCandidate,
        new Map(nextRuntimeConfigurations),
      );
      const oldActive = this.active.get(pluginId);
      let candidate: ActivatedCandidate | undefined;
      let configured!: InstalledPluginLockEntry;
      try {
        if (installed.status === "active") {
          candidate = await this.activateCandidate(configuredCandidate, oldActive ? runtimeRefs(installed) : undefined);
        }
        return await this.withBindingQuiescence(dependentBindingIds, async () => {
          await candidate?.activateContributions();
          configured = await updateInstalledPluginConfiguration(
            this.configPath,
            pluginId,
            installationConfiguration,
            exposureConfigurations,
          );
          await this.saveRuntimeConfigurations(nextRuntimeConfigurations);
          if (!candidate) return configured;

          candidate.plugin.installed = configured;
          await candidate.publishRuntime();
          this.active.delete(pluginId);
          await oldActive?.dispose();
          this.active.set(pluginId, candidate.plugin);
          return configured;
        });
      } catch (error) {
        const runtimePublished = candidate?.runtimePublished ?? false;
        if (runtimePublished) {
          this.active.delete(pluginId);
          await oldActive?.dispose().catch(() => undefined);
        }
        await candidate?.plugin.dispose().catch(() => undefined);
        if (!runtimePublished) {
          await updateInstalledPluginConfiguration(
            this.configPath,
            pluginId,
            installed.installationConfiguration,
            installed.exposureConfigurations,
          ).catch(() => undefined);
        } else {
          await this.markDependentBindingsUnavailable(pluginId, error);
        }
        await recordInstalledPluginError(
          this.configPath,
          pluginId,
          error,
          !runtimePublished && installed.status === "active",
        ).catch(() => undefined);
        this.reportActivationFailure(pluginId, error);
        throw error;
      }
    });
  }

  async update(pluginId: string, options: Partial<ManagePluginOptions> = {}): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const resolverOptions: OfficialCatalogOptions = {
        ...this.sourceOptions,
        target: options.target ?? installed.target,
      };
      if (installed.source.type === "npm") resolverOptions.npmRegistry = installed.source.registry;
      if (installed.source.type === "github") resolverOptions.githubApiBase = installed.source.apiBase;
      const resolved = await resolvePluginSource(
        options.source ?? updateReferenceForSource(installed.source),
        resolverOptions,
      );
      if (pluginSourceIdentity(resolved.source) !== pluginSourceIdentity(installed.source)) {
        throw new Error(
          `Plugin ${pluginId} source is immutable; installed ${pluginSourceIdentity(installed.source)}, resolved ${pluginSourceIdentity(resolved.source)}`,
        );
      }
      const staged = await stagePluginBundle({
        configPath: this.configPath,
        source: resolved.source,
        bundle: resolved.bundle,
        target: resolved.target,
        installationConfiguration: options.installationConfiguration ?? installed.installationConfiguration,
        exposureConfigurations: options.exposureConfigurations ?? installed.exposureConfigurations,
      });
      if (staged.entry.pluginId !== pluginId) {
        await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
        throw new Error(`Update Bundle identity ${staged.entry.pluginId} does not match installed Plugin ${pluginId}`);
      }
      return await this.switchToStaged(staged, "update");
    });
  }

  async select(pluginId: string, version: string, integrity?: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const staged = await selectInstalledPluginVersion(this.configPath, pluginId, version, integrity);
      await revalidateInstalledPlugin(staged.entry);
      return await this.switchToStaged(staged, "select");
    });
  }
  async discoverOfficial(): Promise<OfficialPluginDiscovery> {
    this.officialCandidates.clear();
    return await discoverOfficialPlugins(this.configPath, this.sourceOptions, (entry, resolved) => {
      this.officialCandidates.set(entry.pluginId, {
        resolved,
        installationConfiguration: entry.installationConfiguration,
        exposureConfigurations: entry.exposureConfigurations,
      });
    });
  }

  async installOfficial(pluginIds: readonly string[]): Promise<InstalledPluginLockEntry[]> {
    const requested = new Set(pluginIds);
    if (requested.size !== pluginIds.length || [...requested].some((pluginId) => !pluginId.trim())) {
      throw new Error("Official Plugin selection contains an empty or duplicate identity");
    }
    const installed: InstalledPluginLockEntry[] = [];
    try {
      for (const pluginId of pluginIds) {
        const candidate = this.officialCandidates.get(pluginId);
        if (!candidate) {
          throw new Error(
            `Official Plugin ${pluginId} is not in the latest staged discovery; discover again before setup`,
          );
        }
        installed.push(
          await this.installResolved(candidate.resolved, {
            installationConfiguration: candidate.installationConfiguration,
            exposureConfigurations: candidate.exposureConfigurations,
          }),
        );
      }
      return installed;
    } finally {
      this.officialCandidates.clear();
    }
  }

  async disable(pluginId: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const dependentBindingIds = this.management ? pluginDependents(this.management.config, pluginId) : [];
      return await this.withBindingQuiescence(dependentBindingIds, async () => {
        const active = this.active.get(pluginId);
        this.active.delete(pluginId);
        let failure: unknown = null;
        if (active) {
          try {
            await active.dispose();
          } catch (error) {
            failure = error;
            this.reportActivationFailure(pluginId, error);
          }
        }
        await this.markDependentBindingsUnavailable(
          pluginId,
          failure ?? new Error(`Plugin Bundle ${pluginId}@${installed.version} is disabled`),
        );
        return await setInstalledPluginStatus(this.configPath, pluginId, "disabled", failure);
      });
    });
  }

  async enable(pluginId: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      if (this.active.has(pluginId)) return installed;
      let candidate: ActivatedCandidate | undefined;
      try {
        await revalidateInstalledPlugin(installed);
        const dependentBindingIds = this.validateDependentBindings(installed);
        const activated = await this.activateCandidate(installed);
        candidate = activated;
        return await this.withBindingQuiescence(dependentBindingIds, async () => {
          await activated.activateContributions();
          const enabled = await setInstalledPluginStatus(this.configPath, pluginId, "active");
          activated.plugin.installed = enabled;
          await activated.publishRuntime();
          this.active.set(pluginId, activated.plugin);
          return enabled;
        });
      } catch (error) {
        if (candidate?.runtimePublished) this.active.delete(pluginId);
        await candidate?.plugin.dispose().catch(() => undefined);
        await recordInstalledPluginError(this.configPath, pluginId, error);
        await this.markDependentBindingsUnavailable(pluginId, error);
        this.reportActivationFailure(pluginId, error);
        throw error;
      }
    });
  }

  async remove(pluginId: string, force = false): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      await this.requireInstalled(pluginId);
      const config = this.management?.config ?? (await loadConfig(this.configPath));
      const dependents = pluginDependents(config, pluginId);
      if (dependents.length > 0 && !force) {
        throw new Error(
          `Plugin ${pluginId} is required by Agent Bindings: ${dependents.join(", ")}; retry with force to purge them`,
        );
      }
      if (dependents.length > 0 && !this.management?.retireRuntimeBindings) {
        await setInstalledPluginStatus(
          this.configPath,
          pluginId,
          "disabled",
          "Force removal is unavailable outside the running Connect service",
        );
        throw new Error(`Plugin ${pluginId} force removal requires running Agent Binding transport retirement`);
      }
      return await this.withBindingQuiescence(dependents, async () => {
        if (dependents.length > 0) {
          const retireRuntimeBindings = this.management?.retireRuntimeBindings;
          if (!retireRuntimeBindings) throw new Error("Agent Binding transport retirement is unavailable");
          await retireRuntimeBindings(dependents);
        }
        const active = this.active.get(pluginId);
        if (active) {
          try {
            await active.dispose();
            this.active.delete(pluginId);
          } catch (error) {
            this.active.delete(pluginId);
            await recordInstalledPluginError(this.configPath, pluginId, error);
            await this.markDependentBindingsUnavailable(pluginId, error);
            this.reportActivationFailure(pluginId, error);
            throw new Error(`Plugin ${pluginId} could not be removed because Bundle disposal failed`, { cause: error });
          }
        }
        if (dependents.length > 0) {
          const management = this.management;
          if (!management) throw new Error("Binding purge requires running Connect management dependencies");
          await setInstalledPluginStatus(this.configPath, pluginId, "disabled");
          const nextConfig = structuredClone(management.config);
          for (const bindingId of dependents) delete nextConfig.agents[bindingId];
          if (nextConfig.defaultAgent && dependents.includes(nextConfig.defaultAgent)) {
            nextConfig.defaultAgent = Object.keys(nextConfig.agents)[0] ?? null;
          }
          await saveConfig(nextConfig, this.configPath);
          Object.assign(management.config, nextConfig);
          for (const bindingId of dependents) await this.purgeDependentBindingState(bindingId);
        }
        const removed = await removeInstalledPlugin(this.configPath, pluginId);
        try {
          await removePluginArtifacts(this.configPath, pluginId);
        } finally {
          await removeUnreferencedManagedPluginUploads(this.configPath);
        }
        return removed;
      });
    });
  }

  async close(): Promise<void> {
    this.officialCandidates.clear();
    await this.operationTail;
    this.clientExposureTarget = undefined;
    const active = [...this.active.values()].reverse();
    this.active.clear();
    const results = await Promise.allSettled(active.map(async (plugin) => await plugin.dispose()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private validatedRuntimeConfigurations(
    installed: InstalledPluginLockEntry,
    configurations: Record<string, Record<string, unknown>>,
  ): Array<[bindingId: string, configuration: Record<string, unknown>]> {
    if (Object.keys(configurations).length > 0 && !this.management) {
      throw new Error("Runtime capability configuration requires the running Connect service");
    }
    return Object.entries(configurations).map(([bindingId, configuration]) => {
      const binding = this.management?.config.agents[bindingId];
      if (!binding || binding.runtime.pluginId !== installed.pluginId) {
        throw new Error(`Agent Binding ${bindingId} is not a dependent of Plugin ${installed.pluginId}`);
      }
      const capability = installed.manifest.capabilities.find(
        (candidate) => candidate.type === "runtime" && candidate.id === binding.runtime.capabilityId,
      );
      if (capability?.type !== "runtime") {
        throw new Error(
          `Plugin ${installed.pluginId} does not declare Runtime capability ${binding.runtime.capabilityId}`,
        );
      }
      return [
        bindingId,
        validatePluginConfiguration(
          capability.configurationSchema,
          configuration,
          `Agent Binding ${bindingId} Runtime configuration for ${installed.pluginId}/${capability.id}`,
        ),
      ];
    });
  }

  private async saveRuntimeConfigurations(
    configurations: Array<[bindingId: string, configuration: Record<string, unknown>]>,
  ): Promise<void> {
    if (configurations.length === 0) return;
    if (!this.management) throw new Error("Runtime capability configuration requires the running Connect service");
    const next = structuredClone(this.management.config);
    for (const [bindingId, configuration] of configurations) {
      const binding = next.agents[bindingId];
      if (!binding) throw new Error(`Agent Binding ${bindingId} is no longer available`);
      binding.runtimeConfig = configuration;
    }
    await saveConfig(next, this.configPath);
    Object.assign(this.management.config, next);
  }
  private async installResolved(
    resolved: ResolvedPluginSource,
    options: Pick<ManagePluginOptions, "installationConfiguration" | "exposureConfigurations">,
  ): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => await this.installResolvedWithinQueue(resolved, options));
  }

  private async installResolvedWithinQueue(
    resolved: ResolvedPluginSource,
    options: Pick<ManagePluginOptions, "installationConfiguration" | "exposureConfigurations">,
  ): Promise<InstalledPluginLockEntry> {
    const staged = await stagePluginBundle({
      configPath: this.configPath,
      source: resolved.source,
      bundle: resolved.bundle,
      target: resolved.target,
      installationConfiguration: options.installationConfiguration,
      exposureConfigurations: options.exposureConfigurations,
    });
    let candidate: ActivatedCandidate | undefined;
    let lockCommitted = false;
    try {
      this.validateDependentBindings(staged.entry);
      candidate = await this.activateCandidate(staged.entry, []);
      await candidate.activateContributions();
      const installed = await commitStagedPlugin(this.configPath, staged, "install");
      lockCommitted = true;
      candidate.plugin.installed = installed;
      await candidate.publishRuntime();
      this.active.set(installed.pluginId, candidate.plugin);
      return installed;
    } catch (error) {
      if (lockCommitted) {
        await candidate?.plugin.dispose().catch(() => undefined);
        await recordInstalledPluginError(this.configPath, staged.entry.pluginId, error).catch(() => undefined);
        await this.markDependentBindingsUnavailable(staged.entry.pluginId, error);
      } else {
        await candidate?.plugin.dispose().catch(() => undefined);
        await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
      }
      this.reportActivationFailure(staged.entry.pluginId, error);
      throw error;
    }
  }

  private async switchToStaged(
    staged: StagedPlugin,
    operation: "update" | "select",
  ): Promise<InstalledPluginLockEntry> {
    const existing = await this.requireInstalled(staged.entry.pluginId);
    const oldActive = this.active.get(staged.entry.pluginId);
    const replacedRuntimeRefs = oldActive ? runtimeRefs(existing) : undefined;
    const dependentBindingIds = this.validateDependentBindings(staged.entry);
    let candidate: ActivatedCandidate | undefined;
    let lockCommitted = false;
    try {
      const activated = await this.activateCandidate(staged.entry, replacedRuntimeRefs);
      candidate = activated;
      return await this.withBindingQuiescence(dependentBindingIds, async () => {
        await activated.activateContributions();
        const installed = await commitStagedPlugin(this.configPath, staged, operation);
        lockCommitted = true;
        activated.plugin.installed = installed;
        await activated.publishRuntime();
        this.active.delete(installed.pluginId);
        await oldActive?.dispose();
        this.active.set(installed.pluginId, activated.plugin);
        return installed;
      });
    } catch (error) {
      if (lockCommitted || candidate?.runtimePublished) {
        this.active.delete(staged.entry.pluginId);
        await oldActive?.dispose().catch(() => undefined);
        await candidate?.plugin.dispose().catch(() => undefined);
        await recordInstalledPluginError(this.configPath, staged.entry.pluginId, error).catch(() => undefined);
        await this.markDependentBindingsUnavailable(staged.entry.pluginId, error);
        this.reportActivationFailure(staged.entry.pluginId, error);
        throw error;
      }

      await candidate?.plugin.dispose().catch(() => undefined);
      await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
      await recordInstalledPluginError(
        this.configPath,
        staged.entry.pluginId,
        error,
        existing.status === "active",
      ).catch(() => undefined);
      this.reportActivationFailure(staged.entry.pluginId, error);
      throw error;
    }
  }

  private validateDependentBindings(
    installed: InstalledPluginLockEntry,
    runtimeConfigurations?: ReadonlyMap<string, Record<string, unknown>>,
  ): string[] {
    if (!this.management) return [];
    const dependentBindingIds = pluginDependents(this.management.config, installed.pluginId);
    for (const bindingId of dependentBindingIds) {
      const binding = this.management.config.agents[bindingId];
      if (!binding || binding.runtime.pluginId !== installed.pluginId) {
        throw new Error(`Agent Binding ${bindingId} is not an exact dependent of Plugin ${installed.pluginId}`);
      }
      const capability = installed.manifest.capabilities.find(
        (candidate) => candidate.id === binding.runtime.capabilityId,
      );
      if (capability?.type !== "runtime") {
        throw new Error(
          `Agent Binding ${bindingId} requires missing Runtime capability ${installed.pluginId}/${binding.runtime.capabilityId}`,
        );
      }
      validatePluginConfiguration(
        capability.configurationSchema,
        runtimeConfigurations?.get(bindingId) ?? binding.runtimeConfig,
        `Agent Binding ${bindingId} Runtime configuration for ${installed.pluginId}/${capability.id}`,
      );
    }
    return dependentBindingIds;
  }

  private async requireInstalled(pluginId: string): Promise<InstalledPluginLockEntry> {
    const installed = (await listInstalledPlugins(this.configPath)).find(
      (candidate) => candidate.pluginId === pluginId,
    );
    if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
    return installed;
  }

  private async markDependentBindingsUnavailable(pluginId: string, error: unknown): Promise<void> {
    if (!this.management) return;
    const detail = `Plugin Bundle ${pluginId} unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const dependents = pluginDependents(this.management.config, pluginId);
    await Promise.allSettled(
      dependents.map(async (bindingId) => {
        await this.management?.stateStore.setRuntimeAvailability(bindingId, "startup-unavailable", detail);
      }),
    );
  }

  private async markInactiveRuntimeBindings(installedPlugins: readonly InstalledPluginLockEntry[]): Promise<void> {
    if (!this.management) return;
    await Promise.allSettled(
      Object.entries(this.management.config.agents).map(async ([bindingId, binding]) => {
        if (this.runtimeAdapters.hasProvider(binding)) return;
        const installed = installedPlugins.find((candidate) => candidate.pluginId === binding.runtime.pluginId);
        const capability = installed?.manifest.capabilities.find(
          (candidate) => candidate.id === binding.runtime.capabilityId && candidate.type === "runtime",
        );
        let reason: string;
        if (!installed) {
          reason = `Plugin ${binding.runtime.pluginId} is not installed`;
        } else if (capability?.type !== "runtime") {
          reason = `Plugin ${installed.pluginId} does not declare this Runtime capability`;
        } else if (installed.status !== "active") {
          reason = `Plugin ${installed.pluginId} is ${installed.status}${installed.error ? `: ${installed.error}` : ""}`;
        } else {
          reason = `Plugin ${installed.pluginId} failed to activate this Runtime capability`;
        }
        await this.management?.stateStore.setRuntimeAvailability(
          bindingId,
          "startup-unavailable",
          `Runtime Plugin capability ${binding.runtime.pluginId}/${binding.runtime.capabilityId} is not active: ${reason}`,
        );
      }),
    );
  }

  private async purgeDependentBindingState(bindingId: string): Promise<void> {
    if (!this.management) throw new Error("Binding purge requires running Connect management dependencies");
    const sessionRefs = (await this.management.stateStore.listAllRuntimeSessions())
      .filter((session) => session.agentId === bindingId)
      .map((session) => session.sessionRef);
    await new FileTurnSubmissionStaging(this.management.config.stateDbPath).purgeSessions(sessionRefs);
    await this.management.projects.purgeBindingWorkspaces(bindingId);
    await this.management.stateStore.purgeAgentBinding(bindingId);
  }

  private async withBindingQuiescence<T>(bindingIds: readonly string[], criticalSection: () => Promise<T>): Promise<T> {
    if (!this.management?.quiesceRuntimeBindings) return await criticalSection();
    return await this.management.quiesceRuntimeBindings(bindingIds, criticalSection);
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.operationTail.then(operation, operation);
    this.operationTail = running.then(
      () => undefined,
      () => undefined,
    );
    return await running;
  }

  private async activateCandidate(
    installed: InstalledPluginLockEntry,
    replacedRuntimeRefs?: readonly RuntimeCapabilityRef[],
  ): Promise<ActivatedCandidate> {
    // Plugin artifact paths are runtime-selected and version-distinct, so static imports cannot represent this boundary.
    const namespace: unknown = await import(pathToFileURL(installed.activeArtifact).href);
    if (!namespace || typeof namespace !== "object" || !("default" in namespace)) {
      throw new Error(`Plugin ${installed.pluginId} entry artifact must export a default Connect Plugin entry`);
    }
    const entry = namespace.default;
    if (!entry || typeof entry !== "object" || !("activate" in entry) || typeof entry.activate !== "function") {
      throw new Error(`Plugin ${installed.pluginId} default export does not implement activate(context)`);
    }
    const pluginEntry = entry as ConnectPluginEntry;
    const declaredHostCapabilities = new Set(installed.manifest.dependencies.map((dependency) => dependency.id));
    const pending = new Map<string, PendingProvider>();
    let acceptingRegistrations = true;
    const register = (type: PendingProvider["type"], provider: unknown): void => {
      if (!acceptingRegistrations) {
        throw new Error(`Plugin ${installed.pluginId} attempted to register a provider after Bundle activation`);
      }
      if (!provider || typeof provider !== "object") {
        throw new Error(`Plugin ${installed.pluginId} registered a malformed ${type} provider`);
      }
      const providerRecord = provider as Record<string, unknown>;
      const capabilityId = typeof providerRecord.capabilityId === "string" ? providerRecord.capabilityId.trim() : "";
      const operation = type === "runtime" ? providerRecord.create : providerRecord.activate;
      if (!capabilityId || typeof operation !== "function") {
        throw new Error(`Plugin ${installed.pluginId} registered a malformed ${type} provider`);
      }
      if (pending.has(capabilityId)) {
        throw new Error(`Plugin ${installed.pluginId} registered capability ${capabilityId} more than once`);
      }
      if (type === "runtime") {
        const family = typeof providerRecord.family === "string" ? providerRecord.family.trim() : "";
        if (!family) throw new Error(`Plugin ${installed.pluginId} registered a malformed Runtime provider`);
        pending.set(capabilityId, {
          type,
          provider: { ...(provider as ConnectPluginRuntimeProvider), capabilityId, family },
        });
        return;
      }
      pending.set(capabilityId, {
        type,
        provider: { ...(provider as ConnectPluginExposureProvider), capabilityId },
      });
    };
    const runtimeHostCapability: ConnectRuntimeProviderHostCapability = Object.freeze({
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      register: (provider: ConnectPluginRuntimeProvider) => register("runtime", provider),
    });
    const exposureHostCapability: ConnectExposureProviderHostCapability = Object.freeze({
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      register: (provider: ConnectPluginExposureProvider) => register("exposure", provider),
    });
    const hostCapabilities = Object.freeze({
      get: (id: "runtime-provider" | "exposure-provider") => {
        if (!declaredHostCapabilities.has(id)) {
          throw new Error(`Plugin ${installed.pluginId} used undeclared Host Capability ${id}`);
        }
        return id === "runtime-provider" ? runtimeHostCapability : exposureHostCapability;
      },
    }) as ConnectPluginHostCapabilities;
    const context: ConnectPluginContext = Object.freeze({
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      installationConfiguration: deepFreeze(structuredClone(installed.installationConfiguration)),
      hostCapabilities,
    });

    let pluginDisposer: ConnectPluginDisposer | undefined;
    let replacement: RuntimeAdapterReplacement | undefined;
    const stagedExposures: Array<{
      provider: ConnectPluginExposureProvider;
      configuration: Readonly<Record<string, unknown>>;
    }> = [];
    const exposureDisposers: ConnectPluginDisposer[] = [];
    try {
      const activated = await pluginEntry.activate(context);
      acceptingRegistrations = false;
      if (typeof activated === "function") pluginDisposer = activated;
      const declared = installed.manifest.capabilities;
      if (pending.size !== declared.length) {
        throw new Error(
          `Plugin ${installed.pluginId} registered ${pending.size} providers; manifest declares ${declared.length}`,
        );
      }

      const runtimeDefinitions: RuntimeAdapterDefinition[] = [];
      for (const capability of declared) {
        const registration = pending.get(capability.id);
        if (!registration) throw new Error(`Plugin ${installed.pluginId} did not register capability ${capability.id}`);
        if (registration.type !== capability.type) {
          throw new Error(
            `Plugin ${installed.pluginId}/${capability.id} registered as ${registration.type}, expected ${capability.type}`,
          );
        }
        if (capability.type === "runtime") {
          const provider = registration.provider as ConnectPluginRuntimeProvider;
          if (provider.family !== capability.family) {
            throw new Error(
              `Plugin ${installed.pluginId}/${capability.id} registered family ${provider.family}, expected ${capability.family}`,
            );
          }
          const validateConfiguration = compilePluginConfigurationValidator(
            capability.configurationSchema,
            `Agent Binding Runtime configuration for ${installed.pluginId}/${capability.id}`,
          );
          runtimeDefinitions.push({
            family: provider.family,
            runtime: { pluginId: installed.pluginId, capabilityId: capability.id },
            create: (binding) => bridgeRuntimeProvider(installed.pluginId, provider, validateConfiguration, binding),
          });
          continue;
        }
        stagedExposures.push({
          provider: registration.provider as ConnectPluginExposureProvider,
          configuration: deepFreeze(structuredClone(installed.exposureConfigurations[capability.id] ?? {})),
        });
      }
      replacement = this.runtimeAdapters.replaceAll(runtimeDefinitions, replacedRuntimeRefs ?? []);
    } catch (error) {
      acceptingRegistrations = false;
      await replacement?.rollback().catch(() => undefined);
      if (pluginDisposer) {
        await Promise.allSettled([Promise.resolve().then(async () => await pluginDisposer?.())]);
      }
      throw error;
    }

    let state: "pending" | "activating" | "activated" | "publishing" | "committed" | "failed" | "disposed" = "pending";
    let runtimePublished = false;
    const plugin: ActivePlugin = {
      installed,
      dispose: async () => {
        if (state === "disposed") return;
        state = "disposed";
        const results: PromiseSettledResult<void>[] = [];
        if (replacement) {
          results.push(...(await Promise.allSettled([replacement.rollback()])));
          results.push(...(await Promise.allSettled([replacement.unregister()])));
        }
        results.push(
          ...(await Promise.allSettled(exposureDisposers.reverse().map(async (dispose) => await dispose()))),
        );
        if (pluginDisposer) results.push(...(await Promise.allSettled([pluginDisposer()])));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      },
    };
    return {
      plugin,
      get runtimePublished() {
        return runtimePublished;
      },
      activateContributions: async () => {
        if (state === "activated" || state === "committed") return;
        if (state !== "pending") {
          throw new Error(`Plugin ${installed.pluginId} candidate contributions cannot be activated`);
        }
        state = "activating";
        try {
          for (const { provider, configuration } of stagedExposures) {
            const disposer = await provider.activate(Object.freeze({ configuration, client: this.clientExposure }));
            if (typeof disposer === "function") exposureDisposers.push(disposer);
          }
          state = "activated";
        } catch (error) {
          state = "failed";
          throw error;
        }
      },
      publishRuntime: async () => {
        if (state === "committed") return;
        if (state !== "activated") {
          throw new Error(`Plugin ${installed.pluginId} candidate Runtime cannot be published`);
        }
        state = "publishing";
        const publication = replacement?.commit();
        runtimePublished = true;
        try {
          await publication;
          state = "committed";
        } catch (error) {
          state = "failed";
          throw error;
        }
      },
    };
  }

  private async fetchClientExposure(request: Request): Promise<Response> {
    const target = this.clientExposureTarget;
    if (!target) {
      return errorResponse(503, "plugin-client-unavailable", "Connect Client is not available yet", true);
    }
    const destination = new URL(request.url);
    destination.protocol = target.origin.protocol;
    destination.username = target.origin.username;
    destination.password = target.origin.password;
    destination.host = target.origin.host;
    const forwarded = new Request(destination, request);
    forwarded.headers.set("host", target.origin.host);
    forwarded.headers.delete(BINDING_SCOPE_HEADER);
    forwarded.headers.delete(PLUGIN_MANAGER_CONFIG_HEADER);
    return await target.fetch(forwarded);
  }
}

export async function validateInstalledRuntimeBinding(configPath: string, binding: AgentBindingConfig): Promise<void> {
  const runtimeAdapters = new RuntimeAdapterRegistry([]);
  const host = new ConnectPluginHost(configPath, runtimeAdapters, () => undefined);
  let validationFailure: { error: unknown } | null = null;
  try {
    await host.validateRuntimeBinding(binding);
  } catch (error) {
    validationFailure = { error };
  }
  try {
    await runtimeAdapters.close();
  } catch (error) {
    if (!validationFailure) throw error;
  }
  if (validationFailure) throw validationFailure.error;
}

function runtimeRefs(installed: InstalledPluginLockEntry): RuntimeCapabilityRef[] {
  return installed.manifest.capabilities
    .filter((capability) => capability.type === "runtime")
    .map((capability) => ({ pluginId: installed.pluginId, capabilityId: capability.id }));
}

function bridgeRuntimeProvider(
  pluginId: string,
  provider: ConnectPluginRuntimeProvider,
  validateConfiguration: PluginConfigurationValidator,
  binding: AgentBindingConfig,
): ConnectRuntimeAdapter {
  if (binding.runtime.pluginId !== pluginId || binding.runtime.capabilityId !== provider.capabilityId) {
    throw new Error(
      `Runtime provider ${pluginId}/${provider.capabilityId} received a different Agent Binding provider`,
    );
  }
  const configuration = deepFreeze(validateConfiguration(binding.runtimeConfig));
  const adapter = provider.create(configuration);
  const internal: ConnectRuntimeAdapter = {
    kind: provider.family,
    modes: adapter.modes,
    lifecycleCapabilities: adapter.lifecycleCapabilities,
    prepare: adapter.prepare ? async () => await adapter.prepare?.() : undefined,
    modesFor: adapter.modesFor ? (_binding, scope) => adapter.modesFor?.(scope) ?? adapter.modes : undefined,
    listModels: adapter.listModels ? async (_binding, scope) => (await adapter.listModels?.(scope)) ?? [] : undefined,
    listSessionOptions: adapter.listSessionOptions
      ? async (_binding, workspace, scope) => (await adapter.listSessionOptions?.(workspace, scope)) ?? []
      : undefined,
    listSkills: adapter.listSkills
      ? async (_binding, workspace, options) => (await adapter.listSkills?.(workspace, options)) ?? []
      : undefined,
    onSkillsChanged: adapter.onSkillsChanged?.bind(adapter),
    listCommands: adapter.listCommands
      ? async (_binding, workspace, options) => (await adapter.listCommands?.(workspace, options)) ?? []
      : undefined,
    onCommandsChanged: adapter.onCommandsChanged?.bind(adapter),
    onCatalogsChanged: adapter.onCatalogsChanged?.bind(adapter),
    discoverThreads: adapter.discoverThreads
      ? async (_binding, workspace) => (await adapter.discoverThreads?.(workspace)) ?? []
      : undefined,
    discoverAllThreads: adapter.discoverAllThreads
      ? async () => (await adapter.discoverAllThreads?.()) ?? []
      : undefined,
    discoverArchivedThreads: adapter.discoverArchivedThreads
      ? async () => (await adapter.discoverArchivedThreads?.()) ?? []
      : undefined,
    verifyThreadReady: adapter.verifyThreadReady
      ? async (_binding, runtimeThreadId) => await adapter.verifyThreadReady?.(runtimeThreadId)
      : undefined,
    readActivity: adapter.readActivity
      ? async (_binding, runtimeThreadId) => {
          const snapshot = await adapter.readActivity?.(runtimeThreadId);
          if (!snapshot) throw new Error(`Runtime provider ${pluginId}/${provider.capabilityId} returned no activity`);
          return snapshot;
        }
      : undefined,
    reconcileInput: adapter.reconcileInput
      ? async (_binding, runtimeThreadId, candidate) =>
          (await adapter.reconcileInput?.(runtimeThreadId, candidate)) ?? { outcome: "unknown" }
      : undefined,
    archiveThread: adapter.archiveThread
      ? async (_binding, runtimeThreadId) => await adapter.archiveThread?.(runtimeThreadId)
      : undefined,
    unarchiveThread: adapter.unarchiveThread
      ? async (_binding, runtimeThreadId) => await adapter.unarchiveThread?.(runtimeThreadId)
      : undefined,
    deleteThread: adapter.deleteThread
      ? async (_binding, runtimeThreadId) => await adapter.deleteThread?.(runtimeThreadId)
      : undefined,
    start: async (_binding, context) =>
      await adapter.start({
        agentId: context.agentId,
        chatId: context.chatId,
        sessionId: context.sessionId,
        runtimeThreadId: context.runtimeSessionId,
        onRuntimeThreadId: context.onRuntimeSessionId,
        cacheMedia: async (media, trustedOrigins) => {
          if (!context.stateDbPath) {
            throw new Error(
              `Runtime provider ${pluginId}/${provider.capabilityId} cannot cache media without state storage`,
            );
          }
          return await cacheRuntimeMedia(media, context.stateDbPath, { trustedOrigins });
        },
      }),
    close: adapter.close ? async () => await adapter.close?.() : undefined,
  };
  return internal;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

declare module "cordis" {
  interface Context {
    connectPluginHost: ConnectPluginHost;
  }
}

export async function mountMandatoryPluginHost(
  root: Context,
  configPath: string,
  config: ConnectConfig,
  reportFailure: (pluginId: string, error: unknown) => void,
  retireRuntimeBindings: (bindingIds: readonly string[]) => Promise<void>,
): Promise<ConnectPluginHost> {
  let host!: ConnectPluginHost;
  const pluginHostModule = {
    name: "connect-plugin-host",
    inject: [
      "connectRuntimeAdapters",
      "connectSessionQueue",
      "connectSessionTurnExecutor",
      "connectPersistence",
      "connectProjects",
    ],
    provide: "connectPluginHost",
    apply: async (ctx) => {
      host = new ConnectPluginHost(configPath, ctx.connectRuntimeAdapters, reportFailure, {
        config,
        stateStore: ctx.connectPersistence.stateStore,
        projects: ctx.connectProjects,
        retireRuntimeBindings,
        quiesceRuntimeBindings: async (bindingIds, criticalSection) =>
          await ctx.connectSessionQueue.quiesceBindings(
            bindingIds,
            async () => await ctx.connectSessionTurnExecutor.releaseBindings(bindingIds),
            criticalSection,
          ),
      });
      await host.activateInstalled();
      ctx.provide("connectPluginHost", host);
      return async () => await host.close();
    },
  } satisfies Plugin;
  await root.plugin(pluginHostModule);
  return host;
}
