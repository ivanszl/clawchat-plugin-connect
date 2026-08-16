import { randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ConnectPluginManifestV1,
  ConnectPluginProbeEntry,
  ConnectPluginRuntimeProbeContext,
  ConnectPluginRuntimeProbeResult,
  ConnectPluginSource,
} from "./sdk";
import type { PluginSourceResolverOptions, ResolvedPluginSource } from "./source";
import { readBoundedResponseBytes, resolvePluginSource } from "./source";
import { connectPluginBundleFileBytes, pluginInstallationPaths, verifyConnectPluginIntegrity } from "./store";

export const CONNECT_PLUGIN_CATALOG_FORMAT = "clawchat-connect-plugin-catalog-v1" as const;
export const OFFICIAL_PLUGIN_CATALOG_URL = "https://plugins.clawchat.ai/v1/catalog.json";
export const MAX_OFFICIAL_PLUGIN_CATALOG_BYTES = 4 * 1024 * 1024;
export const OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvsVHDCNTOmCpScmRqdyHQjI3JfDBKGc+t74UTbkg7Gs=
-----END PUBLIC KEY-----`;
export interface OfficialPluginCatalogEntry {
  pluginId: string;
  name: string;
  source: string;
  installationConfiguration?: Record<string, unknown>;
  exposureConfigurations?: Record<string, unknown>;
}

export interface OfficialPluginCatalogV1 {
  format: typeof CONNECT_PLUGIN_CATALOG_FORMAT;
  generatedAt: string;
  plugins: OfficialPluginCatalogEntry[];
  signature: string;
}

export interface OfficialCatalogOptions extends PluginSourceResolverOptions {
  catalogUrl?: string;
  catalogPublicKey?: string;
  catalogFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  findExecutable?: (command: string) => Promise<string | null>;
}

export interface OfficialCatalogResult {
  catalog: OfficialPluginCatalogV1 | null;
  origin: "remote" | "cache" | null;
  diagnostics: string[];
}

export interface OfficialPluginCandidate {
  pluginId: string;
  name: string;
  source: string;
  version: string | null;
  target: string;
  integrity: string | null;
  detected: boolean;
  compatible: boolean;
  selected: boolean;
  selectable: true;
  probe: ConnectPluginRuntimeProbeResult | null;
  diagnostic: string | null;
  resolvedSource: ConnectPluginSource | null;
  manifest: ConnectPluginManifestV1 | null;
  installationConfiguration: Record<string, unknown>;
  exposureConfigurations: Record<string, unknown>;
}

export interface OfficialPluginDiscovery {
  candidates: OfficialPluginCandidate[];
  catalogOrigin: "remote" | "cache" | null;
  diagnostics: string[];
}

export async function fetchOfficialPluginCatalog(
  configPath: string,
  options: OfficialCatalogOptions = {},
): Promise<OfficialCatalogResult> {
  const url = options.catalogUrl ?? OFFICIAL_PLUGIN_CATALOG_URL;
  const fetchCatalog = options.catalogFetch ?? options.fetch ?? fetch;
  const publicKey = options.catalogPublicKey ?? OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY;
  const cachePath = resolve(pluginInstallationPaths(configPath).root, "plugin-catalog.cache.json");
  try {
    const response = await fetchCatalog(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await readBoundedResponseBytes(
      response,
      `Official Plugin Catalog response ${url}`,
      MAX_OFFICIAL_PLUGIN_CATALOG_BYTES,
    );
    const catalog = validateAuthenticatedCatalog(JSON.parse(new TextDecoder().decode(bytes)) as unknown, publicKey);
    await writeCatalogCache(cachePath, catalog);
    return { catalog, origin: "remote", diagnostics: [] };
  } catch (error) {
    const remoteDiagnostic = `Official Plugin Catalog is unavailable from ${url}: ${errorMessage(error)}`;
    try {
      const cached = validateAuthenticatedCatalog(JSON.parse(await readFile(cachePath, "utf8")) as unknown, publicKey);
      return {
        catalog: cached,
        origin: "cache",
        diagnostics: [`${remoteDiagnostic}; continuing with the last authenticated Catalog cache`],
      };
    } catch (cacheError) {
      return {
        catalog: null,
        origin: null,
        diagnostics: [
          `${remoteDiagnostic}; no valid Catalog cache is available (${errorMessage(cacheError)}). Direct npm, GitHub, and local installation remain available`,
        ],
      };
    }
  }
}

export async function discoverOfficialPlugins(
  configPath: string,
  options: OfficialCatalogOptions = {},
  onResolved?: (catalogEntry: OfficialPluginCatalogEntry, resolved: ResolvedPluginSource) => void | Promise<void>,
): Promise<OfficialPluginDiscovery> {
  const loaded = await fetchOfficialPluginCatalog(configPath, options);
  if (!loaded.catalog) return { candidates: [], catalogOrigin: null, diagnostics: loaded.diagnostics };
  const stagingRoot = resolve(pluginInstallationPaths(configPath).store, ".official-staging");
  const candidates: OfficialPluginCandidate[] = [];
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  for (const catalogEntry of loaded.catalog.plugins) {
    const candidateRoot = resolve(stagingRoot, randomUUID());
    try {
      const resolved = await resolvePluginSource(catalogEntry.source, options);
      if (resolved.bundle.manifest.pluginId !== catalogEntry.pluginId) {
        throw new Error(
          `Catalog identity ${catalogEntry.pluginId} does not match Bundle identity ${resolved.bundle.manifest.pluginId}`,
        );
      }
      await onResolved?.(catalogEntry, resolved);
      const artifact = resolved.bundle.manifest.artifacts.find((entry) => entry.target === resolved.target);
      if (!artifact) {
        throw new Error(
          `Resolved Plugin ${catalogEntry.pluginId}@${resolved.bundle.manifest.version} has no ${resolved.target} artifact`,
        );
      }
      const base = {
        pluginId: catalogEntry.pluginId,
        name: catalogEntry.name,
        source: catalogEntry.source,
        version: resolved.bundle.manifest.version,
        target: resolved.target,
        integrity: artifact.integrity,
        selectable: true as const,
        resolvedSource: resolved.source,
        manifest: structuredClone(resolved.bundle.manifest),
        installationConfiguration: structuredClone(catalogEntry.installationConfiguration ?? {}),
        exposureConfigurations: structuredClone(catalogEntry.exposureConfigurations ?? {}),
      };
      for (const bundlePath of Object.keys(resolved.bundle.files)) {
        const outputPath = resolve(candidateRoot, bundlePath);
        if (!isWithin(candidateRoot, outputPath)) {
          throw new Error(`Official Plugin staged file escapes its temporary root: ${bundlePath}`);
        }
        await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
        await writeFile(outputPath, connectPluginBundleFileBytes(resolved.bundle, bundlePath), { mode: 0o600 });
      }
      await writeFile(
        resolve(candidateRoot, "connect-plugin.json"),
        `${JSON.stringify(resolved.bundle.manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      if (!resolved.bundle.manifest.probe) {
        candidates.push({
          ...base,
          detected: false,
          compatible: false,
          selected: false,
          probe: null,
          diagnostic: "Official Plugin does not declare a runtime probe; it remains manually selectable",
        });
        continue;
      }
      const probeManifest = resolved.bundle.manifest.probe;
      const probeBytes = connectPluginBundleFileBytes(resolved.bundle, probeManifest.entry);
      verifyConnectPluginIntegrity(probeBytes, probeManifest.integrity, `${catalogEntry.pluginId} runtime probe`);
      const probePath = resolve(candidateRoot, probeManifest.entry);
      if (!isWithin(candidateRoot, probePath)) throw new Error("Runtime probe path escapes its temporary staging root");
      // The selected official Bundle probe is a runtime registry artifact, so its module path is not known statically.
      const imported = (await import(`${pathToFileURL(probePath).href}?stage=${randomUUID()}`)) as {
        default?: unknown;
      };
      const probeEntry = imported.default as Partial<ConnectPluginProbeEntry> | undefined;
      if (!probeEntry || typeof probeEntry.probe !== "function") {
        throw new Error("Runtime probe module must default-export a probe(context) function");
      }
      const context: ConnectPluginRuntimeProbeContext = Object.freeze({
        platform: process.platform,
        arch: process.arch,
        findExecutable: options.findExecutable ?? findExecutableOnPath,
      });
      const probe = validateProbeResult(await probeEntry.probe(context), catalogEntry.pluginId);
      candidates.push({
        ...base,
        detected: probe.detected,
        compatible: probe.compatible,
        selected: probe.detected && probe.compatible,
        probe,
        diagnostic: probe.detail ?? null,
      });
    } catch (error) {
      candidates.push({
        pluginId: catalogEntry.pluginId,
        name: catalogEntry.name,
        source: catalogEntry.source,
        version: null,
        target: options.target ?? `${process.platform}-${process.arch}`,
        integrity: null,
        detected: false,
        compatible: false,
        selected: false,
        selectable: true,
        probe: null,
        diagnostic: `Official Plugin probe failed in isolation: ${errorMessage(error)}`,
        resolvedSource: null,
        manifest: null,
        installationConfiguration: structuredClone(catalogEntry.installationConfiguration ?? {}),
        exposureConfigurations: structuredClone(catalogEntry.exposureConfigurations ?? {}),
      });
    } finally {
      await rm(candidateRoot, { recursive: true, force: true });
    }
  }
  await rm(stagingRoot, { recursive: true, force: true });
  return { candidates, catalogOrigin: loaded.origin, diagnostics: loaded.diagnostics };
}

export function officialCatalogSigningPayload(catalog: Omit<OfficialPluginCatalogV1, "signature">): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ format: catalog.format, generatedAt: catalog.generatedAt, plugins: catalog.plugins }),
  );
}

function validateAuthenticatedCatalog(value: unknown, publicKey: string): OfficialPluginCatalogV1 {
  if (!isRecord(value) || value.format !== CONNECT_PLUGIN_CATALOG_FORMAT) {
    throw new Error("Official Plugin Catalog format is unsupported or malformed");
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error("Official Plugin Catalog generatedAt is malformed");
  }
  if (typeof value.signature !== "string" || !Array.isArray(value.plugins)) {
    throw new Error("Official Plugin Catalog signature or entries are missing");
  }
  const identities = new Set<string>();
  const plugins = value.plugins.map((candidate): OfficialPluginCatalogEntry => {
    if (!isRecord(candidate)) throw new Error("Official Plugin Catalog entry is malformed");
    if (
      typeof candidate.pluginId !== "string" ||
      !candidate.pluginId.trim() ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      typeof candidate.source !== "string" ||
      !candidate.source.trim()
    ) {
      throw new Error("Official Plugin Catalog entry identity, name, or source is malformed");
    }
    if (identities.has(candidate.pluginId))
      throw new Error(`Duplicate official Plugin identity: ${candidate.pluginId}`);
    identities.add(candidate.pluginId);
    return {
      pluginId: candidate.pluginId,
      name: candidate.name,
      source: candidate.source,
      ...(isRecord(candidate.installationConfiguration)
        ? { installationConfiguration: structuredClone(candidate.installationConfiguration) }
        : {}),
      ...(isRecord(candidate.exposureConfigurations)
        ? { exposureConfigurations: structuredClone(candidate.exposureConfigurations) }
        : {}),
    };
  });
  const unsigned = { format: CONNECT_PLUGIN_CATALOG_FORMAT, generatedAt: value.generatedAt, plugins };
  let authenticated = false;
  try {
    authenticated = verify(
      null,
      officialCatalogSigningPayload(unsigned),
      publicKey,
      Buffer.from(value.signature, "base64"),
    );
  } catch (error) {
    throw new Error(`Official Plugin Catalog authentication failed: ${errorMessage(error)}`);
  }
  if (!authenticated) throw new Error("Official Plugin Catalog authentication failed: invalid signature");
  return { ...unsigned, signature: value.signature };
}

async function writeCatalogCache(path: string, catalog: OfficialPluginCatalogV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateProbeResult(value: unknown, pluginId: string): ConnectPluginRuntimeProbeResult {
  if (!isRecord(value) || typeof value.detected !== "boolean" || typeof value.compatible !== "boolean") {
    throw new Error(`Official Plugin ${pluginId} runtime probe returned a malformed result`);
  }
  if (!value.detected && value.compatible) {
    throw new Error(`Official Plugin ${pluginId} runtime probe cannot report compatibility without detection`);
  }
  for (const field of ["version", "path", "detail"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Official Plugin ${pluginId} runtime probe ${field} is malformed`);
    }
  }
  return {
    detected: value.detected,
    compatible: value.compatible,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  };
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  if (!command || command.includes("/") || command.includes("\\")) {
    throw new Error("Runtime probe executable names must be bare command names");
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue to the next operator-configured PATH entry.
    }
  }
  return null;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
