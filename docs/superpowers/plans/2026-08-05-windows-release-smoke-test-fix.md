# Windows Release Smoke Test Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the background-service smoke test portable across macOS, Linux, and Windows so the Windows release gate blocks only real product failures.

**Architecture:** Keep installer and production background-service behavior unchanged. Correct two expectations at the existing public seams: the systemd unit emitted by `manageBackgroundService` and the command array returned by `connectCommandForProcess`.

**Tech Stack:** Bun 1.3.x, TypeScript, `bun:test`, GitHub Actions Windows runner

## Global Constraints

- Do not modify `install.sh`, `install.ps1`, release workflow ordering, or production source.
- Do not skip or weaken the Windows smoke gate or PowerShell native-command fail-fast behavior.
- Keep tests at the existing `manageBackgroundService` and `connectCommandForProcess` public seams.
- Treat the next Windows GitHub Actions run as the authoritative cross-platform confirmation.
- Publishing or moving `v0.1.0-beta.1` is outside this change.

---

### Task 1: Make background-service expectations host-portable

**Files:**
- Modify: `tests/background-service.test.ts:76-99`
- Modify: `tests/background-service.test.ts:194-202`
- Keep unchanged: `src/service/background-service.ts`
- Keep unchanged: `install.sh`
- Keep unchanged: `install.ps1`

**Interfaces:**
- Consumes: `manageBackgroundService(request, dependencies): Promise<BackgroundServiceResult>`
- Consumes: `connectCommandForProcess(executablePath: string, entrypointPath: string): string[]`
- Produces: portable assertions over the generated systemd unit and Bun-compiled relaunch command

- [x] **Step 1: Confirm the existing Windows red baseline**

Use GitHub Actions run `30974179620`, job `92204733308`, or execute the following on a Windows runner:

```powershell
bun test tests/background-service.test.ts
```

Expected red result from the existing run:

```text
5 pass
2 fail
```

The failures must be the systemd `ExecStart` assertion receiving doubled Windows backslashes and the Bun-compiled executable assertion receiving `D:\opt\clawchat-connect` instead of `/opt/clawchat-connect`.

- [x] **Step 2: Correct the systemd unit expectation**

In `tests/background-service.test.ts`, replace the exact interpolation of `configPath` with an independently encoded quoted value:

```typescript
expect(unit).toContain(
  `ExecStart="/opt/Claw Chat/clawchat-connect" "service" "exec" "--config" ${JSON.stringify(configPath)}`,
);
```

`JSON.stringify` supplies a quoted literal with the same backslash representation required for this controlled path fixture. A production mutation that removes systemd backslash or quote escaping will still make the assertion fail.

- [x] **Step 3: Correct the Bun-compiled executable fixture**

Resolve the executable before passing it through the public function, so the test specifies entrypoint omission rather than hard-coding one host's absolute-path syntax:

```typescript
const executablePath = resolve("/opt/clawchat-connect");
expect(connectCommandForProcess(executablePath, "/$bunfs/root/clawchat-connect")).toEqual([executablePath]);
```

Keep the existing Windows-style `$bunfs` case unchanged.

- [x] **Step 4: Run the focused test**

Run:

```bash
bun test tests/background-service.test.ts
```

Expected: `7 pass`, `0 fail`.

- [x] **Step 5: Run the release contract tests**

Run:

```bash
bun test tests/build-release.test.ts tests/release-channel.test.ts tests/release-bundle.test.ts
```

Expected: all tests pass with zero failures.

- [x] **Step 6: Run the repository core gate**

Run:

```bash
bun run check:core
```

Expected: generated checks, Biome checks, both TypeScript projects, and the Bun test suite all pass.

- [x] **Step 7: Review scope and whitespace**

Run:

```bash
git diff --check
git diff -- tests/background-service.test.ts src/service/background-service.ts install.sh install.ps1 .github/workflows/release-beta.yml
```

Expected: no whitespace errors; only the two approved assertions change, with no diff in production source, installers, or the release workflow.

- [x] **Step 8: Commit the fix**

```bash
git add tests/background-service.test.ts docs/superpowers/plans/2026-08-05-windows-release-smoke-test-fix.md
git commit -m "test: make background service assertions portable"
```
