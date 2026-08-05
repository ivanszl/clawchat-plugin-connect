# Windows Release Smoke Test Portability Design

## Context

The `v0.1.0-beta.1` release stopped before publication because
`tests/background-service.test.ts` failed on the Windows GitHub Actions runner.
Tag validation succeeded, but the archive builder and GitHub upload steps were
skipped. The installer itself was never executed by the failing smoke step.

The two failures come from test expectations that mix a simulated target
platform with the host platform's `node:path` behavior:

- the systemd unit assertion compares a Windows temporary path without the
  backslash escaping required in the generated unit;
- the Bun-compiled executable assertion hard-codes a POSIX result even though
  `connectCommandForProcess` resolves paths using the current host.

## Chosen approach

Change only the affected test expectations. Keep `install.sh`, `install.ps1`,
the release workflow, and production background-service behavior unchanged.

The existing public seams remain the test boundaries:

- `manageBackgroundService` is observed through the generated systemd unit;
- `connectCommandForProcess` is observed through its returned command array.

The systemd assertion will compare against the correctly quoted representation
of the actual fixture path. The Bun-compiled executable assertion will compare
against the host-resolved executable path while continuing to require that the
virtual `$bunfs` entrypoint is omitted.

## Alternatives rejected

- Inject target-specific path implementations into production code. This adds
  an abstraction that production does not need because the selected service
  platform and host platform are the same in real use.
- Skip Linux-oriented assertions on Windows. This would hide portability
  problems and reduce useful release-gate coverage.

## Error handling and scope

No runtime error handling changes. The release gate must continue to terminate
on any real Windows test failure through PowerShell native-command fail-fast
behavior. The fix must not weaken, skip, or reorder that gate.

## Verification

The existing failed Windows Actions invocation is the red baseline:

```text
bun test tests/background-service.test.ts
```

After the test correction:

1. Run the focused background-service test locally.
2. Run the release contract tests.
3. Run `bun run check:core`.
4. Confirm the diff changes only the approved test expectations and this design
   artifact.

The next Windows GitHub Actions run is the authoritative cross-platform
confirmation. Publishing or moving the existing tag is outside this change.

## Success criteria

- The two assertions describe host-independent behavior and retain their
  original behavioral coverage.
- No installer or production source file changes.
- Focused tests and `check:core` pass locally.
- No release gate is skipped or weakened.
