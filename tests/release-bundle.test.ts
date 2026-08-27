import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installManagedSkillsFromPackage } from "../scripts/postinstall";
import { livewareAssetName } from "../src/service/liveware-control";

const PORTABLE_CORE_PLUGIN_BUNDLES = [
  "clawling.runtime.codex-0.0.0-test.connect-plugin",
  "clawling.runtime.deepseek-harness-0.0.0-test.connect-plugin",
  "clawling.runtime.opencode-0.0.0-test.connect-plugin",
  "clawling.exposure.liveware-0.0.0-test.connect-plugin",
] as const;
const WORKBUDDY_PLUGIN_BUNDLE = "clawling.runtime.workbuddy-0.0.0-test.connect-plugin";
const CONNECT_CLIENT_PLUGIN_BUNDLE = "clawling.web.connect-client-0.0.0-test.connect-plugin";
const DARWIN_CORE_PLUGIN_BUNDLES = [...PORTABLE_CORE_PLUGIN_BUNDLES, WORKBUDDY_PLUGIN_BUNDLE] as const;

async function writePluginFixtures(directory: string, bundles: readonly string[], content = "official Plugin Bundle\n") {
  await Promise.all(bundles.map(async (name) => await writeFile(join(directory, name), content)));
}

async function archiveEntries(archive: string): Promise<string[]> {
  const listing = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    listing.exited,
    new Response(listing.stdout).text(),
    new Response(listing.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim().split("\n").sort();
}

async function packagePosix(
  connectBinary: string,
  officialPluginsDirectory: string,
  archive: string,
  target: "darwin-arm64" | "darwin-x64" | "linux-x64",
): Promise<number> {
  return await Bun.spawn(
    [
      "sh",
      "scripts/package-release-archive.sh",
      connectBinary,
      officialPluginsDirectory,
      archive,
      target,
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  ).exited;
}

async function fixtureRelease(
  directory: string,
  bundles: readonly string[],
): Promise<{ archive: string; connectBinary: string; officialPluginsDirectory: string }> {
  const connectBinary = join(directory, "clawchat-connect");
  const officialPluginsDirectory = join(directory, "official-plugins");
  const archive = join(directory, "release.tar.gz");
  await mkdir(officialPluginsDirectory, { recursive: true });
  await writeFile(
    connectBinary,
    '#!/bin/sh\n[ "${1:-}" = --help ] || [ "${1:-}" = skills ]\n',
  );
  await chmod(connectBinary, 0o755);
  await writePluginFixtures(officialPluginsDirectory, bundles);
  return { archive, connectBinary, officialPluginsDirectory };
}

describe("standalone release bundle", () => {
  it("keeps archive implementations in parity without an unconditional browser payload", async () => {
    const [posix, windowsShell, windowsPowerShell] = await Promise.all([
      readFile("scripts/package-release-archive.sh", "utf8"),
      readFile("scripts/package-windows-release.sh", "utf8"),
      readFile("scripts/package-windows-release.ps1", "utf8"),
    ]);
    for (const source of [posix, windowsShell, windowsPowerShell]) {
      expect(source).toContain("official-plugins");
      expect(source).toContain("skills");
      expect(source).toContain("CHANGELOG.md");
      expect(source).toContain("LICENSE");
      expect(source).not.toContain("clawchat-connect-client");
      expect(source).not.toContain("dist/client");
    }
    expect(posix).toContain("clawling.runtime.workbuddy");
    expect(windowsShell).not.toContain("clawling.runtime.workbuddy");
    expect(windowsPowerShell).not.toContain("clawling.runtime.workbuddy");
    for (const source of [posix, windowsShell, windowsPowerShell]) {
      expect(source).toContain("clawling.runtime.deepseek-harness");
      expect(source).toContain("clawling.runtime.opencode");
      expect(source).toContain("clawling.exposure.liveware");
      expect(source).not.toContain("clawling.web.connect-client");
    }
  });

  it("packages a complete optional Connect Client Plugin when present and remains valid when omitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-release-optional-client-"));
    const withClient = await fixtureRelease(directory, [...DARWIN_CORE_PLUGIN_BUNDLES, CONNECT_CLIENT_PLUGIN_BUNDLE]);
    await writeFile(
      join(withClient.officialPluginsDirectory, CONNECT_CLIENT_PLUGIN_BUNDLE),
      JSON.stringify({ files: { "client/index.html": "complete", "client-assets.json": "integrity-covered" } }),
    );
    expect(
      await packagePosix(withClient.connectBinary, withClient.officialPluginsDirectory, withClient.archive, "darwin-arm64"),
    ).toBe(0);
    const includedEntries = await archiveEntries(withClient.archive);
    expect(includedEntries).toContain(`official-plugins/${CONNECT_CLIENT_PLUGIN_BUNDLE}`);
    expect(includedEntries.some((entry) => entry.startsWith("clawchat-connect-client"))).toBe(false);

    const withoutClientDirectory = await mkdtemp(join(tmpdir(), "connect-release-headless-"));
    const withoutClient = await fixtureRelease(withoutClientDirectory, DARWIN_CORE_PLUGIN_BUNDLES);
    expect(
      await packagePosix(
        withoutClient.connectBinary,
        withoutClient.officialPluginsDirectory,
        withoutClient.archive,
        "darwin-arm64",
      ),
    ).toBe(0);
    const omittedEntries = await archiveEntries(withoutClient.archive);
    expect(omittedEntries.some((entry) => entry.includes("clawling.web.connect-client"))).toBe(false);
    expect(omittedEntries.some((entry) => entry.startsWith("clawchat-connect-client"))).toBe(false);
    expect(omittedEntries).toContain("clawchat-connect");
  });

  it("requires WorkBuddy only for Darwin archives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-release-targets-"));
    const fixture = await fixtureRelease(directory, PORTABLE_CORE_PLUGIN_BUNDLES);
    expect(
      await packagePosix(fixture.connectBinary, fixture.officialPluginsDirectory, fixture.archive, "linux-x64"),
    ).toBe(0);
    expect(
      await packagePosix(
        fixture.connectBinary,
        fixture.officialPluginsDirectory,
        join(directory, "darwin-missing.tar.gz"),
        "darwin-x64",
      ),
    ).not.toBe(0);
  });

  it("installs a headless archive, enforces its checksum, and removes obsolete root browser payloads", async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    const directory = await mkdtemp(join(tmpdir(), "connect-install-headless-"));
    const source = await fixtureRelease(join(directory, "source"), DARWIN_CORE_PLUGIN_BUNDLES);
    const fixtureDirectory = join(directory, "downloads");
    const commandDirectory = join(directory, "commands");
    const installDirectory = join(directory, "installed");
    await Promise.all([
      mkdir(fixtureDirectory, { recursive: true }),
      mkdir(commandDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true }),
    ]);
    const asset = "clawchat-connect-darwin-arm64.tar.gz";
    const archive = join(fixtureDirectory, asset);
    expect(
      await packagePosix(source.connectBinary, source.officialPluginsDirectory, archive, "darwin-arm64"),
    ).toBe(0);
    await Promise.all([
      writeFile(join(installDirectory, "clawchat-connect-client"), "obsolete browser payload\n"),
      writeFile(join(installDirectory, "liveware"), "obsolete companion\n"),
      writeFile(join(fixtureDirectory, "latest-beta.txt"), "v0.1.0-beta.12\n"),
    ]);
    const curlPath = join(commandDirectory, "curl");
    await writeFile(
      curlPath,
      [
        "#!/bin/sh",
        "output=",
        "url=",
        "while [ \"$#\" -gt 0 ]; do",
        "  case \"$1\" in",
        "    --output) output=\"$2\"; shift 2 ;;",
        "    http*) url=\"$1\"; shift ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        "case \"$url\" in",
        "  *release-channel/latest-beta.txt) cat \"$CONNECT_INSTALL_FIXTURES/latest-beta.txt\" ;;",
        "  *) cp \"$CONNECT_INSTALL_FIXTURES/${url##*/}\" \"$output\" ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(curlPath, 0o755);
    const environment = {
      ...process.env,
      PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
      CLAWCHAT_CONNECT_INSTALL_DIR: installDirectory,
      CLAWCHAT_CONNECT_LICENSE_DIR: join(installDirectory, "licenses"),
      CONNECT_INSTALL_FIXTURES: fixtureDirectory,
    };

    await writeFile(join(fixtureDirectory, "checksums.txt"), `${"0".repeat(64)}  ${asset}\n`);
    const rejected = Bun.spawn(["sh", "install.sh"], { cwd: process.cwd(), env: environment, stdout: "pipe", stderr: "pipe" });
    expect(await rejected.exited).not.toBe(0);
    await expect(readFile(join(installDirectory, "clawchat-connect-client"), "utf8")).resolves.toContain("obsolete");

    const checksumProcess = Bun.spawn(["shasum", "-a", "256", archive], { stdout: "pipe" });
    const checksum = (await new Response(checksumProcess.stdout).text()).split(/\s+/u)[0];
    expect(await checksumProcess.exited).toBe(0);
    await writeFile(join(fixtureDirectory, "checksums.txt"), `${checksum}  ${asset}\n`);
    const installed = Bun.spawn(["sh", "install.sh"], { cwd: process.cwd(), env: environment, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([installed.exited, new Response(installed.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(await Bun.file(join(installDirectory, "clawchat-connect-client")).exists()).toBe(false);
    expect(await Bun.file(join(installDirectory, "liveware")).exists()).toBe(false);
    await expect(readdir(join(installDirectory, "official-plugins")).then((entries) => entries.sort())).resolves.toEqual(
      [...DARWIN_CORE_PLUGIN_BUNDLES].sort(),
    );
  });

  it("keeps npm Core free of a browser root and makes Client installation explicit", async () => {
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(packageManifest.files).toContain("dist/official-plugins");
    expect(packageManifest.files).not.toContain("dist/client");
    expect(packageManifest.scripts.build).not.toContain("build:web");
    expect(packageManifest.scripts.build).toContain("build-official-plugins.ts");

    const [posixInstaller, windowsInstaller] = await Promise.all([
      readFile("install.sh", "utf8"),
      readFile("install.ps1", "utf8"),
    ]);
    for (const installer of [posixInstaller, windowsInstaller]) {
      expect(installer).not.toContain("Installed Connect Client assets");
      expect(installer).not.toMatch(/plugin setup[^\n]+clawling\.web\.connect-client/u);
      expect(installer).toContain("official-plugins");
    }
    expect(posixInstaller).toContain("checksum verification failed");
    expect(windowsInstaller).toContain("Checksum verification failed");
  });

  it("retains verified Liveware inputs for deferred target tooling", async () => {
    expect([
      livewareAssetName("darwin", "arm64"),
      livewareAssetName("darwin", "x64"),
      livewareAssetName("linux", "arm64"),
      livewareAssetName("linux", "x64"),
      livewareAssetName("win32", "arm64"),
      livewareAssetName("win32", "x64"),
    ]).toEqual([
      "liveware-darwin-arm64",
      "liveware-darwin-amd64",
      "liveware-linux-arm64",
      "liveware-linux-amd64",
      "liveware-windows-arm64.exe",
      "liveware-windows-amd64.exe",
    ]);
    const checksums = await readFile("vendor/liveware/SHA256SUMS", "utf8");
    for (const asset of [
      "liveware-darwin-arm64",
      "liveware-darwin-amd64",
      "liveware-linux-arm64",
      "liveware-linux-amd64",
      "liveware-windows-arm64.exe",
      "liveware-windows-amd64.exe",
    ]) {
      expect(checksums).toMatch(new RegExp(`^[a-f0-9]{64}  ${asset}$`, "mu"));
    }
  });

  it("keeps the current beta workflow deterministic and Darwin-only", async () => {
    const workflow = await readFile(".github/workflows/release-beta.yml", "utf8");
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).toContain("run: bun run build:release");
    expect(workflow).not.toMatch(/windows-smoke|bun-windows|bun-linux|darwin-x64/iu);
  });

  it("skips managed Skill installation when a source checkout has not been built", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-postinstall-"));
    expect(installManagedSkillsFromPackage(join(directory, "dist", "src", "bin.js"))).toBe(0);
  });
});
