import { basename } from "node:path";

interface BetaTagVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  sequence: bigint;
}

export interface PublishBetaReleaseInput {
  tag: string;
  notesFile: string;
  assets: readonly string[];
}

export interface PublishBetaReleaseWithGhInput extends PublishBetaReleaseInput {
  repository: string;
}

export interface GhCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GhCommandRunner = (arguments_: readonly string[]) => Promise<GhCommandResult>;

export interface ReleaseBetaEnvironment {
  [name: string]: string | undefined;
  GITHUB_REF_NAME?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_SHA?: string;
}

export interface BetaReleasePublisher {
  readRelease(tag: string): Promise<PublishedBetaRelease | null>;
  createRelease(input: PublishBetaReleaseInput): Promise<void>;
}

export interface PublishedBetaRelease {
  tag: string;
  prerelease: boolean;
  assetNames: readonly string[];
}

export interface BetaChannelPointer {
  tag: string;
  sha: string;
}

export interface BetaChannelClient {
  ensureChannelBranch(): Promise<void>;
  readChannelPointer(): Promise<BetaChannelPointer | null>;
  updateChannelPointer(input: { tag: string; expectedSha?: string }): Promise<"updated" | "conflict">;
}

export interface AdvanceBetaChannelInput {
  candidateTag: string;
  maxAttempts?: number;
}

export interface AdvanceBetaChannelWithGhInput extends AdvanceBetaChannelInput {
  repository: string;
  sourceSha: string;
  channelBranch?: string;
  channelPath?: string;
}

export interface AdvanceBetaChannelResult {
  status: "advanced" | "unchanged";
  tag: string;
  attempts: number;
}

const requiredBetaReleaseAssetNames = [
  "CHANGELOG.md",
  "checksums.txt",
  "clawchat-connect-darwin-arm64.tar.gz",
  "clawchat-connect-darwin-x64.tar.gz",
  "clawchat-connect-linux-arm64.tar.gz",
  "clawchat-connect-linux-x64.tar.gz",
  "clawchat-connect-windows-arm64.zip",
  "clawchat-connect-windows-x64.zip",
  "install.ps1",
  "install.sh",
] as const;

function parseBetaTag(tag: string): BetaTagVersion {
  const match = /^v(\d+)\.(\d+)\.(\d+)-beta\.([1-9]\d*)$/u.exec(tag);
  if (!match) throw new Error(`Expected a beta release tag, received ${tag}`);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    sequence: BigInt(match[4]),
  };
}

export function compareBetaTags(leftTag: string, rightTag: string): number {
  const left = parseBetaTag(leftTag);
  const right = parseBetaTag(rightTag);
  for (const component of ["major", "minor", "patch", "sequence"] as const) {
    if (left[component] > right[component]) return 1;
    if (left[component] < right[component]) return -1;
  }
  return 0;
}

export async function publishImmutableBetaRelease(
  input: PublishBetaReleaseInput,
  publisher: BetaReleasePublisher,
): Promise<void> {
  parseBetaTag(input.tag);
  const expectedAssetNames = sortedAssetNames(input.assets.map((asset) => basename(asset)));
  if (!sameAssetNames(expectedAssetNames, requiredBetaReleaseAssetNames)) {
    throw new Error("Prepared beta release assets do not match the required release inventory");
  }
  const existing = await publisher.readRelease(input.tag);
  if (existing) {
    if (
      existing.tag === input.tag &&
      existing.prerelease &&
      sameAssetNames(existing.assetNames, expectedAssetNames)
    ) {
      return;
    }
    throw new Error(`Release ${input.tag} does not match the complete immutable prerelease`);
  }
  await publisher.createRelease(input);
}

export async function publishBetaReleaseWithGh(
  input: PublishBetaReleaseWithGhInput,
  runGh: GhCommandRunner,
): Promise<void> {
  await publishImmutableBetaRelease(input, {
    readRelease: async (tag) => {
      const result = await runGh([
        "release",
        "view",
        tag,
        "--repo",
        input.repository,
        "--json",
        "tagName,isPrerelease,assets",
      ]);
      if (result.exitCode === 0) return parsePublishedBetaRelease(result.stdout);
      if (isNotFound(result.stderr)) return null;
      throw ghCommandError("view release", result);
    },
    createRelease: async (release) => {
      const result = await runGh([
        "release",
        "create",
        release.tag,
        ...release.assets,
        "--repo",
        input.repository,
        "--verify-tag",
        "--prerelease",
        "--title",
        `ClawChat Connect ${release.tag}`,
        "--notes-file",
        release.notesFile,
      ]);
      if (result.exitCode !== 0) throw ghCommandError("create release", result);
    },
  });
}

function parsePublishedBetaRelease(stdout: string): PublishedBetaRelease {
  const value = JSON.parse(stdout) as { tagName?: unknown; isPrerelease?: unknown; assets?: unknown };
  if (
    typeof value.tagName !== "string" ||
    typeof value.isPrerelease !== "boolean" ||
    !Array.isArray(value.assets) ||
    !value.assets.every(
      (asset): asset is { name: string } =>
        typeof asset === "object" && asset !== null && "name" in asset && typeof asset.name === "string",
    )
  ) {
    throw new Error("GitHub release response omitted tagName, isPrerelease, or asset names");
  }
  return {
    tag: value.tagName,
    prerelease: value.isPrerelease,
    assetNames: value.assets.map(({ name }) => name),
  };
}

function sortedAssetNames(assetNames: readonly string[]): string[] {
  return [...assetNames].sort();
}

function sameAssetNames(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = sortedAssetNames(left);
  const sortedRight = sortedAssetNames(right);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((name, index) => name === sortedRight[index]);
}

export async function advanceBetaChannel(
  input: AdvanceBetaChannelInput,
  client: BetaChannelClient,
): Promise<AdvanceBetaChannelResult> {
  parseBetaTag(input.candidateTag);
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Expected maxAttempts to be a positive integer, received ${maxAttempts}`);
  }
  await client.ensureChannelBranch();
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const current = await client.readChannelPointer();
    if (current && compareBetaTags(input.candidateTag, current.tag) <= 0) {
      return { status: "unchanged", tag: current.tag, attempts };
    }
    const update = await client.updateChannelPointer({
      tag: input.candidateTag,
      expectedSha: current?.sha,
    });
    if (update === "updated") {
      return { status: "advanced", tag: input.candidateTag, attempts };
    }
  }
  throw new Error(`Beta channel update conflicted ${maxAttempts} times for ${input.candidateTag}`);
}

export async function advanceBetaChannelWithGh(
  input: AdvanceBetaChannelWithGhInput,
  runGh: GhCommandRunner,
): Promise<AdvanceBetaChannelResult> {
  const channelBranch = input.channelBranch ?? "release-channel";
  const channelPath = input.channelPath ?? "latest-beta.txt";
  const branchEndpoint = `repos/${input.repository}/git/ref/heads/${channelBranch}`;
  const contentsEndpoint = `repos/${input.repository}/contents/${channelPath}`;
  const noCacheHeader = ["-H", "Cache-Control: no-cache"] as const;

  return advanceBetaChannel(input, {
    ensureChannelBranch: async () => {
      const result = await runGh(["api", branchEndpoint, ...noCacheHeader]);
      if (result.exitCode === 0) return;
      if (!isNotFound(result.stderr)) throw ghCommandError("read beta channel branch", result);

      const created = await runGh([
        "api",
        "--method",
        "POST",
        `repos/${input.repository}/git/refs`,
        "-f",
        `ref=refs/heads/${channelBranch}`,
        "-f",
        `sha=${input.sourceSha}`,
      ]);
      if (created.exitCode === 0) return;
      if (!isConflict(created.stderr)) throw ghCommandError("create beta channel branch", created);

      const refetched = await runGh(["api", branchEndpoint, ...noCacheHeader]);
      if (refetched.exitCode !== 0) throw ghCommandError("refetch beta channel branch", refetched);
    },
    readChannelPointer: async () => {
      const result = await runGh([
        "api",
        `${contentsEndpoint}?ref=${encodeURIComponent(channelBranch)}`,
        ...noCacheHeader,
      ]);
      if (result.exitCode !== 0) {
        if (isNotFound(result.stderr)) return null;
        throw ghCommandError("read beta channel pointer", result);
      }
      const response = JSON.parse(result.stdout) as { sha?: unknown; content?: unknown };
      if (typeof response.sha !== "string" || typeof response.content !== "string") {
        throw new Error("GitHub beta channel response omitted sha or content");
      }
      return {
        sha: response.sha,
        tag: Buffer.from(response.content.replaceAll(/\s/gu, ""), "base64").toString("utf8").trim(),
      };
    },
    updateChannelPointer: async ({ tag, expectedSha }) => {
      const arguments_ = [
        "api",
        "--method",
        "PUT",
        contentsEndpoint,
        "-f",
        `message=chore: advance beta channel to ${tag}`,
        "-f",
        `content=${Buffer.from(`${tag}\n`).toString("base64")}`,
        "-f",
        `branch=${channelBranch}`,
      ];
      if (expectedSha) arguments_.push("-f", `sha=${expectedSha}`);
      const result = await runGh(arguments_);
      if (result.exitCode === 0) return "updated";
      if (isConflict(result.stderr)) return "conflict";
      throw ghCommandError("update beta channel pointer", result);
    },
  });
}

export async function runReleaseBetaCli(
  arguments_: readonly string[],
  environment: ReleaseBetaEnvironment,
  runGh: GhCommandRunner = runGhCommand,
): Promise<void> {
  const [command, ...parameters] = arguments_;
  const tag = requireEnvironment(environment, "GITHUB_REF_NAME");
  const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
  if (command === "publish") {
    const [notesFile, ...assets] = parameters;
    if (!notesFile || assets.length === 0) {
      throw new Error("Usage: release-beta.ts publish <notes-file> <asset>...");
    }
    await publishBetaReleaseWithGh({ repository, tag, notesFile, assets }, runGh);
    console.log(`Published immutable prerelease ${tag}`);
    return;
  }
  if (command === "advance-channel") {
    if (parameters.length !== 0) throw new Error("Usage: release-beta.ts advance-channel");
    const result = await advanceBetaChannelWithGh(
      {
        repository,
        candidateTag: tag,
        sourceSha: requireEnvironment(environment, "GITHUB_SHA"),
      },
      runGh,
    );
    console.log(
      result.status === "advanced"
        ? `Advanced beta channel to ${result.tag}`
        : `Kept beta channel at ${result.tag}`,
    );
    return;
  }
  throw new Error("Usage: release-beta.ts <publish|advance-channel>");
}

function isNotFound(stderr: string): boolean {
  return /HTTP 404|not found/iu.test(stderr);
}

function isConflict(stderr: string): boolean {
  return /HTTP (409|422)/u.test(stderr);
}

function ghCommandError(operation: string, result: GhCommandResult): Error {
  return Object.assign(new Error(`Failed to ${operation}: ${result.stderr.trim() || "gh failed"}`), {
    exitCode: result.exitCode,
  });
}

function requireEnvironment(environment: ReleaseBetaEnvironment, name: keyof ReleaseBetaEnvironment): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function runGhCommand(arguments_: readonly string[]): Promise<GhCommandResult> {
  const child = Bun.spawn(["gh", ...arguments_], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

if (import.meta.main) {
  try {
    await runReleaseBetaCli(Bun.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode =
      typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number"
        ? error.exitCode
        : 1;
  }
}
