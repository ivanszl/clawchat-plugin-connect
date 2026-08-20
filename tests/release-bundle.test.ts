import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installManagedSkillsFromPackage } from "../scripts/postinstall";
import { livewareAssetName } from "../src/service/liveware-control";
import { CONNECT_VERSION } from "../src/service/version";

const PORTABLE_OFFICIAL_PLUGIN_BUNDLES = [
  "clawling.runtime.codex-0.0.0-test.connect-plugin",
  "clawling.runtime.deepseek-harness-0.0.0-test.connect-plugin",
  "clawling.runtime.opencode-0.0.0-test.connect-plugin",
  "clawling.exposure.liveware-0.0.0-test.connect-plugin",
] as const;
const WORKBUDDY_OFFICIAL_PLUGIN_BUNDLE = "clawling.runtime.workbuddy-0.0.0-test.connect-plugin" as const;
const DARWIN_OFFICIAL_PLUGIN_BUNDLES = [...PORTABLE_OFFICIAL_PLUGIN_BUNDLES, WORKBUDDY_OFFICIAL_PLUGIN_BUNDLE] as const;

async function writeOfficialPluginFixtures(
  directory: string,
  bundles: readonly string[],
  content = "official Plugin Bundle\n",
): Promise<void> {
  await Promise.all(bundles.map(async (name) => await writeFile(join(directory, name), content)));
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(join(directory, entry.name), relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

describe("standalone release bundle", () => {
  it("runs the native Windows packaging test in the Windows smoke job", async () => {
    const workflow = Bun.YAML.parse(await readFile(".github/workflows/release-beta.yml", "utf8")) as {
      jobs: { "windows-smoke": { steps: Array<{ name?: string; run?: string }> } };
    };
    const verification = workflow.jobs["windows-smoke"].steps.find(
      ({ name }) => name === "Verify Windows service behavior and bundled assets",
    );
    expect(verification?.run?.split("\n").map((line) => line.trim())).toContain(
      'bun test tests/release-bundle.test.ts --test-name-pattern "native Windows packager creates the exact archive-root payload"',
    );
  });

  it("keeps POSIX and native Windows package payloads in parity", async () => {
    const logicalPayload = [
      "clawchat-connect",
      "clawchat-connect-client",
      "official-plugins",
      "skills",
      "CHANGELOG.md",
      "LICENSE",
    ];
    const posixPackager = await readFile("scripts/package-release-archive.sh", "utf8");
    const windowsPackager = await readFile("scripts/package-windows-release.ps1", "utf8");
    for (const entry of logicalPayload) {
      expect(posixPackager.toLowerCase()).toContain(entry.toLowerCase());
      expect(windowsPackager.toLowerCase()).toContain(entry.toLowerCase());
    }
    expect(posixPackager).toContain("darwin-arm64 | darwin-x64");
    expect(posixPackager).toContain("linux-arm64 | linux-x64");
    expect(windowsPackager).not.toContain("clawling.runtime.workbuddy");
    expect(windowsPackager).toContain("clawling.runtime.deepseek-harness");
    expect(posixPackager).toContain("clawling.exposure.liveware");
    expect(windowsPackager).toContain("clawling.exposure.liveware");
  });

  it("native Windows packager creates the exact archive-root payload", async () => {
    if (process.platform !== "win32") return;

    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-native-windows-release-"));
    const connectBinary = join(directory, "clawchat-connect.exe");
    const clientDirectory = join(directory, "client");
    const officialPluginsDirectory = join(directory, "official-plugins");
    const archive = join(directory, "clawchat-connect-windows-x64.zip");
    const extractedDirectory = join(directory, "extracted");
    await Promise.all([
      mkdir(clientDirectory, { recursive: true }),
      mkdir(officialPluginsDirectory, { recursive: true }),
    ]);
    await writeFile(connectBinary, "connect executable");
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n");
    await writeOfficialPluginFixtures(officialPluginsDirectory, PORTABLE_OFFICIAL_PLUGIN_BUNDLES);

    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/package-windows-release.ps1",
        connectBinary,
        clientDirectory,
        officialPluginsDirectory,
        archive,
        "win32-x64",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);

    const extraction = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "Expand-Archive -LiteralPath $env:CONNECT_RELEASE_ARCHIVE -DestinationPath $env:CONNECT_RELEASE_EXTRACTED",
      ],
      {
        env: {
          ...process.env,
          CONNECT_RELEASE_ARCHIVE: archive,
          CONNECT_RELEASE_EXTRACTED: extractedDirectory,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [extractionExitCode, extractionStderr] = await Promise.all([
      extraction.exited,
      new Response(extraction.stderr).text(),
    ]);
    expect(extractionExitCode, extractionStderr).toBe(0);
    expect(await listFiles(extractedDirectory)).toEqual(
      [
        "CHANGELOG.md",
        "LICENSE",
        "clawchat-connect-client/index.html",
        "clawchat-connect.exe",
        ...PORTABLE_OFFICIAL_PLUGIN_BUNDLES.map((name) => `official-plugins/${name}`),
        "skills/clawchat-core/SKILL.md",
        "skills/clawchat-core/agents/openai.yaml",
        "skills/clawchat-core/references/tools.md",
        "skills/clawchat-liveware/SKILL.md",
        "skills/clawchat-liveware/agents/openai.yaml",
        "skills/clawchat-liveware/references/commands.md",
        "skills/manifest.json",
      ].sort(),
    );

    const payloadSources = new Map<string, string>([
      ["clawchat-connect.exe", connectBinary],
      ["clawchat-connect-client/index.html", join(clientDirectory, "index.html")],
      ...PORTABLE_OFFICIAL_PLUGIN_BUNDLES.map(
        (name) => [`official-plugins/${name}`, join(officialPluginsDirectory, name)] as const,
      ),
      ["CHANGELOG.md", "CHANGELOG.md"],
      ["LICENSE", "LICENSE"],
      ["skills/clawchat-core/SKILL.md", "skills/clawchat-core/SKILL.md"],
      ["skills/clawchat-core/agents/openai.yaml", "skills/clawchat-core/agents/openai.yaml"],
      ["skills/clawchat-core/references/tools.md", "skills/clawchat-core/references/tools.md"],
      ["skills/clawchat-liveware/SKILL.md", "skills/clawchat-liveware/SKILL.md"],
      ["skills/clawchat-liveware/agents/openai.yaml", "skills/clawchat-liveware/agents/openai.yaml"],
      ["skills/clawchat-liveware/references/commands.md", "skills/clawchat-liveware/references/commands.md"],
      ["skills/manifest.json", "skills/manifest.json"],
    ]);
    for (const [entry, source] of payloadSources) {
      expect(await readFile(join(extractedDirectory, ...entry.split("/")))).toEqual(await readFile(source));
    }
  }, 30_000);

  it("packages the Connect executable, Client assets, and official Plugin Bundles without a root companion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-release-"));
    const connectBinary = join(directory, "connect");
    const clientDirectory = join(directory, "client");
    const officialPluginsDirectory = join(directory, "official-plugins");
    const archive = join(directory, "clawchat-connect-darwin-arm64.tar.gz");
    await Promise.all([mkdir(clientDirectory), mkdir(officialPluginsDirectory)]);
    await writeFile(connectBinary, "#!/bin/sh\nexit 0\n");
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n");
    await writeOfficialPluginFixtures(officialPluginsDirectory, DARWIN_OFFICIAL_PLUGIN_BUNDLES);
    await chmod(connectBinary, 0o755);

    const child = Bun.spawn(
      [
        "sh",
        "scripts/package-release-archive.sh",
        connectBinary,
        clientDirectory,
        officialPluginsDirectory,
        archive,
        "darwin-arm64",
      ],
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
        "clawchat-connect",
        "clawchat-connect-client/",
        "clawchat-connect-client/index.html",
        "official-plugins/",
        ...DARWIN_OFFICIAL_PLUGIN_BUNDLES.map((name) => `official-plugins/${name}`),
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

  it("requires WorkBuddy only for Darwin archive payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-targeted-plugins-"));
    const connectBinary = join(directory, "connect");
    const clientDirectory = join(directory, "client");
    const officialPluginsDirectory = join(directory, "official-plugins");
    await Promise.all([mkdir(clientDirectory), mkdir(officialPluginsDirectory)]);
    await writeFile(connectBinary, "#!/bin/sh\nexit 0\n");
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n");
    await writeOfficialPluginFixtures(officialPluginsDirectory, PORTABLE_OFFICIAL_PLUGIN_BUNDLES);
    await chmod(connectBinary, 0o755);

    const packageFor = async (target: "darwin-x64" | "linux-x64", archive: string): Promise<number> =>
      await Bun.spawn(
        [
          "sh",
          "scripts/package-release-archive.sh",
          connectBinary,
          clientDirectory,
          officialPluginsDirectory,
          archive,
          target,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      ).exited;

    const linuxArchive = join(directory, "linux.tar.gz");
    expect(await packageFor("linux-x64", linuxArchive)).toBe(0);
    const listing = Bun.spawn(["tar", "-tzf", linuxArchive], { stdout: "pipe", stderr: "pipe" });
    const linuxEntries = await new Response(listing.stdout).text();
    expect(await listing.exited).toBe(0);
    expect(linuxEntries).not.toContain(WORKBUDDY_OFFICIAL_PLUGIN_BUNDLE);
    expect(await packageFor("darwin-x64", join(directory, "darwin-missing.tar.gz"))).not.toBe(0);

    await writeOfficialPluginFixtures(officialPluginsDirectory, [WORKBUDDY_OFFICIAL_PLUGIN_BUNDLE]);
    expect(await packageFor("darwin-x64", join(directory, "darwin.tar.gz"))).toBe(0);
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

  it("packages a Windows executable, Client assets, and official Plugin Bundles into one ZIP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-windows-release-"));
    const connectBinary = join(directory, "clawchat-connect.exe");
    const clientDirectory = join(directory, "client");
    const officialPluginsDirectory = join(directory, "official-plugins");
    const archive = join(directory, "clawchat-connect-windows-x64.zip");
    await Promise.all([mkdir(clientDirectory), mkdir(officialPluginsDirectory)]);
    await writeFile(connectBinary, "connect executable");
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n");
    await writeOfficialPluginFixtures(officialPluginsDirectory, PORTABLE_OFFICIAL_PLUGIN_BUNDLES);

    const child = Bun.spawn(
      [
        "sh",
        "scripts/package-windows-release.sh",
        connectBinary,
        clientDirectory,
        officialPluginsDirectory,
        archive,
        "win32-x64",
      ],
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
        "clawchat-connect-client/",
        "clawchat-connect-client/index.html",
        "clawchat-connect.exe",
        "official-plugins/",
        ...PORTABLE_OFFICIAL_PLUGIN_BUNDLES.map((name) => `official-plugins/${name}`),
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
    expect(installer).toContain("clawling.runtime.codex");
    expect(installer).toContain("clawling.runtime.deepseek-harness");
    expect(installer).toContain("clawling.runtime.opencode");
    expect(installer).not.toContain("clawling.runtime.workbuddy");
    expect(installer).toContain("raw.githubusercontent.com/$repository/release-channel/latest-beta.txt");
    expect(installer).not.toContain("api.github.com");
    expect(installer).toContain("Get-FileHash");
    expect(installer).toContain("Expand-Archive");
    expect(installer).toContain("clawchat-connect.exe");
    expect(installer).toContain('$legacyLivewareTarget = Join-Path $InstallDirectory "liveware.exe"');
    expect(installer).not.toContain("$livewareSource");
    expect(installer).not.toContain("$livewareStaging");
    expect(installer).toContain("CHANGELOG.md");
    expect(installer).toContain('service", "stop');
    expect(installer).toContain("$transactionStarted");
    expect(installer).toContain('$officialPluginsSource = Join-Path $extractedDirectory "official-plugins"');
    expect(installer).toContain('$officialPluginsStaging = "$officialPluginsTarget.new"');
    expect(installer).toContain(
      '@{ Target = $officialPluginsTarget; Backup = (Join-Path $backupDirectory "official-plugins"); Name = "officialPlugins" }',
    );
    expect(installer).toContain("Move-Item -LiteralPath $officialPluginsStaging -Destination $officialPluginsTarget");
    expect(installer).toContain("if ($transactionStarted -and -not $transactionCommitted)");
    const workflow = await readFile(".github/workflows/release-beta.yml", "utf8");
    expect(workflow).toContain("bun-windows-x64 windows x64");
    expect(workflow).toContain("bun-windows-arm64 windows arm64");
    expect(workflow).toContain("bun-linux-x64-baseline linux x64");
    expect(workflow).not.toMatch(/^\s*bun-linux-x64 linux x64$/mu);
    expect(workflow).toContain("install.ps1");
    expect(workflow).toContain("sh scripts/package-windows-release.sh");
    expect(workflow).toContain("./tests/windows-installer-preflight.ps1");
    expect(workflow).toContain("bun scripts/release-beta.ts publish build/release-notes.md build/release/*");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).toContain("release-channel");
    expect(workflow).toContain("latest-beta.txt");
  });

  it("keeps installed WorkBuddy qualification optional and the beta workflow deterministic", async () => {
    const workflow = await readFile(".github/workflows/release-beta.yml", "utf8");
    expect(workflow).not.toContain("workbuddy-installed:");
    expect(workflow).not.toContain("workbuddy-release");
    expect(workflow).not.toContain("WORKBUDDY_AI_TEST_");
    expect(workflow).not.toContain("WORKBUDDY_CN_TEST_");
    expect(workflow).not.toContain("bun run check:release:workbuddy");
    expect(workflow).not.toContain("playwright install");
    expect(workflow).not.toContain("test:client-web");
    expect(workflow).not.toContain("test:integration:codex");
    expect(workflow).not.toContain("@openai/codex");
    expect(workflow).not.toContain("${{ secrets.");
    expect(workflow).toContain("needs: [validate, windows-smoke]");
    expect(workflow).toContain("run: bun run check:release");

    const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(ciWorkflow).not.toContain("playwright install");
    expect(ciWorkflow).not.toContain("test:client-web");
    expect(ciWorkflow).toContain("run: bun run check:core");
    expect(ciWorkflow).toContain("run: bun run clean && bun run build");

    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(packageManifest.scripts["check:release:workbuddy"]).toContain(
      "test:integration:workbuddy-installation-preflight",
    );
    expect(packageManifest.scripts["test:integration:workbuddy-ai"]).toContain(
      "test:integration:workbuddy-ai-ui-concurrency-recovery",
    );
    expect(packageManifest.scripts["test:integration:workbuddy-cn"]).toContain(
      "test:integration:workbuddy-cn-ui-concurrency-recovery",
    );
    expect(packageManifest.scripts["check:release:workbuddy"]).toContain("bun run check:core");
    expect(packageManifest.scripts["check:release"]).toContain("bun run check:core");
    expect(packageManifest.scripts["check:release"]).toContain("tests/release-bundle.test.ts");
    expect(packageManifest.scripts["check:core"]).not.toContain("test:client-web");
    expect(packageManifest.scripts.check).toBe("bun run check:core");
    expect(packageManifest.scripts["test:client-web"]).toBeUndefined();
    expect(packageManifest.devDependencies["@playwright/test"]).toBeUndefined();

    const workbuddyDocs = await readFile("docs/workbuddy-adapter.md", "utf8");
    expect(workbuddyDocs).toContain("Optional installed-release diagnostics");
    expect(workbuddyDocs).toContain("does not block creating or publishing a release tag");
    expect(workbuddyDocs).not.toContain("Record the local qualification result before creating the release tag");
  });

  it("documents the beta workflow as the current release channel", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("Version tags such as `v0.1.0-beta.8` run the beta release workflow");
    expect(readme).toContain("`v*-beta.*`");
    expect(readme).toContain("[`.github/workflows/release-beta.yml`](.github/workflows/release-beta.yml)");
    expect(readme).toContain("`release-channel/latest-beta.txt` pointer used by default installs and updates");
    expect(readme).toContain("Install the current beta-channel ClawChat Connect release on this computer.");
    expect(readme).toContain("Local installed-product qualification is optional and does not block tagging");

    const readmeZh = await readFile("README_zh.md", "utf8");
    expect(readmeZh).toContain("在这台电脑上安装 ClawChat Connect 当前 beta 通道版本。");
  });

  it("embeds verified Liveware assets in official Plugin Bundles instead of the npm package root", async () => {
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(packageManifest.files).not.toContain("vendor/liveware");
    expect(packageManifest.files).toContain("scripts/postinstall.ts");
    expect(packageManifest.scripts.prepack).toContain("verify-liveware-bundle.ts");
    expect(packageManifest.scripts["build:binary"]).toContain("build-binary.ts");
    expect(packageManifest.scripts.postinstall).toBe("bun scripts/postinstall.ts");
  });

  it("skips managed Skill installation when a source checkout has not been built", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-postinstall-"));
    expect(installManagedSkillsFromPackage(join(directory, "dist", "src", "bin.js"))).toBe(0);
  });

  it("installs the Client and official Plugin Bundles while removing the legacy root companion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-install-"));
    const sourceDirectory = join(directory, "source");
    const clientDirectory = join(sourceDirectory, "client");
    const officialPluginsDirectory = join(sourceDirectory, "official-plugins");
    const fixtureDirectory = join(directory, "fixtures");
    const commandDirectory = join(directory, "commands");
    const installDirectory = join(directory, "installed");
    const asset =
      process.platform === "darwin"
        ? `clawchat-connect-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`
        : `clawchat-connect-linux-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
    const pluginTarget = `${process.platform === "darwin" ? "darwin" : "linux"}-${
      process.arch === "arm64" ? "arm64" : "x64"
    }`;
    const officialPluginBundles =
      process.platform === "darwin" ? DARWIN_OFFICIAL_PLUGIN_BUNDLES : PORTABLE_OFFICIAL_PLUGIN_BUNDLES;
    const archive = join(fixtureDirectory, asset);
    await Promise.all([
      mkdir(clientDirectory, { recursive: true }),
      mkdir(officialPluginsDirectory, { recursive: true }),
      mkdir(fixtureDirectory, { recursive: true }),
      mkdir(commandDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true }),
    ]);
    const connectBinary = join(sourceDirectory, "clawchat-connect");
    await Promise.all([
      writeFile(connectBinary, '#!/bin/sh\n[ "$' + '{1:-}" = --help ] || [ "$' + '{1:-}" = skills ]\n'),
      writeFile(join(installDirectory, "liveware"), "legacy root companion\n"),
      writeFile(join(clientDirectory, "index.html"), "<!doctype html>\n"),
      writeOfficialPluginFixtures(officialPluginsDirectory, officialPluginBundles, "installed release\n"),
    ]);
    await chmod(connectBinary, 0o755);

    const packageProcess = Bun.spawn(
      [
        "sh",
        "scripts/package-release-archive.sh",
        connectBinary,
        clientDirectory,
        officialPluginsDirectory,
        archive,
        pluginTarget,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await packageProcess.exited).toBe(0);
    const checksumProcess = Bun.spawn(["shasum", "-a", "256", archive], { stdout: "pipe" });
    const checksum = (await new Response(checksumProcess.stdout).text()).split(/\s+/u)[0];
    expect(await checksumProcess.exited).toBe(0);
    await writeFile(join(fixtureDirectory, "checksums.txt"), `${checksum}  ${asset}\n`);
    await writeFile(join(fixtureDirectory, "latest-beta.txt"), "v0.1.0-beta.12\n");
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
        "  *release-channel/latest-beta.txt)",
        '    if [ -n "$output" ]; then',
        '      cp "$CONNECT_INSTALL_FIXTURES/latest-beta.txt" "$output"',
        "    else",
        '      cat "$CONNECT_INSTALL_FIXTURES/latest-beta.txt"',
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
    expect(await Bun.file(join(installDirectory, "liveware")).exists()).toBe(false);
    await expect(readFile(join(installDirectory, "clawchat-connect-client", "index.html"), "utf8")).resolves.toContain(
      "<!doctype html>",
    );
    const installedOfficialPluginsDirectory = join(installDirectory, "official-plugins");
    await expect(readdir(installedOfficialPluginsDirectory).then((entries) => entries.sort())).resolves.toEqual(
      [...officialPluginBundles].sort(),
    );
    for (const bundle of officialPluginBundles) {
      await expect(readFile(join(installedOfficialPluginsDirectory, bundle), "utf8")).resolves.toBe(
        "installed release\n",
      );
    }
    await expect(readFile(join(installDirectory, "skills", "manifest.json"), "utf8")).resolves.toContain(
      CONNECT_VERSION,
    );
    await expect(readFile(join(installDirectory, "licenses", "CHANGELOG.md"), "utf8")).resolves.toContain(
      "# Changelog",
    );
    await expect(readFile(requestsPath, "utf8")).resolves.toContain(
      "/releases/download/v0.1.0-beta.12/clawchat-connect-",
    );
    const requests = await readFile(requestsPath, "utf8");
    expect(requests).toContain("/release-channel/latest-beta.txt");
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
      [
        "sh",
        "scripts/package-release-archive.sh",
        connectBinary,
        clientDirectory,
        officialPluginsDirectory,
        archive,
        pluginTarget,
      ],
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

    const retiredBundle = "clawling.runtime.retired-0.0.0-test.connect-plugin";
    await writeFile(join(installedOfficialPluginsDirectory, retiredBundle), "retired installed release\n");
    const installedBundleContents = new Map<string, string>();
    for (const bundle of [...officialPluginBundles, retiredBundle]) {
      installedBundleContents.set(bundle, await readFile(join(installedOfficialPluginsDirectory, bundle), "utf8"));
    }

    await writeOfficialPluginFixtures(officialPluginsDirectory, officialPluginBundles, "upgrade release\n");
    await writeFile(
      connectBinary,
      [
        "#!/bin/sh",
        '[ "$' + '{1:-}" = --help ] && exit 0',
        '[ "$' + '{1:-}" = skills ] && [ "$' + '{2:-}" = preflight ] && exit 0',
        '[ "$' + '{1:-}" = skills ] && [ "$' + '{2:-}" = install ] && exit 23',
        "exit 1",
        "",
      ].join("\n"),
    );
    await chmod(connectBinary, 0o755);
    const rollbackPackage = Bun.spawn(
      [
        "sh",
        "scripts/package-release-archive.sh",
        connectBinary,
        clientDirectory,
        officialPluginsDirectory,
        archive,
        pluginTarget,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await rollbackPackage.exited).toBe(0);
    const rollbackChecksumProcess = Bun.spawn(["shasum", "-a", "256", archive], { stdout: "pipe" });
    const rollbackChecksum = (await new Response(rollbackChecksumProcess.stdout).text()).split(/\s+/u)[0];
    expect(await rollbackChecksumProcess.exited).toBe(0);
    await writeFile(join(fixtureDirectory, "checksums.txt"), `${rollbackChecksum}  ${asset}\n`);

    const rolledBackInstall = Bun.spawn(["sh", "install.sh"], {
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
    expect(await rolledBackInstall.exited).not.toBe(0);
    await expect(readdir(installedOfficialPluginsDirectory).then((entries) => entries.sort())).resolves.toEqual(
      [...installedBundleContents.keys()].sort(),
    );
    for (const [bundle, content] of installedBundleContents) {
      await expect(readFile(join(installedOfficialPluginsDirectory, bundle), "utf8")).resolves.toBe(content);
    }
  });
});
