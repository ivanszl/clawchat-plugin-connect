import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ConnectPluginBundleV1, ConnectPluginSource } from "./sdk";
import {
  currentConnectPluginTarget,
  parseConnectPluginBundle,
  pluginInstallationPaths,
  readConnectPluginBundle,
} from "./store";

export { pluginSourceIdentity } from "./store";
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_GITHUB_API = "https://api.github.com";

export interface PluginSourceResolverOptions {
  fetch?: typeof fetch;
  npmRegistry?: string;
  githubApiBase?: string;
  target?: string;
}

export interface ResolvedPluginSource {
  source: ConnectPluginSource;
  bundle: ConnectPluginBundleV1;
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
  const uploadRoot = resolve(pluginInstallationPaths(configPath).root, "plugin-uploads");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = resolve(uploadRoot, `${digest}.connect-plugin`);
  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
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
  const candidates = parsed.version
    ? versions.filter((candidate) => candidate.version === parsed.version)
    : stableVersionOrder(versions, metadata);
  if (candidates.length === 0) {
    throw new Error(
      `npm Plugin ${parsed.package}${parsed.version ? ` has no version ${parsed.version}` : " has no stable versions"}`,
    );
  }
  const target = options.target ?? currentConnectPluginTarget();
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const tarball = await fetchBytes(fetchSource, candidate.dist.tarball, { Accept: "application/octet-stream" });
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
  throw new Error(`npm Plugin ${parsed.package} has no compatible ${target} Bundle (${failures.join("; ")})`);
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

function bundleFromNpmTarball(bytes: Uint8Array, label: string): ConnectPluginBundleV1 {
  const archive = bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes)) : bytes;
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

function readTarFiles(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarText(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || !path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("npm tarball contains a malformed entry");
    }
    const start = offset + 512;
    const end = start + size;
    if (end > archive.length) throw new Error("npm tarball entry exceeds archive bounds");
    if (header[156] === 0 || header[156] === 48) files.set(path, archive.slice(start, end));
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
  let releaseValue: unknown;
  if (parsed.version) {
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
  } else {
    releaseValue = await fetchJson(fetchSource, `${apiBase}/repos/${parsed.repository}/releases?per_page=100`, headers);
  }
  const releases = (Array.isArray(releaseValue) ? releaseValue : [releaseValue])
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
  const failures: string[] = [];
  for (const release of releases) {
    const assets = release.assets.filter((asset) => asset.name.endsWith(".connect-plugin"));
    const preferred = assets.filter((asset) => asset.name.includes(target));
    const candidates = preferred.length > 0 ? preferred : assets.length === 1 ? assets : [];
    for (const asset of candidates) {
      try {
        const label = `${parsed.repository} Release ${release.tag_name}/${asset.name}`;
        if (!asset.digest || !/^sha256:[0-9a-fA-F]{64}$/u.test(asset.digest)) {
          throw new Error(`${label} metadata does not provide a valid sha256 digest`);
        }
        const bytes = await fetchBytes(fetchSource, asset.browser_download_url, { Accept: "application/octet-stream" });
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
        failures.push(`${release.tag_name}/${asset.name}: ${errorMessage(error)}`);
      }
    }
    if (candidates.length === 0) {
      failures.push(`${release.tag_name}: no unambiguous versioned .connect-plugin asset`);
    }
    if (parsed.version) break;
  }
  throw new Error(
    `GitHub Plugin ${parsed.repository} has no compatible ${target} Release asset (${failures.join("; ")})`,
  );
}

function githubReference(reference: string): { repository: string; version?: string } {
  let value = reference.startsWith("github:") ? reference.slice(7) : reference.replace(/^https:\/\/github\.com\//u, "");
  value = value.replace(/\/$/u, "");
  const release = value.match(/^([^/]+\/[^/]+)\/releases\/tag\/(.+)$/u);
  if (release) return { repository: release[1]!, version: decodeURIComponent(release[2]!) };
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

function requireTarget(bundle: ConnectPluginBundleV1, target: string, label: string): void {
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
  const response = await fetchSource(url, { headers });
  if (!response.ok) throw new Error(`Plugin source request ${url} failed with HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

async function fetchBytes(
  fetchSource: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Uint8Array> {
  const response = await fetchSource(url, { headers });
  if (!response.ok) throw new Error(`Plugin source request ${url} failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
