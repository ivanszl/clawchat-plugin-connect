# Final Beta Release Review Fix Report

Status: **DONE_WITH_CONCERNS**

Implementation commit: `fix(release): harden beta publication gates` (this commit).

Scope stayed inside `.worktrees/beta-release-build`. No tag, push, GitHub release, or release-channel mutation was performed. Client browser tests were not run, as requested.

## Findings addressed

### 1. PowerShell native-command failures now stop the workflow

- Every command-bearing PowerShell step in the Windows smoke job explicitly uses `shell: pwsh`.
- Each block starts with both `$ErrorActionPreference = "Stop"` and `$PSNativeCommandUseErrorActionPreference = $true`, including dependency installation, verification/tests, syntax validation, and Windows compilation/smoke execution.
- `tests/release-channel.test.ts` parses the workflow, fixes the command-step inventory, and requires both settings to be the first two lines of every block.

### 2. Existing-release recovery rejects drafts

- `scripts/release-beta.ts` requests structured `gh release view` JSON fields `tagName,isPrerelease,isDraft,assets` using an argument array.
- Recovery succeeds only for the exact tag, `isPrerelease: true`, `isDraft: false`, and the exact ten-asset inventory.
- Missing or malformed `isDraft` data fails closed. A draft-release regression test proves that no create or recovery mutation follows.
- Exact argv assertions protect the `isDraft` query from being silently dropped.

### 3. Beta/tag validation precedes Windows compilation

- A lightweight Ubuntu `validate` job checks the exact pushed tag against `package.json` and requires `X.Y.Z-beta.N`, with positive non-zero `N`.
- `windows-smoke` has `needs: validate`.
- `release` has `needs: [validate, windows-smoke]`.
- The duplicated late validation step was removed from `release`, leaving one unambiguous gate.
- Parsed-workflow tests assert the complete validation script, both dependency edges, absence of a duplicate release validation step, and continued presence of the Windows compilation step.

### 4. Agent install prompts name the beta channel

- The English copyable prompt now begins: `Install the current beta-channel ClawChat Connect release on this computer.`
- The Chinese prompt now begins: `在这台电脑上安装 ClawChat Connect 当前 beta 通道版本。`
- The remainder of both prompts is unchanged, and documentation contract assertions cover both sentences.

### 5. Hermetic CLI isolation remains intact

Commit `115c81b` is intentionally preserved. Its `tests/cli.test.ts` change is test-only hermetic isolation, motivated by ambient Agent selection encountered during qualification. It changes no production behavior and was not reverted or modified in this wave.

## TDD and mutation evidence

The public seams were the parsed GitHub Actions workflow and the exported release publisher exercised through a controlled `gh` command runner.

Initial red command:

```console
bun test tests/release-channel.test.ts tests/release-bundle.test.ts
```

Result against the pre-fix implementation: **33 pass, 7 fail**. Failures covered missing PowerShell fail-fast settings, missing validation job/dependencies, release-view argv without `isDraft`, accepted draft recovery, and both README prompts.

First green focused result after implementation: **41 pass, 0 fail**.

Each executable safeguard was then removed independently, its owning test was run, and the safeguard was restored:

| Mutation | Owning test result |
| --- | --- |
| Remove `$PSNativeCommandUseErrorActionPreference` from a native-command block | FAIL: expected the two fail-fast lines at the block start |
| Remove `!existing.draft` from immutable recovery | FAIL: draft prerelease unexpectedly resolved |
| Remove `isDraft` from the `gh release view --json` field list | FAIL: exact argv mismatch |
| Remove `windows-smoke.needs: validate` | FAIL: validation dependency missing |
| Remove `validate` from `release.needs` | FAIL: exact dependency list mismatch |
| Remove the tag/package equality command | FAIL: exact validation script mismatch |
| Change the beta regex to alpha | FAIL: exact beta validation mismatch |

After restoration, the full focused release command passed:

```console
bun test tests/build-release.test.ts tests/release-channel.test.ts tests/release-bundle.test.ts
```

Result: **57 pass, 0 fail, 207 expectations**.

## Final verification

| Command | Result |
| --- | --- |
| `env -u CLAWCHAT_CONNECT_AGENT_ID bun run check:core` | PASS: generated check, repository Biome, both TypeScript projects, **738 tests / 0 failures / 7,183 expectations** |
| `bun run check:generated` | PASS |
| `bunx biome check .` | PASS: 196 files, no fixes |
| `bun run typecheck` | PASS: service and web TypeScript projects |
| `sh -n install.sh scripts/package-release-archive.sh scripts/package-windows-release.sh scripts/verify-liveware-bundle.sh` | PASS |
| Bun YAML parse plus exact validation dependency assertions for `.github/workflows/release-beta.yml` | PASS |
| `git diff --check` | PASS |

The first `check:core` attempt stopped before tests because Biome rejected the workflow test's initial literal-string representation and requested canonical formatting. The test was rewritten without suspicious placeholder-like string fragments, formatted, and the complete gate was rerun successfully from the start.

## Self-review

- All four Windows command steps are explicitly PowerShell and carry both fail-fast preferences before any command.
- Validation is a dependency gate, so invalid tag/package metadata cannot reach Windows compilation.
- Existing release recovery is read-only and exact across tag, prerelease, draft, and asset inventory.
- `gh` arguments remain an array; no shell quoting or mutation-capable upload/edit/clobber path was introduced.
- README changes alter only the requested beta-channel wording.
- No Client browser test or external publication operation ran.

## Concern

The qualification host is macOS arm64 and has no `pwsh` executable. Native PowerShell execution therefore could not be repeated locally. The workflow syntax and contracts are parsed locally, and the native verification/build blocks remain scheduled on GitHub's `windows-latest` runner.
