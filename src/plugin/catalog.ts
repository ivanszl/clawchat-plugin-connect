import { randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import type { ManagedConnectPluginManifestV1 } from "./official-sdk";
import type { ConnectPluginSource } from "./sdk";
import type { PluginSourceResolverOptions } from "./source";
import { readBoundedResponseBytes } from "./source";
import type { OfficialPluginCapabilityGrant } from "./store";
import { pluginInstallationPaths } from "./store";

export const CONNECT_PLUGIN_CATALOG_FORMAT = "clawchat-connect-plugin-catalog-v1" as const;
export const OFFICIAL_PLUGIN_CATALOG_URL = "https://plugins.clawchat.ai/v1/catalog.json";
export const MAX_OFFICIAL_PLUGIN_CATALOG_BYTES = 4 * 1024 * 1024;
export const OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvsVHDCNTOmCpScmRqdyHQjI3JfDBKGc+t74UTbkg7Gs=
-----END PUBLIC KEY-----`;
export interface OfficialRuntimeDiscoveryRule {
  readonly executableNames: readonly string[];
  readonly versionCommand?: {
    readonly argv: readonly string[];
    readonly outputPattern: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
}

export interface OfficialDiscoveryCommandRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface OfficialPluginCatalogEntry {
  pluginId: string;
  name: string;
  source: string;
  version: string;
  target: string;
  integrity: string;
  discovery?: OfficialRuntimeDiscoveryRule;
  capabilityGrants?: readonly OfficialPluginCapabilityGrant[];
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
  runDiscoveryCommand?: (request: OfficialDiscoveryCommandRequest) => Promise<{ readonly stdout: string }>;
}

export interface OfficialCatalogResult {
  catalog: OfficialPluginCatalogV1 | null;
  origin: "remote" | "cache" | null;
  diagnostics: string[];
}

export interface OfficialRuntimeDiscoveryResult {
  readonly detected: boolean;
  readonly compatible: boolean;
  readonly executablePath?: string;
  readonly version?: string;
}

export interface OfficialPluginCandidate {
  pluginId: string;
  name: string;
  source: string;
  version: string;
  target: string;
  integrity: string;
  detected: boolean;
  compatible: boolean;
  selected: boolean;
  selectable: true;
  discovery: OfficialRuntimeDiscoveryResult | null;
  diagnostic: string | null;
  resolvedSource: ConnectPluginSource | null;
  manifest: ManagedConnectPluginManifestV1 | null;
  capabilityGrants: readonly OfficialPluginCapabilityGrant[];
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
  onCandidate?: (catalogEntry: OfficialPluginCatalogEntry) => void | Promise<void>,
): Promise<OfficialPluginDiscovery> {
  const loaded = await fetchOfficialPluginCatalog(configPath, options);
  if (!loaded.catalog) return { candidates: [], catalogOrigin: null, diagnostics: loaded.diagnostics };
  const candidates: OfficialPluginCandidate[] = [];
  const findExecutable = options.findExecutable ?? findExecutableOnPath;
  const runCommand = options.runDiscoveryCommand ?? runDiscoveryCommand;
  for (const catalogEntry of loaded.catalog.plugins) {
    await onCandidate?.(catalogEntry);
    const base = {
      pluginId: catalogEntry.pluginId,
      name: catalogEntry.name,
      source: catalogEntry.source,
      version: catalogEntry.version,
      target: catalogEntry.target,
      integrity: catalogEntry.integrity,
      selectable: true as const,
      resolvedSource: null,
      manifest: null,
      capabilityGrants: structuredClone(catalogEntry.capabilityGrants ?? []),
      installationConfiguration: structuredClone(catalogEntry.installationConfiguration ?? {}),
      exposureConfigurations: structuredClone(catalogEntry.exposureConfigurations ?? {}),
    };
    if (catalogEntry.target !== (options.target ?? `${process.platform}-${process.arch}`)) {
      candidates.push({
        ...base,
        detected: false,
        compatible: false,
        selected: false,
        discovery: null,
        diagnostic: `Official Plugin target ${catalogEntry.target} is incompatible with ${options.target ?? `${process.platform}-${process.arch}`}`,
      });
      continue;
    }
    if (!catalogEntry.discovery) {
      candidates.push({
        ...base,
        detected: false,
        compatible: false,
        selected: false,
        discovery: null,
        diagnostic: "Official Plugin has no declarative runtime discovery rule; it remains manually selectable",
      });
      continue;
    }
    try {
      let executablePath: string | null = null;
      for (const command of catalogEntry.discovery.executableNames) {
        executablePath = await findExecutable(command);
        if (executablePath) break;
      }
      if (!executablePath) {
        candidates.push({
          ...base,
          detected: false,
          compatible: false,
          selected: false,
          discovery: { detected: false, compatible: false },
          diagnostic: "Declared runtime executable was not found",
        });
        continue;
      }
      const versionCommand = catalogEntry.discovery.versionCommand;
      if (!versionCommand) {
        const discovery = { detected: true, compatible: true, executablePath } as const;
        candidates.push({ ...base, ...discovery, selected: true, discovery, diagnostic: null });
        continue;
      }
      const result = await withTimeout(
        runCommand({
          executable: executablePath,
          argv: versionCommand.argv,
          timeoutMs: versionCommand.timeoutMs,
          maxOutputBytes: versionCommand.maxOutputBytes,
        }),
        versionCommand.timeoutMs,
        `Official Plugin ${catalogEntry.pluginId} discovery command timed out after ${versionCommand.timeoutMs} ms`,
      );
      if (Buffer.byteLength(result.stdout) > versionCommand.maxOutputBytes) {
        throw new Error(
          `Official Plugin ${catalogEntry.pluginId} discovery command exceeded its ${versionCommand.maxOutputBytes}-byte output limit`,
        );
      }
      const match = new RegExp(versionCommand.outputPattern, "u").exec(result.stdout.trim());
      const compatible = match !== null;
      const version = match?.groups?.version;
      const discovery = {
        detected: true,
        compatible,
        executablePath,
        ...(version ? { version } : {}),
      };
      candidates.push({
        ...base,
        detected: true,
        compatible,
        selected: compatible,
        discovery,
        diagnostic: compatible ? null : "Detected runtime version output did not match the Catalog compatibility rule",
      });
    } catch (error) {
      candidates.push({
        ...base,
        detected: true,
        compatible: false,
        selected: false,
        discovery: { detected: true, compatible: false },
        diagnostic: `Official Plugin discovery failed in isolation: ${errorMessage(error)}`,
      });
    }
  }
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
      !candidate.source.trim() ||
      typeof candidate.version !== "string" ||
      !candidate.version.trim() ||
      typeof candidate.target !== "string" ||
      !candidate.target.trim() ||
      typeof candidate.integrity !== "string" ||
      !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(candidate.integrity)
    ) {
      throw new Error("Official Plugin Catalog entry identity, source, version, target, or integrity is malformed");
    }
    if (identities.has(candidate.pluginId)) {
      throw new Error(`Duplicate official Plugin identity: ${candidate.pluginId}`);
    }
    identities.add(candidate.pluginId);
    const capabilityGrants = validateCatalogCapabilityGrants(candidate.capabilityGrants, candidate.pluginId);
    return {
      pluginId: candidate.pluginId,
      name: candidate.name,
      source: candidate.source,
      version: candidate.version,
      target: candidate.target,
      integrity: candidate.integrity,
      ...(candidate.discovery !== undefined
        ? { discovery: validateDiscoveryRule(candidate.discovery, candidate.pluginId) }
        : {}),
      ...(capabilityGrants ? { capabilityGrants } : {}),
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

function validateDiscoveryRule(value: unknown, pluginId: string): OfficialRuntimeDiscoveryRule {
  if (!isRecord(value)) throw new Error(`Official Plugin ${pluginId} discovery rule is malformed`);
  assertOnlyKeys(value, ["executableNames", "versionCommand"], `Official Plugin ${pluginId} discovery rule`);
  if (
    !Array.isArray(value.executableNames) ||
    value.executableNames.length < 1 ||
    value.executableNames.length > 8 ||
    value.executableNames.some(
      (command) => typeof command !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command),
    )
  ) {
    throw new Error(`Official Plugin ${pluginId} discovery executable lookup is malformed`);
  }
  if (new Set(value.executableNames).size !== value.executableNames.length) {
    throw new Error(`Official Plugin ${pluginId} discovery executable lookup contains duplicates`);
  }
  if (value.versionCommand === undefined) {
    return { executableNames: [...value.executableNames] as string[] };
  }
  if (!isRecord(value.versionCommand)) {
    throw new Error(`Official Plugin ${pluginId} version command is malformed`);
  }
  assertOnlyKeys(
    value.versionCommand,
    ["argv", "outputPattern", "timeoutMs", "maxOutputBytes"],
    `Official Plugin ${pluginId} version command`,
  );
  const { argv, outputPattern, timeoutMs, maxOutputBytes } = value.versionCommand;
  if (
    !Array.isArray(argv) ||
    argv.length > 16 ||
    argv.some((argument) => typeof argument !== "string" || argument.length > 256 || argument.includes("\0"))
  ) {
    throw new Error(`Official Plugin ${pluginId} version command argv is malformed`);
  }
  if (typeof outputPattern !== "string" || !outputPattern || outputPattern.length > 512) {
    throw new Error(`Official Plugin ${pluginId} version output matcher is malformed`);
  }
  try {
    new RegExp(outputPattern, "u");
  } catch (error) {
    throw new Error(`Official Plugin ${pluginId} version output matcher is invalid`, { cause: error });
  }
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 10_000) {
    throw new Error(`Official Plugin ${pluginId} version command timeout is outside 1..10000 ms`);
  }
  if (!Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1 || (maxOutputBytes as number) > 65_536) {
    throw new Error(`Official Plugin ${pluginId} version command output limit is outside 1..65536 bytes`);
  }
  return {
    executableNames: [...value.executableNames] as string[],
    versionCommand: {
      argv: [...argv] as string[],
      outputPattern,
      timeoutMs: timeoutMs as number,
      maxOutputBytes: maxOutputBytes as number,
    },
  };
}

function validateCatalogCapabilityGrants(
  value: unknown,
  pluginId: string,
): readonly OfficialPluginCapabilityGrant[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Official Plugin ${pluginId} capability grants are malformed`);
  const grants = value.map((grant): OfficialPluginCapabilityGrant => {
    if (
      !isRecord(grant) ||
      grant.type !== "exposure" ||
      typeof grant.capabilityId !== "string" ||
      !grant.capabilityId.trim() ||
      typeof grant.artifactIntegrity !== "string" ||
      !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(grant.artifactIntegrity)
    ) {
      throw new Error(`Official Plugin ${pluginId} capability grant is malformed`);
    }
    return {
      type: "exposure",
      capabilityId: grant.capabilityId,
      artifactIntegrity: grant.artifactIntegrity,
    };
  });
  if (new Set(grants.map((grant) => grant.capabilityId)).size !== grants.length) {
    throw new Error(`Official Plugin ${pluginId} capability grants contain duplicates`);
  }
  return grants;
}

async function runDiscoveryCommand(request: OfficialDiscoveryCommandRequest): Promise<{ readonly stdout: string }> {
  const subprocess = Bun.spawn([request.executable, ...request.argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const [exitCode, stdout] = await Promise.all([
      withTimeout(subprocess.exited, request.timeoutMs, `Discovery command timed out after ${request.timeoutMs} ms`),
      readBoundedCommandOutput(subprocess.stdout, request.maxOutputBytes),
    ]);
    if (exitCode !== 0) throw new Error(`Discovery command exited with status ${exitCode}`);
    return { stdout };
  } catch (error) {
    subprocess.kill();
    throw error;
  }
}

async function readBoundedCommandOutput(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let observed = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      observed += next.value.byteLength;
      if (observed > maximumBytes) throw new Error(`Discovery command exceeded its ${maximumBytes}-byte output limit`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(observed);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  if (!command || command.includes("/") || command.includes("\\")) {
    throw new Error("Runtime discovery executable names must be bare command names");
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

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported field: ${unsupported.sort().join(", ")}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
