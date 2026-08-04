# Beta Release Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a verified current-platform `bun run build:release` command, promote ClawChat Connect to `0.1.0-beta.1`, publish the six-platform beta prerelease, and leave the README showcase accurate and polished.

**Architecture:** A focused Bun script owns release orchestration and pure target/version helpers, while the existing POSIX archive script remains the source of truth for macOS/Linux payload layout and a PowerShell equivalent handles native Windows ZIP creation. GitHub Actions continues to own six-target publication, but moves to beta tag and channel semantics. Tests exercise the pure release contract and source-level installer/workflow invariants before any real build or tag is produced.

**Tech Stack:** Bun 1.x, TypeScript, Bun test, POSIX shell, PowerShell, GitHub Actions, GitHub CLI, Markdown.

## Global Constraints

- The release version is exactly `0.1.0-beta.1`, and the release tag is exactly `v0.1.0-beta.1`.
- Reusable version validation accepts only `<major>.<minor>.<patch>-beta.N`, where `N` is a positive integer.
- Local release builds target only the current host platform and architecture; GitHub Actions remains responsible for all six platform archives.
- The packaged payload contains the Connect executable, matching vendored Liveware executable, built Connect Client, `skills`, `CHANGELOG.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.
- Local macOS/Linux output is `build/release/clawchat-connect-<platform>-<architecture>.tar.gz`; local Windows output uses the same basename with `.zip`.
- `build/release/` additionally contains `install.sh`, `install.ps1`, `CHANGELOG.md`, and `checksums.txt` covering the archive and those three support files.
- Only the exact owned `build/release/` directory may be recreated; no broader build or workspace directory may be deleted.
- A failed child phase must be named in the error and must preserve its original exit status.
- Default installers read `release-channel/latest-beta.txt`; explicit historical version installation remains supported.
- The GitHub release remains a prerelease and the beta channel pointer advances only after successful asset publication.
- Historical alpha releases and `release-channel/latest-alpha.txt` are not deleted.
- README screenshots remain ordered as ClawChat conversation, empty Connect Client, active Codex Session.

---

## File Map

- Create `scripts/build-release.ts`: beta validation, host target resolution, phase orchestration, support-file copying, and SHA-256 manifest generation.
- Create `scripts/package-windows-release.ps1`: native Windows staging and ZIP packaging with the same payload as the POSIX archive script.
- Create `tests/build-release.test.ts`: pure release contract, naming, payload, phase order, checksum, and failure-propagation tests.
- Modify `scripts/package-release-archive.sh`: only if a test exposes a payload mismatch; it remains the POSIX layout authority.
- Modify `tests/release-bundle.test.ts`: assert POSIX and Windows packagers contain the same logical payload.
- Modify `tests/codex-app-server.test.ts`: update the asserted Connect client version to beta.1.
- Modify `package.json`: add `build:release` and set `0.1.0-beta.1`.
- Modify `.gitignore`: ignore generated `build/` release output.
- Modify `src/version.ts` and regenerate `skills/manifest.json`: synchronize the Connect version.
- Rename `.github/workflows/release-alpha.yml` to `.github/workflows/release-beta.yml`: beta tag validation, prerelease publication, and beta channel update.
- Modify `install.sh` and `install.ps1`: resolve the beta pointer by default while preserving explicit tags.
- Create `tests/release-channel.test.ts`: lock version, installer, workflow, and pointer invariants.
- Modify `CHANGELOG.md`: document `0.1.0-beta.1` on 2026-08-04.
- Modify `README.md`: retain the approved screenshot order and replace stale alpha release guidance.
- Modify `README_zh.md`: keep version, beta status, install examples, and release guidance aligned with English.
- Add `docs/assets/clawchat-agent-conversation.png`: first showcase image already supplied and edited by the user.

---

### Task 1: Define the Local Release Contract

**Files:**
- Create: `tests/build-release.test.ts`
- Create: `scripts/build-release.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `package.json.version`, `process.platform`, and `process.arch`.
- Produces: `requireBetaVersion(version: string): string`, `resolveReleaseTarget(platform: NodeJS.Platform, architecture: string): ReleaseTarget`, `releasePayload(target: ReleaseTarget): ReleasePayload`, and the `bun run build:release` script entry.

- [ ] **Step 1: Write failing tests for beta versions and target naming**

Create `tests/build-release.test.ts` with the following contract:

```ts
import { describe, expect, test } from "bun:test";
import {
  releasePayload,
  requireBetaVersion,
  resolveReleaseTarget,
} from "../scripts/build-release";

describe("requireBetaVersion", () => {
  test.each(["0.1.0-beta.1", "12.34.56-beta.9"])("accepts %s", (version) => {
    expect(requireBetaVersion(version)).toBe(version);
  });

  test.each([
    "0.1.0-alpha.33",
    "0.1.0-beta.0",
    "0.1.0-beta.-1",
    "0.1.0-beta.01",
    "v0.1.0-beta.1",
    "0.1.0",
  ])("rejects %s", (version) => {
    expect(() => requireBetaVersion(version)).toThrow("beta release version");
  });
});

describe("resolveReleaseTarget", () => {
  test("maps Apple silicon", () => {
    expect(resolveReleaseTarget("darwin", "arm64")).toMatchObject({
      platform: "darwin",
      architecture: "arm64",
      archiveName: "clawchat-connect-darwin-arm64.tar.gz",
      connectExecutable: "clawchat-connect",
      livewareAsset: "liveware-darwin-arm64",
    });
  });

  test("maps Linux x64 to the amd64 Liveware asset", () => {
    expect(resolveReleaseTarget("linux", "x64")).toMatchObject({
      platform: "linux",
      architecture: "x64",
      archiveName: "clawchat-connect-linux-x64.tar.gz",
      livewareAsset: "liveware-linux-amd64",
    });
  });

  test("maps Windows x64 to a zip", () => {
    expect(resolveReleaseTarget("win32", "x64")).toMatchObject({
      platform: "windows",
      architecture: "x64",
      archiveName: "clawchat-connect-windows-x64.zip",
      connectExecutable: "clawchat-connect.exe",
      livewareExecutable: "liveware.exe",
    });
  });

  test("rejects unsupported hosts", () => {
    expect(() => resolveReleaseTarget("freebsd", "x64")).toThrow("Unsupported release host");
  });
});

test("release payload is complete", () => {
  const target = resolveReleaseTarget("darwin", "arm64");
  expect(releasePayload(target).entries).toEqual([
    "clawchat-connect",
    "liveware",
    "clawchat-connect-client",
    "skills",
    "CHANGELOG.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run: `bun test tests/build-release.test.ts`

Expected: FAIL because `scripts/build-release.ts` does not exist.

- [ ] **Step 3: Implement the pure release types and helpers**

Create `scripts/build-release.ts` with these public types and functions, keeping the executable entry behind `if (import.meta.main)` so tests can import it without building:

```ts
export interface ReleaseTarget {
  platform: "darwin" | "linux" | "windows";
  architecture: "arm64" | "x64";
  archiveName: string;
  archiveFormat: "tar.gz" | "zip";
  connectExecutable: "clawchat-connect" | "clawchat-connect.exe";
  livewareExecutable: "liveware" | "liveware.exe";
  livewareAsset: string;
}

export interface ReleasePayload {
  entries: readonly string[];
}

export function requireBetaVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version)) {
    throw new Error(`Expected a beta release version, received ${version}`);
  }
  return version;
}
```

Implement `resolveReleaseTarget` with an explicit six-entry map for `darwin/linux/win32 × arm64/x64`; use release architecture `x64` in archive names and Liveware architecture `amd64` only where the vendored filename requires it. Implement `releasePayload` with the seven exact entries from the test.

- [ ] **Step 4: Register and isolate generated release output**

Add this package script:

```json
"build:release": "bun scripts/build-release.ts"
```

Add `build/` to `.gitignore`, leaving `dist/` behavior unchanged.

- [ ] **Step 5: Run the focused test and formatting check**

Run: `bun test tests/build-release.test.ts && bunx biome check scripts/build-release.ts tests/build-release.test.ts package.json`

Expected: all release contract tests pass and Biome reports no errors.

- [ ] **Step 6: Commit the contract**

```bash
git add .gitignore package.json scripts/build-release.ts tests/build-release.test.ts
git commit -m "feat(release): define local release build"
```

---

### Task 2: Package and Verify the Current Host Release

**Files:**
- Modify: `scripts/build-release.ts`
- Create: `scripts/package-windows-release.ps1`
- Modify: `tests/build-release.test.ts`
- Modify: `tests/release-bundle.test.ts`
- Modify only if parity fails: `scripts/package-release-archive.sh`

**Interfaces:**
- Consumes: `ReleaseTarget`, `ReleasePayload`, existing `scripts/build-binary.ts`, `scripts/verify-liveware-bundle.ts`, and `scripts/package-release-archive.sh`.
- Produces: `ReleasePhase`, `releasePhases(target: ReleaseTarget): readonly ReleasePhase[]`, `runReleaseBuild(options?: ReleaseBuildOptions): Promise<void>`, and `writeChecksums(directory: string, filenames: readonly string[]): Promise<void>`.

- [ ] **Step 1: Extend the test with phase, checksum, and exit-status behavior**

Add tests with a temporary directory and an injected runner:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  releasePhases,
  runReleaseBuild,
  writeChecksums,
} from "../scripts/build-release";

test("release phases validate before mutating output and package last", () => {
  const phases = releasePhases(resolveReleaseTarget("darwin", "arm64"));
  expect(phases.map(({ name }) => name)).toEqual([
    "validate version",
    "prepare output",
    "core checks",
    "verify Liveware bundle",
    "clean distributable",
    "build standalone executable",
    "package release archive",
    "copy release support files",
    "write checksums",
  ]);
});

test("checksums cover the archive and copied support files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connect-release-"));
  const files = ["artifact.tar.gz", "install.sh", "install.ps1", "CHANGELOG.md"];
  for (const filename of files) await writeFile(join(directory, filename), filename);
  await writeChecksums(directory, files);
  const manifest = await readFile(join(directory, "checksums.txt"), "utf8");
  for (const filename of files) expect(manifest).toContain(`  ${filename}\n`);
  expect(manifest).not.toContain("checksums.txt");
});

test("a failed phase keeps its name and exit status", async () => {
  const failure = Object.assign(new Error("child failed"), { exitCode: 17 });
  await expect(
    runReleaseBuild({
      version: "0.1.0-beta.1",
      target: resolveReleaseTarget("darwin", "arm64"),
      runPhase: async (phase) => {
        if (phase.name === "core checks") throw failure;
      },
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining("core checks"), exitCode: 17 });
});
```

- [ ] **Step 2: Run the tests and confirm the new exports are missing**

Run: `bun test tests/build-release.test.ts`

Expected: FAIL because `releasePhases`, `runReleaseBuild`, and `writeChecksums` are not exported.

- [ ] **Step 3: Implement explicit phase orchestration**

Use these interfaces in `scripts/build-release.ts`:

```ts
export interface ReleasePhase {
  name: string;
  command?: readonly string[];
}

export interface ReleaseBuildOptions {
  version: string;
  target: ReleaseTarget;
  runPhase?: (phase: ReleasePhase) => Promise<void>;
}
```

Build the phase list so it executes these concrete operations in order:

1. Validate `package.json.version` before any filesystem change.
2. Remove only `<repo>/build/release`, then recreate it.
3. Run `bun run check:core`.
4. Run `bun scripts/verify-liveware-bundle.ts`.
5. Run `bun run clean`.
6. Run `bun run build:binary`.
7. On macOS/Linux, invoke `sh scripts/package-release-archive.sh` with the built Connect binary, `dist/client`, matching `dist/liveware`, and archive output path.
8. On Windows, invoke PowerShell with `scripts/package-windows-release.ps1` and equivalent inputs.
9. Copy `install.sh`, `install.ps1`, and `CHANGELOG.md` into `build/release`.
10. Hash the archive plus the three support files using `node:crypto` SHA-256 and write sorted lines in the form `<hex>  <basename>`.

Wrap each child failure in an error whose message begins `Release phase failed: <phase name>`, copy numeric `exitCode` onto the wrapper, and set `process.exitCode` to that value in the executable entry.

- [ ] **Step 4: Add the native Windows packager**

Create `scripts/package-windows-release.ps1` with positional parameters for Connect executable, Client directory, Liveware executable, and output archive. Its first executable statement must be `param`, followed by the stop-on-error preference:

```powershell
param(
  [Parameter(Mandatory = $true)][string]$ConnectExecutable,
  [Parameter(Mandatory = $true)][string]$ClientDirectory,
  [Parameter(Mandatory = $true)][string]$LivewareExecutable,
  [Parameter(Mandatory = $true)][string]$OutputArchive
)

$ErrorActionPreference = "Stop"
```

Validate every input with `Test-Path`, create one unique staging directory beneath `[System.IO.Path]::GetTempPath()`, copy the payload under a `clawchat-connect` root, and call `Compress-Archive`. Copy `skills`, `CHANGELOG.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` from the repository root determined relative to `$PSScriptRoot`. Remove only its unique staging directory in `finally`.

- [ ] **Step 5: Lock POSIX/Windows payload parity**

Extend `tests/release-bundle.test.ts` to read both packaging scripts and assert that each names all seven logical payload entries:

```ts
const logicalPayload = [
  "clawchat-connect",
  "liveware",
  "clawchat-connect-client",
  "skills",
  "CHANGELOG.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
const posixPackager = await readFile("scripts/package-release-archive.sh", "utf8");
const windowsPackager = await readFile("scripts/package-windows-release.ps1", "utf8");
for (const entry of logicalPayload) {
  expect(posixPackager.toLowerCase()).toContain(entry.toLowerCase());
  expect(windowsPackager.toLowerCase()).toContain(entry.toLowerCase());
}
```

On Windows, also execute the PowerShell packager against temporary dummy files and inspect the resulting ZIP entry names. Gate that execution with `if (process.platform === "win32")`; on non-Windows, the source contract runs while the beta workflow's Windows smoke job remains authoritative.

- [ ] **Step 6: Run release-script tests**

Run: `bun test tests/build-release.test.ts tests/release-bundle.test.ts`

Expected: all version, target, payload, phase, checksum, failure, and package-layout tests pass.

- [ ] **Step 7: Commit host packaging**

```bash
git add scripts/build-release.ts scripts/package-windows-release.ps1 scripts/package-release-archive.sh tests/build-release.test.ts tests/release-bundle.test.ts
git commit -m "feat(release): package current host release"
```

If `scripts/package-release-archive.sh` did not require a parity edit, omit it from `git add`.

---

### Task 3: Promote Versions, Installers, and Automation to Beta

**Files:**
- Create: `tests/release-channel.test.ts`
- Modify: `package.json`
- Modify: `src/version.ts`
- Regenerate: `skills/manifest.json`
- Modify: `tests/codex-app-server.test.ts`
- Modify: `tests/release-bundle.test.ts`
- Rename: `.github/workflows/release-alpha.yml` to `.github/workflows/release-beta.yml`
- Modify: `install.sh`
- Modify: `install.ps1`

**Interfaces:**
- Consumes: `requireBetaVersion`, the generated-manifest command, existing six-target release jobs, and explicit installer version arguments.
- Produces: synchronized `0.1.0-beta.1` metadata, beta tag workflow, and `latest-beta.txt` default installation.

- [ ] **Step 1: Write a failing beta-channel source contract**

Create `tests/release-channel.test.ts`:

```ts
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
  expect(shell).toMatch(/VERSION.*\$1|\$\{1/);
  expect(powershell).toMatch(/Version/);
});

test("beta workflow publishes six archives before advancing the channel", async () => {
  const workflow = await read(".github/workflows/release-beta.yml");
  expect(workflow).toContain("v*-beta.*");
  expect(workflow).toContain("latest-beta.txt");
  expect(workflow).toContain("prerelease: true");
  for (const target of [
    "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64",
    "windows-arm64", "windows-x64",
  ]) expect(workflow).toContain(target);
  expect(workflow.indexOf("gh release")).toBeLessThan(workflow.lastIndexOf("latest-beta.txt"));
});
```

During implementation, adapt only the two explicit-version regex assertions to the installers' existing variable names; keep their intent that supplied versions bypass channel lookup.

- [ ] **Step 2: Run the source contract and confirm alpha-state failures**

Run: `bun test tests/release-channel.test.ts`

Expected: FAIL on package version, missing beta workflow, and alpha channel references.

- [ ] **Step 3: Synchronize generated version metadata**

Set `package.json.version` and `src/version.ts` to `0.1.0-beta.1`, then run:

```bash
bun scripts/generate-skills-manifest.ts
bun scripts/check-generated.ts
```

Expected: `skills/manifest.json` reports `connectVersion: "0.1.0-beta.1"`, and generated-file validation passes.

Update the exact client-version fixture in `tests/codex-app-server.test.ts` from `0.1.0-alpha.33` to `0.1.0-beta.1` so the protocol test continues to assert the published Connect version.

- [ ] **Step 4: Rename and edit the release workflow**

Rename the workflow to `.github/workflows/release-beta.yml`, then make these exact semantic changes:

- Display name uses `Release beta`.
- Tag trigger is `v*-beta.*`.
- Validation accepts only the beta regex used by `requireBetaVersion` and requires `GITHUB_REF_NAME === v${package.json.version}`.
- Installer assertions require `release-channel/latest-beta.txt`.
- Release remains `prerelease: true` and retains all six targets and Windows smoke.
- The channel update writes the released tag to `release-channel/latest-beta.txt` only after `gh release` succeeds.
- The Windows smoke parser also parses `scripts/package-windows-release.ps1` and runs `bun test tests/build-release.test.ts tests/release-channel.test.ts`.

- [ ] **Step 5: Switch default installers to beta**

Replace only their unversioned pointer URL and alpha-specific empty-channel messages with beta terminology. Do not change explicit `VERSION`/`Version` argument handling or release asset URL construction.

Update the existing installer and workflow cases in `tests/release-bundle.test.ts`, including the fake `latest-alpha.txt` fixture and request assertion, to use `latest-beta.txt`. Rename the workflow-description test from alpha to beta while preserving its deterministic/local-qualification assertions.

- [ ] **Step 6: Run beta contract and installer syntax tests**

Run:

```bash
bun test tests/release-channel.test.ts tests/build-release.test.ts
sh -n install.sh
```

If `pwsh` is available, also run:

```bash
pwsh -NoProfile -Command '$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "install.ps1"), [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }'
```

Expected: all tests pass and both available parsers report no syntax errors.

- [ ] **Step 7: Scan for unintended active alpha references**

Run: `rg -n "0\.1\.0-alpha\.33|latest-alpha|release-alpha|v\*-alpha" package.json src skills scripts tests install.sh install.ps1 .github README.md README_zh.md CHANGELOG.md`

Expected: remaining matches are limited to historical changelog entries or explicit historical-install documentation; no active build, workflow, installer, or current-version reference remains.

- [ ] **Step 8: Commit beta automation**

```bash
git add package.json src/version.ts skills/manifest.json install.sh install.ps1 tests/codex-app-server.test.ts tests/release-bundle.test.ts tests/release-channel.test.ts .github/workflows/release-alpha.yml .github/workflows/release-beta.yml
git commit -m "build(release): promote channel to beta"
```

---

### Task 4: Finish Changelog and README Showcase

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README_zh.md`
- Add: `docs/assets/clawchat-agent-conversation.png`

**Interfaces:**
- Consumes: approved screenshot order and the final commands/channel from Tasks 1–3.
- Produces: release-note text used by GitHub Actions and current English/Chinese user guidance.

- [ ] **Step 1: Add the beta changelog entry**

At the top of `CHANGELOG.md`, add `0.1.0-beta.1` dated `2026-08-04` with concise bullets covering:

- Connect Client internationalization and localization validation.
- ClawChat/Connect Client showcase screenshots.
- `bun run build:release` current-platform packaging and checksum output.
- Promotion of default installers and release automation to the beta channel.

Keep prior alpha entries unchanged because they are release history.

- [ ] **Step 2: Preserve and verify the approved English screenshot block**

Keep the image sequence exactly:

```html
<p align="center">
  <img src="./docs/assets/clawchat-agent-conversation.png" alt="A ClawChat conversation with a connected local coding agent" width="60%" />
</p>

<p align="center">
  <img src="./docs/assets/connect-client-liveware-empty.png" alt="ClawChat Connect Client Liveware empty state" width="100%" />
</p>

<p align="center">
  <img src="./docs/assets/connect-client-liveware-session.png" alt="ClawChat Connect Client Liveware active Codex Session" width="100%" />
</p>
```

Do not resize the first image to 100%; its portrait composition is clearer at 60%.

- [ ] **Step 3: Correct stale release guidance in both READMEs**

In `README.md` and `README_zh.md`:

- Change the current maturity warning from alpha to beta without claiming stable status.
- Replace current install/version examples with `v0.1.0-beta.1`.
- Describe `v*-beta.*`, `.github/workflows/release-beta.yml`, and `release-channel/latest-beta.txt`.
- Add `bun run build:release` to Development as the current-host distributable command, explaining that it writes the archive, installers, changelog, and checksums under `build/release/`.
- Keep `bun run build:binary` documented as the lighter unpackaged standalone build.
- Preserve explicit historical-version installation guidance.

- [ ] **Step 4: Validate links, images, and stale prose**

Run:

```bash
test -f docs/assets/clawchat-agent-conversation.png
test -f docs/assets/connect-client-liveware-empty.png
test -f docs/assets/connect-client-liveware-session.png
rg -n "alpha software|0\.1\.0-alpha\.33|latest-alpha|release-alpha|v\*-alpha" README.md README_zh.md
```

Expected: all three image checks succeed. Text matches, if any, are explicitly labeled historical examples; current guidance is beta-only.

- [ ] **Step 5: Review rendered content order**

Open the repository README preview or GitHub-compatible Markdown preview and confirm:

1. The ClawChat portrait screenshot appears first and is visually narrower.
2. Empty and active Connect Client screenshots follow at full width.
3. The install, development, and release paragraphs agree on beta terminology.
4. English and Chinese current version examples are identical.

- [ ] **Step 6: Commit documentation**

```bash
git add CHANGELOG.md README.md README_zh.md docs/assets/clawchat-agent-conversation.png
git commit -m "docs: present beta release workflow"
```

---

### Task 5: Qualify the Local Release Artifact

**Files:**
- Verify only: all changed files and generated `build/release/` output.
- Modify only to fix an observed test/build failure: the file responsible for that failure.

**Interfaces:**
- Consumes: finished Tasks 1–4.
- Produces: evidence that source, package build, release archive, payload, and checksums are ready to tag.

- [ ] **Step 1: Run the full deterministic repository check**

Run: `bun run check`

Expected: generated-file checks, Biome, TypeScript, unit tests, localization validation, and Client browser integration all pass.

- [ ] **Step 2: Build the normal distributable package**

Run: `bun run clean && bun run build`

Expected: service and production Client builds succeed under `dist/`.

- [ ] **Step 3: Build the current-host release**

Run: `bun run build:release`

Expected: the script reports all named phases and produces exactly one host archive plus `install.sh`, `install.ps1`, `CHANGELOG.md`, and `checksums.txt` in `build/release/`.

- [ ] **Step 4: Inspect archive payload**

On macOS/Linux, run:

```bash
tar -tzf build/release/clawchat-connect-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/').tar.gz
```

For macOS, normalize `darwin` case if the shell expression outputs `darwin`; for Windows, use `Expand-Archive` into a temporary directory and list recursively. Confirm all seven payload entries are present at the archive root with the platform-appropriate executable names.

- [ ] **Step 5: Verify checksum coverage and values**

Run from the repository root:

```bash
cd build/release && shasum -a 256 -c checksums.txt
```

Expected: the archive, `install.sh`, `install.ps1`, and `CHANGELOG.md` each report `OK`; `checksums.txt` does not list itself.

- [ ] **Step 6: Review the complete diff and repository status**

Run:

```bash
git diff origin/main...HEAD --check
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, no generated `build/` files in status, only intentional commits/files, and no uncommitted implementation changes. If qualification forced a fix, rerun the failed gate and commit the focused fix before continuing.

---

### Task 6: Push, Tag, Publish, and Verify `v0.1.0-beta.1`

**Files:**
- External state only: `origin/main`, Git tag `v0.1.0-beta.1`, GitHub prerelease assets, and `release-channel/latest-beta.txt`.

**Interfaces:**
- Consumes: clean qualified `main` from Task 5.
- Produces: published beta prerelease with six archives and an advanced beta channel pointer.

- [ ] **Step 1: Confirm the exact release commit and absent tag**

Run:

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git ls-remote --tags origin refs/tags/v0.1.0-beta.1
```

Expected: clean status, branch `main`, and no remote beta.1 tag.

- [ ] **Step 2: Push the implementation commits**

Run: `git push origin main`

Expected: `origin/main` advances through the beta release implementation and documentation commits.

- [ ] **Step 3: Create and push the exact release tag**

Run:

```bash
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

Expected: the tag push triggers `.github/workflows/release-beta.yml`.

- [ ] **Step 4: Monitor the beta workflow to completion**

Run:

```bash
release_run_id="$(gh run list --workflow release-beta.yml --branch v0.1.0-beta.1 --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "${release_run_id}"
gh run watch "${release_run_id}" --exit-status
```

Expected: Windows smoke, deterministic checks, all six builds, release publication, and beta pointer update succeed.

- [ ] **Step 5: Verify prerelease assets**

Run:

```bash
gh release view v0.1.0-beta.1 --json isPrerelease,tagName,assets
```

Expected: `isPrerelease` is true, `tagName` is `v0.1.0-beta.1`, and assets contain all six platform archives plus `install.sh`, `install.ps1`, `CHANGELOG.md`, and `checksums.txt`.

- [ ] **Step 6: Verify the beta channel pointer**

Run:

```bash
gh api repos/XMethues/clawchat-plugin-connect/contents/release-channel/latest-beta.txt?ref=release-channel --jq '.content' | base64 --decode
```

Expected: output is exactly `v0.1.0-beta.1` followed by a newline. Also confirm `release-channel/latest-alpha.txt` still exists and was not rewritten.

- [ ] **Step 7: Record final release evidence**

Report the release URL, workflow run URL, published asset count, beta pointer value, and the successful local commands from Task 5. If any workflow job fails, do not move or recreate the tag; inspect the failed logs, implement a new focused commit, and use a new beta sequence only after deciding how to preserve release immutability.
