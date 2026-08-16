import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { MAX_PLUGIN_BUNDLE_BYTES } from "../client-contract";
import type { ManagedConnectPluginBundleV1 } from "./official-sdk";
import type { ConnectPluginSource } from "./sdk";
import {
  currentConnectPluginTarget,
  managedPluginUploadRoot,
  parseConnectPluginBundle,
  readConnectPluginBundle,
} from "./store";

export { pluginSourceIdentity } from "./store";
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_GITHUB_API = "https://api.github.com";
export const MAX_PLUGIN_SOURCE_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_PLUGIN_SOURCE_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_GITHUB_RELEASE_PAGES = 10;
export const MAX_GITHUB_RELEASE_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_GITHUB_ASSET_ATTEMPTS = 100;
export const MAX_GITHUB_ASSET_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_SOURCE_ARCHIVE_ENTRIES = 4_096;
const MAX_NPM_PACKAGE_METADATA_BYTES = 1024 * 1024;

export interface PluginSourceResolverOptions {
  fetch?: typeof fetch;
  npmRegistry?: string;
  githubApiBase?: string;
  target?: string;
}

export interface ResolvedPluginSource {
  source: ConnectPluginSource;
  bundle: ManagedConnectPluginBundleV1;
  target: string;
}

interface NpmVersionMetadata {
  version: string;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  digest: string | null;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

class GitHubSearchBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubSearchBoundError";
  }
}

export async function resolvePluginSource(
  reference: string,
  options: PluginSourceResolverOptions = {},
): Promise<ResolvedPluginSource> {
  const trimmed = reference.trim();
  if (!trimmed) throw new Error("Plugin source reference is required");
  if (trimmed.startsWith("npm:")) return await resolveNpmSource(trimmed.slice(4), options);
  if (trimmed.startsWith("github:") || /^https:\/\/github\.com\//u.test(trimmed)) {
    return await resolveGitHubSource(trimmed, options);
  }
  const path = resolve(trimmed.startsWith("local:") ? trimmed.slice(6) : trimmed);
  const bundle = await readConnectPluginBundle(path);
  const target = options.target ?? currentConnectPluginTarget();
  requireTarget(bundle, target, `local Bundle ${path}`);
  return { source: { type: "local", path }, bundle, target };
}
export async function persistUploadedPluginSource(
  configPath: string,
  fileName: string,
  bytes: Uint8Array,
  options: Pick<PluginSourceResolverOptions, "target"> = {},
): Promise<ResolvedPluginSource> {
  const bundle = parseConnectPluginBundle(bytes, fileName);
  const target = options.target ?? currentConnectPluginTarget();
  requireTarget(bundle, target, `uploaded Bundle ${fileName}`);
  const uploadRoot = managedPluginUploadRoot(configPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = resolve(uploadRoot, `${digest}.connect-plugin`);
  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  const rootDetails = await lstat(uploadRoot);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`Managed Plugin upload root is not a directory: ${uploadRoot}`);
  }
  const temporary = resolve(uploadRoot, `.${digest}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { source: { type: "local", path }, bundle, target };
}

export function updateReferenceForSource(source: ConnectPluginSource): string {
  if (source.type === "local") return `local:${source.path}`;
  if (source.type === "npm") return `npm:${source.package}`;
  return `github:${source.repository}`;
}

function npmReference(reference: string): { package: string; version?: string } {
  const separator = reference.startsWith("@") ? reference.lastIndexOf("@") : reference.indexOf("@");
  const hasVersion = separator > 0;
  const packageName = (hasVersion ? reference.slice(0, separator) : reference).trim();
  const version = hasVersion ? reference.slice(separator + 1).trim() : undefined;
  if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(packageName) || (hasVersion && !version)) {
    throw new Error(`Invalid npm Plugin reference: npm:${reference}`);
  }
  return { package: packageName, ...(version ? { version } : {}) };
}

async function resolveNpmSource(
  reference: string,
  options: PluginSourceResolverOptions,
): Promise<ResolvedPluginSource> {
  const parsed = npmReference(reference);
  const registry = new URL(options.npmRegistry ?? DEFAULT_NPM_REGISTRY).toString().replace(/\/$/u, "");
  const fetchSource = options.fetch ?? fetch;
  const metadata = await fetchJson(fetchSource, `${registry}/${encodeURIComponent(parsed.package)}`, {
    Accept: "application/vnd.npm.install-v1+json, application/json",
  });
  if (!isRecord(metadata) || !isRecord(metadata.versions)) {
    throw new Error(`npm registry returned malformed metadata for ${parsed.package}`);
  }
  const versions = Object.entries(metadata.versions)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([version, value]) => npmVersionMetadata(version, value))
    .filter((value): value is NpmVersionMetadata => value !== null);
  const exactCandidate = parsed.version
    ? versions.find((candidate) => candidate.version === parsed.version)
    : undefined;
  const candidates = parsed.version ? (exactCandidate ? [exactCandidate] : []) : stableVersionOrder(versions, metadata);
  if (candidates.length === 0) {
    throw new Error(
      `npm Plugin ${parsed.package}${parsed.version ? ` has no version ${parsed.version}` : " has no stable versions"}`,
    );
  }
  const target = options.target ?? currentConnectPluginTarget();
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const tarball = await fetchBytes(
        fetchSource,
        candidate.dist.tarball,
        { Accept: "application/octet-stream" },
        MAX_PLUGIN_SOURCE_DOWNLOAD_BYTES,
      );
      verifyDistributionIntegrity(tarball, candidate.dist, `${parsed.package}@${candidate.version} tarball`);
      const bundle = bundleFromNpmTarball(tarball, `${parsed.package}@${candidate.version}`);
      if (bundle.manifest.version !== candidate.version) {
        throw new Error(`Bundle version ${bundle.manifest.version} does not match npm version ${candidate.version}`);
      }
      requireTarget(bundle, target, `npm Plugin ${parsed.package}@${candidate.version}`);
      return {
        source: {
          type: "npm",
          package: parsed.package,
          registry,
          version: candidate.version,
          tarball: candidate.dist.tarball,
        },
        bundle,
        target,
      };
    } catch (error) {
      failures.push(`${candidate.version}: ${errorMessage(error)}`);
      if (parsed.version) break;
    }
  }
  throw new Error(
    `npm Plugin ${parsed.package} has no compatible ${target} Bundle after ${failures.length} candidate attempt${failures.length === 1 ? "" : "s"} (${failures.join("; ")})`,
  );
}

function npmVersionMetadata(version: string, value: Record<string, unknown>): NpmVersionMetadata | null {
  if (!isStableSemver(version) && typeof value.version !== "string") return null;
  if (!isRecord(value.dist) || typeof value.dist.tarball !== "string") return null;
  return {
    version: typeof value.version === "string" ? value.version : version,
    dist: {
      tarball: value.dist.tarball,
      ...(typeof value.dist.integrity === "string" ? { integrity: value.dist.integrity } : {}),
      ...(typeof value.dist.shasum === "string" ? { shasum: value.dist.shasum } : {}),
    },
  };
}

function stableVersionOrder(versions: NpmVersionMetadata[], metadata: Record<string, unknown>): NpmVersionMetadata[] {
  const stable = versions.filter((candidate) => isStableSemver(candidate.version));
  stable.sort((left, right) => compareSemver(right.version, left.version));
  const latest =
    isRecord(metadata["dist-tags"]) && typeof metadata["dist-tags"].latest === "string"
      ? metadata["dist-tags"].latest
      : null;
  if (!latest || !isStableSemver(latest)) return stable;
  return [
    ...stable.filter((candidate) => candidate.version === latest),
    ...stable.filter((candidate) => candidate.version !== latest),
  ];
}

function bundleFromNpmTarball(bytes: Uint8Array, label: string): ManagedConnectPluginBundleV1 {
  const archive = decompressNpmTarball(bytes, label);
  const files = readTarFiles(archive);
  let declaredPath: string | undefined;
  const packageJson = files.get("package/package.json") ?? files.get("package.json");
  if (packageJson) {
    const value = JSON.parse(new TextDecoder().decode(packageJson)) as unknown;
    if (isRecord(value)) {
      const declaration = value.clawchatConnectPlugin;
      if (typeof declaration === "string") declaredPath = declaration;
      else if (isRecord(declaration) && typeof declaration.bundle === "string") declaredPath = declaration.bundle;
    }
  }
  const normalizedDeclared = declaredPath ? declaredPath.replace(/^\.\//u, "").replace(/^package\//u, "") : undefined;
  const candidates = [...files.entries()].filter(([path]) => path.endsWith(".connect-plugin"));
  const selected = normalizedDeclared
    ? candidates.find(([path]) => path === normalizedDeclared || path === `package/${normalizedDeclared}`)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!selected) {
    throw new Error(`${label} tarball must contain exactly one declared .connect-plugin Bundle`);
  }
  return parseConnectPluginBundle(selected[1], `${label} tarball:${selected[0]}`);
}

function decompressNpmTarball(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    if (bytes.byteLength > MAX_PLUGIN_SOURCE_ARCHIVE_BYTES) {
      throw new Error(`${label} archive exceeds the ${MAX_PLUGIN_SOURCE_ARCHIVE_BYTES}-byte decompressed limit`);
    }
    return bytes;
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_PLUGIN_SOURCE_ARCHIVE_BYTES });
  } catch (error) {
    throw new Error(
      `${label} gzip archive is invalid or exceeds the ${MAX_PLUGIN_SOURCE_ARCHIVE_BYTES}-byte decompressed limit`,
      { cause: error },
    );
  }
}

function readTarFiles(archive: Uint8Array): Map<string, Uint8Array> {
  if (archive.byteLength > MAX_PLUGIN_SOURCE_ARCHIVE_BYTES) {
    throw new Error(`npm tarball exceeds the ${MAX_PLUGIN_SOURCE_ARCHIVE_BYTES}-byte decompressed limit`);
  }
  const files = new Map<string, Uint8Array>();
  let entries = 0;
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > MAX_PLUGIN_SOURCE_ARCHIVE_ENTRIES) {
      throw new Error(`npm tarball exceeds the ${MAX_PLUGIN_SOURCE_ARCHIVE_ENTRIES}-entry limit`);
    }
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarText(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || !path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("npm tarball contains a malformed entry");
    }
    if (path.endsWith(".connect-plugin") && size > MAX_PLUGIN_BUNDLE_BYTES) {
      throw new Error(`npm tarball Bundle exceeds the ${MAX_PLUGIN_BUNDLE_BYTES}-byte limit`);
    }
    if ((path === "package/package.json" || path === "package.json") && size > MAX_NPM_PACKAGE_METADATA_BYTES) {
      throw new Error(`npm tarball package metadata exceeds the ${MAX_NPM_PACKAGE_METADATA_BYTES}-byte limit`);
    }
    const start = offset + 512;
    const end = start + size;
    if (end > archive.length) throw new Error("npm tarball entry exceeds archive bounds");
    if (header[156] === 0 || header[156] === 48) files.set(path, archive.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function tarText(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return new TextDecoder().decode(zero >= 0 ? bytes.subarray(0, zero) : bytes);
}

async function resolveGitHubSource(
  reference: string,
  options: PluginSourceResolverOptions,
): Promise<ResolvedPluginSource> {
  const parsed = githubReference(reference);
  const apiBase = new URL(options.githubApiBase ?? DEFAULT_GITHUB_API).toString().replace(/\/$/u, "");
  const fetchSource = options.fetch ?? fetch;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  let releaseValues: unknown[];
  if (parsed.version) {
    let releaseValue: unknown;
    try {
      releaseValue = await fetchJson(
        fetchSource,
        `${apiBase}/repos/${parsed.repository}/releases/tags/${encodeURIComponent(parsed.version)}`,
        headers,
      );
    } catch (error) {
      if (parsed.version.startsWith("v")) throw error;
      releaseValue = await fetchJson(
        fetchSource,
        `${apiBase}/repos/${parsed.repository}/releases/tags/${encodeURIComponent(`v${parsed.version}`)}`,
        headers,
      );
    }
    releaseValues = [releaseValue];
  } else {
    releaseValues = await fetchGitHubReleasePages(
      fetchSource,
      `${apiBase}/repos/${parsed.repository}/releases?per_page=100`,
      headers,
      parsed.repository,
    );
  }
  const releases = releaseValues
    .map(githubRelease)
    .filter((release): release is GitHubRelease => release !== null && !release.draft)
    .filter(
      (release) => parsed.version || (!release.prerelease && isStableSemver(normalizeReleaseVersion(release.tag_name))),
    )
    .sort((left, right) =>
      compareSemver(normalizeReleaseVersion(right.tag_name), normalizeReleaseVersion(left.tag_name)),
    );
  if (releases.length === 0) {
    throw new Error(
      `GitHub Plugin ${parsed.repository}${parsed.version ? ` has no Release ${parsed.version}` : " has no stable Releases"}`,
    );
  }
  const target = options.target ?? currentConnectPluginTarget();
  const releaseCandidates = releases.map((release) => ({
    release,
    assets: release.assets
      .filter((asset) => asset.name.endsWith(".connect-plugin"))
      .sort((left, right) => {
        if (left.name !== right.name) return left.name < right.name ? -1 : 1;
        if (left.browser_download_url === right.browser_download_url) return 0;
        return left.browser_download_url < right.browser_download_url ? -1 : 1;
      }),
  }));
  const discoveredAssetCount = releaseCandidates.reduce((total, candidate) => total + candidate.assets.length, 0);
  const assetAttemptBudget = Math.min(discoveredAssetCount, MAX_GITHUB_ASSET_ATTEMPTS);
  const failures: string[] = [];
  let assetAttempts = 0;
  let downloadedAssetBytes = 0;
  let releaseAttempts = 0;
  for (const { release, assets } of releaseCandidates) {
    releaseAttempts += 1;
    for (const asset of assets) {
      if (assetAttempts >= MAX_GITHUB_ASSET_ATTEMPTS) {
        throw githubSearchBoundError(
          parsed.repository,
          `the ${MAX_GITHUB_ASSET_ATTEMPTS}-asset attempt limit was reached after ${releaseAttempts} Release candidates`,
        );
      }
      if (downloadedAssetBytes >= MAX_GITHUB_ASSET_DOWNLOAD_BYTES) {
        throw githubSearchBoundError(
          parsed.repository,
          `the ${MAX_GITHUB_ASSET_DOWNLOAD_BYTES}-byte aggregate asset download limit was reached after ${assetAttempts} asset attempts`,
        );
      }
      assetAttempts += 1;
      try {
        const label = `${parsed.repository} Release ${release.tag_name}/${asset.name}`;
        if (!asset.digest || !/^sha256:[0-9a-fA-F]{64}$/u.test(asset.digest)) {
          throw new Error(`${label} metadata does not provide a valid sha256 digest`);
        }
        const remainingDownloadBytes = MAX_GITHUB_ASSET_DOWNLOAD_BYTES - downloadedAssetBytes;
        let bytes: Uint8Array;
        try {
          bytes = await fetchBytes(
            fetchSource,
            asset.browser_download_url,
            { Accept: "application/octet-stream" },
            Math.min(MAX_PLUGIN_BUNDLE_BYTES, remainingDownloadBytes),
            (receivedBytes) => {
              downloadedAssetBytes += receivedBytes;
            },
          );
        } catch (error) {
          if (
            remainingDownloadBytes < MAX_PLUGIN_BUNDLE_BYTES &&
            errorMessage(error).includes("-byte download limit")
          ) {
            throw githubSearchBoundError(
              parsed.repository,
              `the ${MAX_GITHUB_ASSET_DOWNLOAD_BYTES}-byte aggregate asset download limit was exhausted during asset attempt ${assetAttempts}`,
            );
          }
          throw error;
        }
        const actualDigest = createHash("sha256").update(bytes).digest("hex");
        if (asset.digest.toLowerCase() !== `sha256:${actualDigest}`) {
          throw new Error(`${label} sha256 digest mismatch`);
        }
        const bundle = parseConnectPluginBundle(bytes, label);
        const releaseVersion = normalizeReleaseVersion(release.tag_name);
        if (bundle.manifest.version !== releaseVersion) {
          throw new Error(`Bundle version ${bundle.manifest.version} does not match Release ${release.tag_name}`);
        }
        requireTarget(bundle, target, `GitHub Plugin ${parsed.repository}@${release.tag_name}`);
        return {
          source: {
            type: "github",
            repository: parsed.repository,
            apiBase,
            version: bundle.manifest.version,
            release: release.tag_name,
            asset: asset.browser_download_url,
          },
          bundle,
          target,
        };
      } catch (error) {
        if (error instanceof GitHubSearchBoundError) throw error;
        failures.push(`${release.tag_name}/${asset.name}: ${errorMessage(error)}`);
      }
    }
    if (assets.length === 0) {
      failures.push(`${release.tag_name}: no .connect-plugin assets`);
    }
    if (parsed.version) break;
  }
  throw new Error(
    `GitHub Plugin ${parsed.repository} has no compatible ${target} Release asset after ${assetAttempts} of ${assetAttemptBudget} bounded asset attempts across ${releaseAttempts} of ${releases.length} Release candidates (${failures.join("; ")})`,
  );
}

async function fetchGitHubReleasePages(
  fetchSource: typeof fetch,
  initialUrl: string,
  headers: Record<string, string>,
  repository: string,
): Promise<unknown[]> {
  const releases: unknown[] = [];
  const visited = new Set<string>();
  let nextUrl: string | null = initialUrl;
  let pageCount = 0;
  let metadataBytes = 0;
  while (nextUrl) {
    if (pageCount >= MAX_GITHUB_RELEASE_PAGES) {
      throw githubSearchBoundError(
        repository,
        `the ${MAX_GITHUB_RELEASE_PAGES}-page Release metadata limit was reached while another page remained`,
      );
    }
    if (metadataBytes >= MAX_GITHUB_RELEASE_METADATA_BYTES) {
      throw githubSearchBoundError(
        repository,
        `the ${MAX_GITHUB_RELEASE_METADATA_BYTES}-byte aggregate Release metadata limit was reached while another page remained`,
      );
    }
    if (visited.has(nextUrl)) {
      throw githubSearchBoundError(repository, `GitHub returned a cyclic Release pagination link for ${nextUrl}`);
    }
    visited.add(nextUrl);
    const response = await fetchSource(nextUrl, { headers });
    if (!response.ok) throw new Error(`Plugin source request ${nextUrl} failed with HTTP ${response.status}`);
    const remainingMetadataBytes = MAX_GITHUB_RELEASE_METADATA_BYTES - metadataBytes;
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponseBytes(
        response,
        `Plugin source response ${nextUrl}`,
        Math.min(MAX_PLUGIN_SOURCE_METADATA_BYTES, remainingMetadataBytes),
      );
    } catch (error) {
      if (errorMessage(error).includes("-byte download limit")) {
        throw githubSearchBoundError(
          repository,
          `Release metadata exceeded the ${MAX_PLUGIN_SOURCE_METADATA_BYTES}-byte per-page or ${MAX_GITHUB_RELEASE_METADATA_BYTES}-byte aggregate limit on page ${pageCount + 1}`,
        );
      }
      throw error;
    }
    metadataBytes += bytes.byteLength;
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!Array.isArray(value)) {
      throw new Error(`GitHub Plugin ${repository} Release page ${pageCount + 1} was not an array`);
    }
    releases.push(...value);
    pageCount += 1;
    nextUrl = githubNextLink(response.headers.get("link"), nextUrl);
  }
  return releases;
}

function githubNextLink(linkHeader: string | null, baseUrl: string): string | null {
  if (!linkHeader) return null;
  for (const entry of linkHeader.split(/,(?=\s*<)/u)) {
    const match = entry.match(/^\s*<([^>]+)>(.*)$/u);
    if (!match?.[1]) continue;
    const parameters = match[2] ?? "";
    const relation = parameters.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/iu);
    const relationValue = relation?.[1] ?? relation?.[2];
    if (!relationValue?.split(/\s+/u).some((value) => value.toLowerCase() === "next")) continue;
    return new URL(match[1], baseUrl).toString();
  }
  return null;
}

function githubSearchBoundError(repository: string, detail: string): GitHubSearchBoundError {
  return new GitHubSearchBoundError(
    `GitHub Plugin ${repository} search bound exhausted before compatibility could be determined: ${detail}`,
  );
}

function githubReference(reference: string): { repository: string; version?: string } {
  let value = reference.startsWith("github:") ? reference.slice(7) : reference.replace(/^https:\/\/github\.com\//u, "");
  value = value.replace(/\/$/u, "");
  const release = value.match(/^([^/]+\/[^/]+)\/releases\/tag\/(.+)$/u);
  const releaseRepository = release?.[1];
  const releaseVersion = release?.[2];
  if (releaseRepository && releaseVersion) {
    return { repository: releaseRepository, version: decodeURIComponent(releaseVersion) };
  }
  const separator = value.lastIndexOf("@");
  const repository = (separator > 0 ? value.slice(0, separator) : value).replace(/\.git$/u, "");
  const version = separator > 0 ? value.slice(separator + 1) : undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || (separator > 0 && !version)) {
    throw new Error(`Invalid GitHub Plugin reference: ${reference}`);
  }
  return { repository, ...(version ? { version } : {}) };
}

function githubRelease(value: unknown): GitHubRelease | null {
  if (!isRecord(value) || typeof value.tag_name !== "string" || !Array.isArray(value.assets)) return null;
  const assets = value.assets
    .filter(isRecord)
    .filter((asset) => typeof asset.name === "string" && typeof asset.browser_download_url === "string")
    .map((asset) => ({
      name: asset.name as string,
      browser_download_url: asset.browser_download_url as string,
      digest: typeof asset.digest === "string" ? asset.digest : null,
    }));
  return { tag_name: value.tag_name, draft: value.draft === true, prerelease: value.prerelease === true, assets };
}

function verifyDistributionIntegrity(bytes: Uint8Array, distribution: NpmVersionMetadata["dist"], label: string): void {
  if (distribution.integrity) {
    const [algorithm, expected] = distribution.integrity.split("-", 2);
    if ((algorithm !== "sha512" && algorithm !== "sha256") || !expected) {
      throw new Error(`${label} has unsupported registry integrity`);
    }
    const actual = createHash(algorithm).update(bytes).digest("base64");
    if (actual !== expected) throw new Error(`${label} integrity mismatch`);
    return;
  }
  if (distribution.shasum) {
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual !== distribution.shasum) throw new Error(`${label} shasum mismatch`);
    return;
  }
  throw new Error(`${label} metadata does not provide registry integrity`);
}

function requireTarget(bundle: ManagedConnectPluginBundleV1, target: string, label: string): void {
  if (!bundle.manifest.artifacts.some((artifact) => artifact.target === target)) {
    throw new Error(`${label} does not support Connect target ${target}`);
  }
}

function isStableSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/u.test(version);
}

function normalizeReleaseVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function compareSemver(left: string, right: string): number {
  const leftParts = normalizeReleaseVersion(left).split(/[.+-]/u).slice(0, 3).map(Number);
  const rightParts = normalizeReleaseVersion(right).split(/[.+-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

async function fetchJson(fetchSource: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const bytes = await fetchBytes(fetchSource, url, headers, MAX_PLUGIN_SOURCE_METADATA_BYTES);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function fetchBytes(
  fetchSource: typeof fetch,
  url: string,
  headers: Record<string, string>,
  maxBytes: number,
  onBytesReceived?: (byteLength: number) => void,
): Promise<Uint8Array> {
  const response = await fetchSource(url, { headers });
  if (!response.ok) throw new Error(`Plugin source request ${url} failed with HTTP ${response.status}`);
  return await readBoundedResponseBytes(response, `Plugin source response ${url}`, maxBytes, onBytesReceived);
}

export async function readBoundedResponseBytes(
  response: Response,
  label: string,
  maxBytes: number,
  onBytesReceived?: (byteLength: number) => void,
): Promise<Uint8Array> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} declared an invalid body length`);
    }
    if (declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds the ${maxBytes}-byte download limit`);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    onBytesReceived?.(chunk.value.byteLength);
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds the ${maxBytes}-byte download limit`);
    }
    chunks.push(chunk.value);
  }
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
