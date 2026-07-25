import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livewareAssetName } from "../src/liveware-exposure";

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
      ].sort(),
    );
  });

  it("ships a checksum-verifying PowerShell installer and Windows release targets", async () => {
    const installer = await readFile("install.ps1", "utf8");
    expect(installer).toContain("Get-FileHash");
    expect(installer).toContain("Expand-Archive");
    expect(installer).toContain("clawchat-connect.exe");
    expect(installer).toContain("liveware.exe");
    expect(installer).toContain("CHANGELOG.md");
    expect(installer).toContain('service", "stop');
    const workflow = await readFile(".github/workflows/release-alpha.yml", "utf8");
    expect(workflow).toContain("bun-windows-x64 windows x64");
    expect(workflow).toContain("bun-windows-arm64 windows arm64");
    expect(workflow).toContain("install.ps1");
    expect(workflow).toContain("--notes-file build/release-notes.md");
  });

  it("uses vendored, verified Liveware assets for npm packages and local compiled builds", async () => {
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(packageManifest.files).toContain("vendor/liveware");
    expect(packageManifest.scripts.prepack).toContain("verify-liveware-bundle.ts");
    expect(packageManifest.scripts["build:binary"]).toContain("build-binary.ts");
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
      writeFile(connectBinary, '#!/bin/sh\n[ "$' + '{1:-}" = --help ]\n'),
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
        'cp "$CONNECT_INSTALL_FIXTURES/$' + '{url##*/}" "$output"',
        "",
      ].join("\n"),
    );
    await chmod(curlPath, 0o755);

    const installProcess = Bun.spawn(["sh", "install.sh", "v0.1.0-alpha.6"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
        CLAWCHAT_CONNECT_INSTALL_DIR: installDirectory,
        CLAWCHAT_CONNECT_LICENSE_DIR: join(installDirectory, "licenses"),
        CONNECT_INSTALL_FIXTURES: fixtureDirectory,
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
    await expect(readFile(join(installDirectory, "licenses", "CHANGELOG.md"), "utf8")).resolves.toContain(
      "# Changelog",
    );
  });
});
