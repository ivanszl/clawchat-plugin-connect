import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  releasePayload,
  releasePhases,
  requireBetaVersion,
  resolveReleaseTarget,
  runReleaseBuild,
  writeChecksums,
} from "../scripts/build-release";

describe("requireBetaVersion", () => {
  test.each(["0.1.0-beta.1", "12.34.56-beta.9"])("accepts %s", (version) => {
    expect(requireBetaVersion(version)).toBe(version);
  });

  test.each(["0.1.0-alpha.33", "0.1.0-beta.0", "0.1.0-beta.-1", "0.1.0-beta.01", "v0.1.0-beta.1", "0.1.0"])(
    "rejects %s",
    (version) => {
      expect(() => requireBetaVersion(version)).toThrow("beta release version");
    },
  );
});

describe("resolveReleaseTarget", () => {
  test("maps Apple silicon", () => {
    expect(resolveReleaseTarget("darwin", "arm64")).toMatchObject({
      platform: "darwin",
      architecture: "arm64",
      archiveName: "clawchat-connect-darwin-arm64.tar.gz",
      connectExecutable: "clawchat-connect",
    });
  });

  test.each([
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
  ] as const)("rejects deferred release host %s/%s", (platform, architecture) => {
    expect(() => resolveReleaseTarget(platform, architecture)).toThrow(
      "Current beta releases support only darwin/arm64",
    );
  });

  test("rejects unknown hosts", () => {
    expect(() => resolveReleaseTarget("freebsd", "x64")).toThrow("Current beta releases support only darwin/arm64");
  });
});

test("release payload is complete", () => {
  const target = resolveReleaseTarget("darwin", "arm64");
  expect(releasePayload(target).entries).toEqual([
    "clawchat-connect",
    "clawchat-connect-client",
    "official-plugins",
    "skills",
    "CHANGELOG.md",
    "LICENSE",
  ]);
});

test("release phases validate before mutating output and package last", () => {
  const phases = releasePhases(resolveReleaseTarget("darwin", "arm64"));
  expect(phases.map(({ name }) => name)).toEqual([
    "validate version",
    "prepare output",
    "release checks",
    "verify Liveware bundle",
    "clean distributable",
    "build standalone executable",
    "build official Plugins",
    "package release archive",
    "copy release support files",
    "write checksums",
  ]);
});

test("builds the Darwin arm64 official Plugin payload", () => {
  const phases = releasePhases(resolveReleaseTarget("darwin", "arm64"));
  const buildPhase = phases.find((candidate) => candidate.name === "build official Plugins");
  const packagePhase = phases.find((candidate) => candidate.name === "package release archive");
  expect(buildPhase?.command).toEqual([
    process.execPath,
    join("scripts", "build-official-plugins.ts"),
    "--target",
    "darwin-arm64",
  ]);
  expect(packagePhase?.command?.at(-1)).toBe("darwin-arm64");
});

test("checksums cover the archive and copied support files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-release-"));
  const files = ["artifact.tar.gz", "install.sh", "CHANGELOG.md"];
  for (const filename of files) await writeFile(join(directory, filename), filename);
  await writeChecksums(directory, files);
  const manifest = await readFile(join(directory, "checksums.txt"), "utf8");
  for (const filename of files) expect(manifest).toContain(`  ${filename}\n`);
  expect(manifest.trim().split("\n")).toEqual([
    expect.stringMatching(/^[a-f0-9]{64} {2}CHANGELOG\.md$/u),
    expect.stringMatching(/^[a-f0-9]{64} {2}artifact\.tar\.gz$/u),
    expect.stringMatching(/^[a-f0-9]{64} {2}install\.sh$/u),
  ]);
  expect(manifest).not.toContain("checksums.txt");
});

test("a failed phase keeps its name and exit status", async () => {
  const failure = Object.assign(new Error("child failed"), { exitCode: 17 });
  await expect(
    runReleaseBuild({
      version: "0.1.0-beta.1",
      target: resolveReleaseTarget("darwin", "arm64"),
      runPhase: async (phase) => {
        if (phase.name === "release checks") throw failure;
      },
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining("release checks"), exitCode: 17 });
});
