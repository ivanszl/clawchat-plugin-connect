import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installManagedSkillsFromPackage } from "../scripts/postinstall";
import { livewareAssetName } from "../src/liveware-exposure";
import { CONNECT_VERSION } from "../src/version";

describe("standalone release bundle", () => {
  it("packages the Connect executable, Client assets, and pinned Liveware executable together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-release-"));
    const connectBinary = join(directory, "connect");
    const livewareBinary = join(directory, "liveware-source");
    const clientDirectory = join(directory, "client");
    const archive = join(directory, "clawchat-connect-darwin-arm64.tar.gz");
    await mkdir(clientDirectory);
    await writeFile(connectBinary, "#!/bin/sh\nexit 0\n");
    await writeFile(livewareBinary, "#!/bin/sh\nexit 0\n");
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n");
    await Promise.all([chmod(connectBinary, 0o755), chmod(livewareBinary, 0o755)]);

    const child = Bun.spawn(
      ["sh", "scripts/package-release-archive.sh", connectBinary, clientDirectory, livewareBinary, archive],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);

    const listing = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
    const [tarExitCode, stdout] = await Promise.all([listing.exited, new Response(listing.stdout).text()]);
    expect(tarExitCode).toBe(0);
    expect(stdout.trim().split("\n").sort()).toEqual(
      [
        "CHANGELOG.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "clawchat-connect",
        "clawchat-connect-client/",
        "clawchat-connect-client/index.html",
        "liveware",
        "skills/",
        "skills/clawchat-core/",
        "skills/clawchat-core/SKILL.md",
        "skills/clawchat-core/agents/",
        "skills/clawchat-core/agents/openai.yaml",
        "skills/clawchat-core/references/",
        "skills/clawchat-core/references/tools.md",
        "skills/clawchat-liveware/",
        "skills/clawchat-liveware/SKILL.md",
        "skills/clawchat-liveware/agents/",
        "skills/clawchat-liveware/agents/openai.yaml",
        "skills/clawchat-liveware/references/",
        "skills/clawchat-liveware/references/commands.md",
        "skills/manifest.json",
      ].sort(),
    );
  });

  it("pins a Liveware release asset for every standalone Connect target", async () => {
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
    expect((await readFile("vendor/liveware/VERSION", "utf8")).trim()).toBe("v0.0.16");
  });

  it("packages a Windows executable, Client assets, and Liveware executable into one ZIP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-windows-release-"));
    const connectBinary = join(directory, "clawchat-connect.exe");
    const livewareBinary = join(directory, "liveware-source.exe");
    const clientDirectory = join(directory, "client");
    const archive = join(directory, "clawchat-connect-windows-x64.zip");
    await mkdir(clientDirectory);
    await writeFile(connectBinary, "connect executable");
    await writeFile(livewareBinary, "liveware executable");
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n");

    const child = Bun.spawn(
      ["sh", "scripts/package-windows-release.sh", connectBinary, clientDirectory, livewareBinary, archive],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);

    const listing = Bun.spawn(["unzip", "-Z1", archive], { stdout: "pipe", stderr: "pipe" });
    const [zipExitCode, stdout] = await Promise.all([listing.exited, new Response(listing.stdout).text()]);
    expect(zipExitCode).toBe(0);
    expect(stdout.trim().split("\n").sort()).toEqual(
      [
        "CHANGELOG.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "clawchat-connect-client/",
        "clawchat-connect-client/index.html",
        "clawchat-connect.exe",
        "liveware.exe",
        "skills/",
        "skills/clawchat-core/",
        "skills/clawchat-core/SKILL.md",
        "skills/clawchat-core/agents/",
        "skills/clawchat-core/agents/openai.yaml",
        "skills/clawchat-core/references/",
        "skills/clawchat-core/references/tools.md",
        "skills/clawchat-liveware/",
        "skills/clawchat-liveware/SKILL.md",
        "skills/clawchat-liveware/agents/",
        "skills/clawchat-liveware/agents/openai.yaml",
        "skills/clawchat-liveware/references/",
        "skills/clawchat-liveware/references/commands.md",
        "skills/manifest.json",
      ].sort(),
    );
  });

  it("ships a checksum-verifying PowerShell installer and Windows release targets", async () => {
    const installer = await readFile("install.ps1", "utf8");
    expect(installer).toContain("raw.githubusercontent.com/$repository/release-channel/latest-alpha.txt");
    expect(installer).not.toContain("api.github.com");
    expect(installer).toContain("Get-FileHash");
    expect(installer).toContain("Expand-Archive");
    expect(installer).toContain("clawchat-connect.exe");
    expect(installer).toContain("liveware.exe");
    expect(installer).toContain("CHANGELOG.md");
    expect(installer).toContain('service", "stop');
    expect(installer).toContain("$transactionStarted");
    expect(installer).toContain("if ($transactionStarted -and -not $transactionCommitted)");
    const workflow = await readFile(".github/workflows/release-alpha.yml", "utf8");
    expect(workflow).toContain("bun-windows-x64 windows x64");
    expect(workflow).toContain("bun-windows-arm64 windows arm64");
    expect(workflow).toContain("bun-linux-x64-baseline linux x64");
    expect(workflow).not.toMatch(/^\s*bun-linux-x64 linux x64$/mu);
    expect(workflow).toContain("install.ps1");
    expect(workflow).toContain("--notes-file build/release-notes.md");
    expect(workflow).toContain("release-channel");
    expect(workflow).toContain("latest-alpha.txt");
  });

  it("uses vendored, verified Liveware assets for npm packages and local compiled builds", async () => {
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(packageManifest.files).toContain("vendor/liveware");
    expect(packageManifest.files).toContain("scripts/postinstall.ts");
    expect(packageManifest.scripts.prepack).toContain("verify-liveware-bundle.ts");
    expect(packageManifest.scripts["build:binary"]).toContain("build-binary.ts");
    expect(packageManifest.scripts.postinstall).toBe("bun scripts/postinstall.ts");
  });

  it("skips managed Skill installation when a source checkout has not been built", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-postinstall-"));
    expect(installManagedSkillsFromPackage(join(directory, "dist", "src", "bin.js"))).toBe(0);
  });

  it("installs Connect Client and its Liveware companion as sibling executables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-install-"));
    const sourceDirectory = join(directory, "source");
    const clientDirectory = join(sourceDirectory, "client");
    const fixtureDirectory = join(directory, "fixtures");
    const commandDirectory = join(directory, "commands");
    const installDirectory = join(directory, "installed");
    const asset =
      process.platform === "darwin"
        ? `clawchat-connect-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`
        : `clawchat-connect-linux-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
    const archive = join(fixtureDirectory, asset);
    await Promise.all([
      mkdir(clientDirectory, { recursive: true }),
      mkdir(fixtureDirectory, { recursive: true }),
      mkdir(commandDirectory, { recursive: true }),
    ]);
    const connectBinary = join(sourceDirectory, "clawchat-connect");
    const livewareBinary = join(sourceDirectory, "liveware");
    await Promise.all([
      writeFile(connectBinary, '#!/bin/sh\n[ "$' + '{1:-}" = --help ] || [ "$' + '{1:-}" = skills ]\n'),
      writeFile(livewareBinary, '#!/bin/sh\n[ "$' + '{1:-}" = --help ]\n'),
      writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n"),
    ]);
    await Promise.all([chmod(connectBinary, 0o755), chmod(livewareBinary, 0o755)]);

    const packageProcess = Bun.spawn(
      ["sh", "scripts/package-release-archive.sh", connectBinary, clientDirectory, livewareBinary, archive],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await packageProcess.exited).toBe(0);
    const checksumProcess = Bun.spawn(["shasum", "-a", "256", archive], { stdout: "pipe" });
    const checksum = (await new Response(checksumProcess.stdout).text()).split(/\s+/u)[0];
    expect(await checksumProcess.exited).toBe(0);
    await writeFile(join(fixtureDirectory, "checksums.txt"), `${checksum}  ${asset}\n`);
    await writeFile(join(fixtureDirectory, "latest-alpha.txt"), "v0.1.0-alpha.12\n");
    const curlPath = join(commandDirectory, "curl");
    await writeFile(
      curlPath,
      [
        "#!/bin/sh",
        "output=",
        "url=",
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    http*) url="$1"; shift ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'case "$url" in',
        "  *release-channel/latest-alpha.txt)",
        '    if [ -n "$output" ]; then',
        '      cp "$CONNECT_INSTALL_FIXTURES/latest-alpha.txt" "$output"',
        "    else",
        '      cat "$CONNECT_INSTALL_FIXTURES/latest-alpha.txt"',
        "    fi",
        "    ;;",
        '  *) cp "$CONNECT_INSTALL_FIXTURES/$' + '{url##*/}" "$output" ;;',
        "esac",
        'printf "%s\\n" "$url" >> "$CONNECT_INSTALL_REQUESTS"',
        "",
      ].join("\n"),
    );
    await chmod(curlPath, 0o755);

    const requestsPath = join(directory, "requests.log");
    const installProcess = Bun.spawn(["sh", "install.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
        CLAWCHAT_CONNECT_INSTALL_DIR: installDirectory,
        CLAWCHAT_CONNECT_LICENSE_DIR: join(installDirectory, "licenses"),
        CONNECT_INSTALL_FIXTURES: fixtureDirectory,
        CONNECT_INSTALL_REQUESTS: requestsPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([installProcess.exited, new Response(installProcess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    await expect(readFile(join(installDirectory, "clawchat-connect"), "utf8")).resolves.toContain("--help");
    await expect(readFile(join(installDirectory, "liveware"), "utf8")).resolves.toContain("--help");
    await expect(readFile(join(installDirectory, "clawchat-connect-client", "index.html"), "utf8")).resolves.toContain(
      "<!doctype html>",
    );
    await expect(readFile(join(installDirectory, "skills", "manifest.json"), "utf8")).resolves.toContain(
      CONNECT_VERSION,
    );
    await expect(readFile(join(installDirectory, "licenses", "CHANGELOG.md"), "utf8")).resolves.toContain(
      "# Changelog",
    );
    await expect(readFile(requestsPath, "utf8")).resolves.toContain(
      "/releases/download/v0.1.0-alpha.12/clawchat-connect-",
    );
    const requests = await readFile(requestsPath, "utf8");
    expect(requests).toContain("/release-channel/latest-alpha.txt");
    expect(requests).not.toContain("api.github.com");

    const installedConnectBeforeFailure = await readFile(join(installDirectory, "clawchat-connect"), "utf8");
    await writeFile(
      connectBinary,
      [
        "#!/bin/sh",
        '[ "$' + '{1:-}" = --help ] && exit 0',
        'if [ "$' + '{1:-}" = skills ] && [ "$' + '{2:-}" = preflight ]; then',
        '  if grep -q "mkdir -p" "$CLAWCHAT_CONNECT_INSTALL_DIR/clawchat-connect"; then',
        '    printf "replaced\\n" > "$CONNECT_PREFLIGHT_OBSERVATION"',
        "  else",
        '    printf "old\\n" > "$CONNECT_PREFLIGHT_OBSERVATION"',
        "  fi",
        '  mkdir -p "$HOME/.agents/skills" || exit 17',
        "  exit 0",
        "fi",
        '[ "$' + '{1:-}" = skills ] && [ "$' + '{2:-}" = install ] && exit 0',
        "exit 1",
        "",
      ].join("\n"),
    );
    await chmod(connectBinary, 0o755);
    const failingPackage = Bun.spawn(
      ["sh", "scripts/package-release-archive.sh", connectBinary, clientDirectory, livewareBinary, archive],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await failingPackage.exited).toBe(0);
    const failingChecksumProcess = Bun.spawn(["shasum", "-a", "256", archive], { stdout: "pipe" });
    const failingChecksum = (await new Response(failingChecksumProcess.stdout).text()).split(/\s+/u)[0];
    expect(await failingChecksumProcess.exited).toBe(0);
    await writeFile(join(fixtureDirectory, "checksums.txt"), `${failingChecksum}  ${asset}\n`);
    const invalidSkillHome = join(directory, "invalid-skill-home");
    await writeFile(invalidSkillHome, "not a directory");
    const preflightObservation = join(directory, "preflight-observation.txt");

    const failedInstall = Bun.spawn(["sh", "install.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
        CLAWCHAT_CONNECT_INSTALL_DIR: installDirectory,
        CLAWCHAT_CONNECT_LICENSE_DIR: join(installDirectory, "licenses"),
        CONNECT_INSTALL_FIXTURES: fixtureDirectory,
        CONNECT_INSTALL_REQUESTS: requestsPath,
        CONNECT_PREFLIGHT_OBSERVATION: preflightObservation,
        HOME: invalidSkillHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await failedInstall.exited).not.toBe(0);
    await expect(readFile(preflightObservation, "utf8")).resolves.toBe("old\n");
    await expect(readFile(join(installDirectory, "clawchat-connect"), "utf8")).resolves.toBe(
      installedConnectBeforeFailure,
    );
    await expect(readFile(join(installDirectory, "clawchat-connect-client", "index.html"), "utf8")).resolves.toContain(
      "<!doctype html>",
    );
  });
});
