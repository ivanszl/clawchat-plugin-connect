import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const read = (path: string) => readFile(path, "utf8");

test("version metadata is synchronized at beta.1", async () => {
  const pkg = await Bun.file("package.json").json();
  const source = await read("src/version.ts");
  const manifest = await Bun.file("skills/manifest.json").json();
  expect(pkg.version).toBe("0.1.0-beta.1");
  expect(source).toContain('CONNECT_VERSION = "0.1.0-beta.1"');
  expect(manifest.connectVersion).toBe("0.1.0-beta.1");
});

test("unversioned installers follow beta", async () => {
  const shell = await read("install.sh");
  const powershell = await read("install.ps1");
  for (const source of [shell, powershell]) {
    expect(source).toContain("release-channel/latest-beta.txt");
    expect(source).not.toContain("release-channel/latest-alpha.txt");
  }
});

test("shell installer bypasses the beta channel for an explicit historical version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-explicit-shell-"));
  const commandDirectory = join(directory, "commands");
  const requestsPath = join(directory, "requests.log");
  await mkdir(commandDirectory);
  const curlPath = join(commandDirectory, "curl");
  await writeFile(
    curlPath,
    [
      "#!/bin/sh",
      "url=",
      'for argument in "$@"; do',
      '  case "$argument" in http*) url="$argument" ;; esac',
      "done",
      'printf "%s\\n" "$url" >> "$CONNECT_INSTALL_REQUESTS"',
      "exit 17",
      "",
    ].join("\n"),
  );
  await chmod(curlPath, 0o755);

  const process = Bun.spawn(["sh", "install.sh", "v0.1.0-alpha.33"], {
    cwd: globalThis.process.cwd(),
    env: {
      ...globalThis.process.env,
      PATH: `${commandDirectory}${delimiter}${globalThis.process.env.PATH ?? ""}`,
      CLAWCHAT_CONNECT_INSTALL_DIR: join(directory, "install"),
      CONNECT_INSTALL_REQUESTS: requestsPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).not.toBe(0);
  const requests = await read(requestsPath);
  expect(requests).toContain("/releases/download/v0.1.0-alpha.33/clawchat-connect-");
  expect(requests).not.toContain("release-channel/latest-beta.txt");
});

test("PowerShell installer bypasses the beta channel for an explicit historical version", async () => {
  const powershell = await read("install.ps1");
  const executable = Bun.which("pwsh");
  if (!executable) {
    expect(powershell).toContain("[string]$Version");
    expect(powershell).toContain("if ([string]::IsNullOrWhiteSpace($Version)) {\n  $releaseChannelUrl =");
    expect(powershell).toContain('$baseUrl = "https://github.com/$repository/releases/download/$Version"');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-explicit-powershell-"));
  const requestsPath = join(directory, "requests.log");
  const installDirectory = join(directory, "install");
  const licenseDirectory = join(directory, "licenses");
  const command = [
    `$env:CONNECT_INSTALL_REQUESTS = '${requestsPath}'`,
    "function Invoke-WebRequest {",
    "  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)",
    "  Add-Content -LiteralPath $env:CONNECT_INSTALL_REQUESTS -Value $Uri",
    "  throw 'intentional fixture stop'",
    "}",
    `& ./install.ps1 -Version v0.1.0-alpha.33 -InstallDirectory '${installDirectory}' -LicenseDirectory '${licenseDirectory}'`,
  ].join("\n");
  const process = Bun.spawn([executable, "-NoProfile", "-Command", command], {
    cwd: globalThis.process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).not.toBe(0);
  const requests = await read(requestsPath);
  expect(requests).toContain("/releases/download/v0.1.0-alpha.33/clawchat-connect-windows-");
  expect(requests).not.toContain("release-channel/latest-beta.txt");
});

test("beta workflow publishes six archives before advancing the channel", async () => {
  const workflow = await read(".github/workflows/release-beta.yml");
  expect(workflow).toContain("v*-beta.*");
  expect(workflow).toContain("latest-beta.txt");
  const commands = workflow.split("\n").map((line) => line.trim());
  const createIndex = commands.indexOf(`gh release create "\${GITHUB_REF_NAME}" build/release/* \\`);
  expect(createIndex).toBeGreaterThan(-1);
  expect(commands.slice(createIndex + 1, createIndex + 5)).toContain("--prerelease \\");
  expect(commands).toContain(`gh release edit "\${GITHUB_REF_NAME}" --prerelease --notes-file build/release-notes.md`);
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"])
    expect(workflow).toContain(target);
  expect(workflow.indexOf("gh release")).toBeLessThan(workflow.lastIndexOf("latest-beta.txt"));
});
