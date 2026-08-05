Status: ready-for-agent

# Add a local release build and promote the release channel to beta

## Problem Statement

ClawChat Connect has separate development builds, host-platform standalone binary builds, and a tag-driven GitHub Actions release workflow, but it has no single local command that performs the release checks and packages the current host platform in the same shape as a published artifact. Maintainers must assemble the local release path from several commands and scripts, which makes it easy to omit generated-file validation, the bundled Liveware binary, Client assets, skills, notices, or checksums.

The current release automation and default installers are also alpha-specific. The package version, tag filter, version validation, release workflow labels, documentation examples, and release-channel pointer all use `alpha`. Publishing the first beta by changing only `package.json` would not trigger the existing workflow and would leave default installs following `latest-alpha.txt`.

## Solution

Add `bun run build:release` as the canonical local current-platform release build. A Bun-owned orchestration script will validate the beta package version, run deterministic release checks, build the web Client and current-platform standalone executable, verify and include the matching vendored Liveware binary, and package the exact runtime payload under `build/release/`. The command will also emit SHA-256 metadata for the locally produced artifact and copied release support files.

Promote the project to `0.1.0-beta.1`. Replace the alpha tag workflow with a beta tag workflow triggered by `v*-beta.*`, require the tag to equal `v${package.json.version}`, continue publishing the six macOS/Linux/Windows arm64/x64 artifacts as a GitHub prerelease, and advance `release-channel/latest-beta.txt` only after all release assets are published successfully.

Default macOS/Linux and Windows installers will resolve `release-channel/latest-beta.txt`. Explicit version installation remains compatible with any valid existing release tag. English and Chinese documentation, installer assertions, release examples, and changelog copy will describe beta terminology and `v0.1.0-beta.1`.

The pending README hero update that adds the ClawChat conversation screenshot before the two Connect Client screenshots is part of the beta documentation payload.

## User Stories

1. As a maintainer, I want one local release-build command so that I can produce and inspect the current platform's distributable before tagging.
2. As a maintainer, I want the local artifact to contain the same executable, Client, Liveware, skills, changelog, license, and dependency notices as a published artifact.
3. As a maintainer, I want release builds to fail on an invalid or mismatched beta version so that an incorrect tag cannot publish.
4. As a user installing without a version argument, I want the installer to resolve the beta channel so that I receive the current supported prerelease.
5. As a user pinning an older release, I want explicit version installation to remain supported so that the beta-channel promotion does not remove rollback options.
6. As a release owner, I want a `v0.1.0-beta.1` tag to publish all six supported platform archives and advance the beta channel only after successful publication.

## Local Build Design

- Add `build:release` to `package.json`, implemented by `scripts/build-release.ts` rather than a long shell command.
- The command is current-platform only. Cross-platform publication remains owned by GitHub Actions.
- The script validates that `package.json.version` matches `<major>.<minor>.<patch>-beta.N` with a positive numeric beta sequence, so the command remains reusable after `0.1.0-beta.1`.
- The script runs the repository's deterministic core check, including generated-file consistency, formatting/linting, type checking, and unit tests.
- The script builds the production Client and current-platform compiled executable, then copies and verifies the matching vendored Liveware binary.
- The script stages `clawchat-connect`, `liveware`, `clawchat-connect-client`, `skills`, `CHANGELOG.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` using the platform-appropriate executable names.
- The output is `build/release/clawchat-connect-<platform>-<architecture>.tar.gz` on macOS/Linux or `.zip` on Windows.
- `build/release/` also receives `install.sh`, `install.ps1`, and `CHANGELOG.md`, plus `checksums.txt` covering the local archive and copied support files.
- The script recreates its exact owned `build/release/` output directory at startup so a rerun cannot mix stale artifacts into checksums. It never removes a broader build or workspace directory.
- Errors identify the failed phase and preserve the original child-process exit status.

## Release Automation Design

- Rename the alpha release workflow to beta terminology and trigger only on `v*-beta.*` tags.
- Verify that the pushed tag exactly matches `package.json.version` and that the version is a beta prerelease.
- Preserve the Windows smoke job, deterministic core checks, six-target compilation, Liveware verification, archive layouts, checksums, changelog-derived release notes, and GitHub prerelease behavior.
- Replace `latest-alpha.txt` assertions and publication with `latest-beta.txt`.
- Advance the beta channel only after the GitHub prerelease and all release assets succeed.
- Keep the release as a GitHub prerelease; beta promotion does not make `0.1.0` stable.

## Version and Documentation Design

- Set the package and generated Connect version to `0.1.0-beta.1` through the repository's established generated-file workflow.
- Add a `0.1.0-beta.1` changelog entry covering the Connect Client internationalization work, README showcase media, the local release build, and beta-channel promotion.
- Replace current-version examples in both READMEs with `v0.1.0-beta.1` and describe beta tags, workflow behavior, and `latest-beta.txt`.
- Update installer messages and tests that refer specifically to the alpha channel while retaining generic prerelease-version parsing.
- Add the pending ClawChat conversation screenshot as the first README screenshot, followed by the existing empty-state and active-Session Client screenshots.

## Testing and Release Gates

- Add focused tests for release-version validation, current platform/architecture naming, payload selection, archive naming, and failure propagation at the script boundary.
- Update release workflow and installer source assertions from alpha to beta.
- Treat local `bun run check`, package builds, release builds, installed WorkBuddy checks, and ClawChat/Liveware UI exercises as optional task-level verification. They are not prerequisites for creating or publishing a release tag and do not require a separate recorded qualification result.
- Keep the tag-triggered GitHub Actions workflow authoritative for deterministic code checks, Windows smoke coverage, cross-platform builds, installer syntax, packaging, and publication.
- Confirm the working tree is clean, commit and push the implementation, create and push `v0.1.0-beta.1`, then monitor the beta release workflow until every job succeeds.
- Verify the GitHub prerelease contains all six archives, both installers, changelog, and checksums, and verify `release-channel/latest-beta.txt` contains `v0.1.0-beta.1`.

## Failure Handling

- A local release build stops at the first failed check, build, verification, packaging, or checksum phase and publishes nothing.
- A tag/package version mismatch fails before compilation.
- A missing or checksum-invalid Liveware binary fails before packaging.
- A missing expected payload file fails packaging rather than creating a partial archive.
- The beta release channel is not advanced when the GitHub prerelease or any asset upload fails.
- Existing explicit-version installers remain the recovery path if the beta channel cannot advance.

## Out of Scope

- Building all six target archives on a maintainer workstation.
- Publishing stable `0.1.0` or removing GitHub prerelease status.
- Changing runtime, Session, Project, Liveware, or ClawChat protocol behavior.
- Repackaging or rebuilding the vendored Liveware companion.
- Adding Docker images, npm publication automation, or a second release channel selector.
- Deleting historical alpha releases or the historical `latest-alpha.txt` pointer.

## Success Criteria

1. `bun run build:release` creates one verified current-platform release archive and checksum metadata under `build/release/`.
2. `package.json` and generated version artifacts report `0.1.0-beta.1`.
3. Unversioned installers resolve `latest-beta.txt`; explicit historical versions remain valid.
4. `v0.1.0-beta.1` triggers the beta workflow and publishes all six supported platform archives.
5. The GitHub prerelease and beta channel pointer are verified after workflow completion.
6. README screenshots appear in the approved order: ClawChat conversation, empty Connect Client, active Codex Session.
