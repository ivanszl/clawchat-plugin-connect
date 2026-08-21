import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = join(repositoryRoot, "build", "release");

export interface ReleaseTarget {
  platform: "darwin";
  architecture: "arm64";
  archiveName: "clawchat-connect-darwin-arm64.tar.gz";
  archiveFormat: "tar.gz";
  connectExecutable: "clawchat-connect";
}

export interface ReleasePayload {
  entries: readonly string[];
}

export interface ReleasePhase {
  name: string;
  command?: readonly string[];
}

export interface ReleaseBuildOptions {
  version: string;
  target: ReleaseTarget;
  runPhase?: (phase: ReleasePhase) => Promise<void>;
}

const releaseTarget: ReleaseTarget = {
  platform: "darwin",
  architecture: "arm64",
  archiveName: "clawchat-connect-darwin-arm64.tar.gz",
  archiveFormat: "tar.gz",
  connectExecutable: "clawchat-connect",
};

export function requireBetaVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version)) {
    throw new Error(`Expected a beta release version, received ${version}`);
  }
  return version;
}

export function resolveReleaseTarget(platform: NodeJS.Platform, architecture: string): ReleaseTarget {
  if (platform !== releaseTarget.platform || architecture !== releaseTarget.architecture) {
    throw new Error(`Current beta releases support only darwin/arm64, received ${platform}/${architecture}`);
  }
  return releaseTarget;
}

export function releasePayload(_target: ReleaseTarget): ReleasePayload {
  return {
    entries: [
      "clawchat-connect",
      "clawchat-connect-client",
      "official-plugins",
      "skills",
      "CHANGELOG.md",
      "LICENSE",
    ],
  };
}

export function releasePhases(target: ReleaseTarget): readonly ReleasePhase[] {
  const connectExecutable = join("dist", target.connectExecutable);
  const clientDirectory = join("dist", "client");
  const officialPluginsDirectory = join("dist", "official-plugins");
  const pluginTarget = `${target.platform}-${target.architecture}`;
  const outputArchive = join("build", "release", target.archiveName);
  const packageCommand = [
    "sh",
    join("scripts", "package-release-archive.sh"),
    connectExecutable,
    clientDirectory,
    officialPluginsDirectory,
    outputArchive,
    pluginTarget,
  ];

  return [
    { name: "validate version" },
    { name: "prepare output" },
    { name: "release checks", command: [process.execPath, "run", "check:release"] },
    {
      name: "verify Liveware bundle",
      command: [process.execPath, join("scripts", "verify-liveware-bundle.ts")],
    },
    { name: "clean distributable", command: [process.execPath, "run", "clean"] },
    { name: "build standalone executable", command: [process.execPath, "run", "build:binary"] },
    {
      name: "build official Plugins",
      command: [
        process.execPath,
        join("scripts", "build-official-plugins.ts"),
        "--target",
        pluginTarget,
      ],
    },
    { name: "package release archive", command: packageCommand },
    { name: "copy release support files" },
    { name: "write checksums" },
  ];
}

export async function writeChecksums(directory: string, filenames: readonly string[]): Promise<void> {
  const lines = await Promise.all(
    [...filenames].sort().map(async (filename) => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(directory, filename))) hash.update(chunk);
      return `${hash.digest("hex")}  ${basename(filename)}`;
    }),
  );
  await writeFile(join(directory, "checksums.txt"), `${lines.join("\n")}\n`);
}

export async function runReleaseBuild(
  options: ReleaseBuildOptions = {
    version: packageJson.version,
    target: resolveReleaseTarget(process.platform, process.arch),
  },
): Promise<void> {
  const phases = releasePhases(options.target);
  const runPhase = options.runPhase ?? ((phase) => executeReleasePhase(phase, options));

  for (const phase of phases) {
    if (!options.runPhase) console.log(`==> ${phase.name}`);
    try {
      await runPhase(phase);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Release phase failed: ${phase.name}: ${detail}`, { cause: error });
      const exitCode = childExitCode(error);
      if (exitCode !== undefined) Object.assign(wrapped, { exitCode });
      throw wrapped;
    }
  }
}

async function executeReleasePhase(phase: ReleasePhase, options: ReleaseBuildOptions): Promise<void> {
  if (phase.command) {
    await runCommand(phase.command);
    return;
  }

  switch (phase.name) {
    case "validate version":
      requireBetaVersion(options.version);
      return;
    case "prepare output":
      await rm(releaseDirectory, { recursive: true, force: true });
      await mkdir(releaseDirectory, { recursive: true });
      return;
    case "copy release support files":
      await Promise.all(
        ["install.sh", "CHANGELOG.md"].map((filename) =>
          copyFile(join(repositoryRoot, filename), join(releaseDirectory, filename)),
        ),
      );
      return;
    case "write checksums":
      await writeChecksums(releaseDirectory, [options.target.archiveName, "install.sh", "CHANGELOG.md"]);
      return;
    default:
      throw new Error(`Unknown release phase: ${phase.name}`);
  }
}

async function runCommand(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd: repositoryRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw Object.assign(new Error(`${command[0]} exited with status ${exitCode}`), { exitCode });
  }
}

function childExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("exitCode" in error)) return undefined;
  return typeof error.exitCode === "number" ? error.exitCode : undefined;
}

if (import.meta.main) {
  try {
    await runReleaseBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = childExitCode(error) ?? 1;
  }
}
