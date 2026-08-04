import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(path, "utf8");

test("version metadata is synchronized at beta.1", async () => {
  const pkg = await Bun.file("package.json").json();
  const source = await read("src/version.ts");
  const manifest = await Bun.file("skills/manifest.json").json();
  expect(pkg.version).toBe("0.1.0-beta.1");
  expect(source).toContain('CONNECT_VERSION = "0.1.0-beta.1"');
  expect(manifest.connectVersion).toBe("0.1.0-beta.1");
});

test("unversioned installers follow beta while explicit versions remain accepted", async () => {
  const shell = await read("install.sh");
  const powershell = await read("install.ps1");
  for (const source of [shell, powershell]) {
    expect(source).toContain("release-channel/latest-beta.txt");
    expect(source).not.toContain("release-channel/latest-alpha.txt");
  }
  expect(shell).toMatch(/version=.*\$\{1/);
  expect(powershell).toMatch(/\[string\]\$Version/);
});

test("beta workflow publishes six archives before advancing the channel", async () => {
  const workflow = await read(".github/workflows/release-beta.yml");
  expect(workflow).toContain("v*-beta.*");
  expect(workflow).toContain("latest-beta.txt");
  expect(workflow).toContain("prerelease: true");
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"])
    expect(workflow).toContain(target);
  expect(workflow.indexOf("gh release")).toBeLessThan(workflow.lastIndexOf("latest-beta.txt"));
});
