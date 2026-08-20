import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFICIAL_LIVEWARE_BINARY_SOURCES,
  type OfficialLivewareBinaryTarget,
  officialLivewareBinarySource,
} from "../src/plugin/official/liveware-binaries";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultBundleDirectory = join(repositoryRoot, "vendor", "liveware");
export type LivewareBinaryFetch = (input: string | URL | Request) => Promise<Response>;

export interface SyncLivewareBinariesOptions {
  readonly bundleDirectory?: string;
  readonly targets?: readonly string[];
  readonly fetch?: LivewareBinaryFetch;
}

export interface SyncedLivewareBinary {
  readonly target: OfficialLivewareBinaryTarget;
  readonly asset: string;
  readonly checksum: string;
}

export async function syncLivewareBinaries(
  options: SyncLivewareBinariesOptions = {},
): Promise<readonly SyncedLivewareBinary[]> {
  const bundleDirectory = resolve(options.bundleDirectory ?? defaultBundleDirectory);
  const targets = normalizeTargets(options.targets);
  const fetchBinary = options.fetch ?? globalThis.fetch;
  const sources = targets.map((target) => ({ target, ...officialLivewareBinarySource(target) }));

  await mkdir(bundleDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(bundleDirectory, ".sync-"));
  const staged: SyncedLivewareBinary[] = [];

  try {
    for (const source of sources) {
      const response = await fetchBinary(source.url);
      if (!response.ok) {
        throw new Error(`Failed to download official Liveware binary for ${source.target}: HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error(`Failed to download official Liveware binary for ${source.target}: empty response`);
      }
      const checksum = createHash("sha256").update(bytes).digest("hex");
      await writeFile(join(stagingDirectory, source.asset), bytes, { mode: 0o755 });
      staged.push({ target: source.target, asset: source.asset, checksum });
    }

    const manifestPath = join(bundleDirectory, "SHA256SUMS");
    const manifest = await readChecksumManifest(manifestPath);
    for (const binary of staged) manifest.set(binary.asset, binary.checksum);

    for (const binary of staged) {
      const bytes = await readFile(join(stagingDirectory, binary.asset));
      const destination = join(bundleDirectory, binary.asset);
      await writeFile(destination, bytes, { mode: 0o755 });
      await chmod(destination, 0o755);
    }
    await writeFile(manifestPath, serializeChecksumManifest(manifest));

    return staged;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function normalizeTargets(targets: readonly string[] | undefined): readonly OfficialLivewareBinaryTarget[] {
  const requested = targets ?? Object.keys(OFFICIAL_LIVEWARE_BINARY_SOURCES);
  return [...new Set(requested)].map((target) => {
    officialLivewareBinarySource(target);
    return target as OfficialLivewareBinaryTarget;
  });
}

async function readChecksumManifest(path: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return new Map();
    throw error;
  }

  const manifest = new Map<string, string>();
  for (const line of text.trim().split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^(?<checksum>[0-9a-f]{64})\s+(?<asset>\S+)$/u.exec(line);
    if (!match?.groups) throw new Error(`Invalid Liveware checksum manifest line: ${line}`);
    manifest.set(match.groups.asset, match.groups.checksum);
  }
  return manifest;
}

function serializeChecksumManifest(manifest: ReadonlyMap<string, string>): string {
  return [...manifest]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([asset, checksum]) => `${checksum}  ${asset}\n`)
    .join("");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseTargets(arguments_: readonly string[]): readonly string[] | undefined {
  if (arguments_.length === 0) return undefined;
  const targets: string[] = [];
  for (let index = 0; index < arguments_.length; index += 2) {
    if (arguments_[index] !== "--target" || !arguments_[index + 1]) {
      throw new Error("Usage: bun scripts/sync-liveware-binaries.ts [--target <target>]...");
    }
    targets.push(arguments_[index + 1]);
  }
  return targets;
}

if (import.meta.main) {
  const synced = await syncLivewareBinaries({ targets: parseTargets(process.argv.slice(2)) });
  for (const binary of synced) console.log(`${binary.target}: ${binary.asset} sha256-${binary.checksum}`);
}
