# Agent installation runbook

This document is written for an automation Agent installing ClawChat Connect on a user's computer. It covers installation, Agent Binding activation, background-service setup, Plugin selection, and optional private Liveware publication.

## Success criteria

The installation is complete only when:

1. `clawchat-connect doctor` reports `ok`.
2. `$HOME/.agents/skills/clawchat-core` and `$HOME/.agents/skills/clawchat-liveware` match the installed release manifest. `doctor` checks this; `clawchat-connect skills install` repairs both by force-overwriting them from the offline bundle.
3. `clawchat-connect service status` reports the native user service as running.
4. `clawchat-connect status --agent <id>` reports `activated: yes` and `runtime: connected`.
5. When the official Liveware Plugin is selected, the signed-in ClawChat account shows the Binding's private launcher and opening it loads the installed Connect Client through the shared gateway. Verify this in the real ClawChat surface; a mock or an unauthenticated HTTP probe is not acceptance evidence.

## Required inputs

- A ClawChat Agent invite code.
- An authenticated Codex CLI installation on the same computer.
- An Agent Binding ID. Use `work` unless the user provides another ID.
- macOS, Linux, or Windows 10/11 on arm64 or x64.

Never write the invite code to a file, commit it, print it, or enable shell tracing while it is present. Connect exchanges the code for credentials and does not persist the invite code.

## How Liveware starts

Do not run the official Plugin's `liveware` or `liveware.exe` companion directly.

Core starts the local Shared Client Gateway when the release-verified official Liveware Plugin acquires its first Client Exposure lease and stops it after the final lease is released. With the Plugin active, its `private` policy provisions one independent Binding Liveware Publication for every activated Binding and starts the Bundle's platform companion. Every Publication tunnels to the same Shared Client Gateway; the local Client remains available if the optional Plugin is missing or erroneous.

The capability accepts only `private` and `off`. `private` admits only the Installation Owner; `off` retires all Publications and releases the Plugin's gateway lease.

## macOS and Linux

Provide the invite code through `CLAWCHAT_INVITE_CODE`, then run the following script. Do not use `set -x`.

```bash
#!/bin/sh
set -eu

agent_id="${CLAWCHAT_AGENT_ID:-work}"
: "${CLAWCHAT_INVITE_CODE:?Set CLAWCHAT_INVITE_CODE before running this script}"

if ! actual_codex_version="$(codex --version 2>&1)" || [ -z "$actual_codex_version" ]; then
  printf 'Codex CLI is missing or did not return a version.\n' >&2
  exit 1
fi
printf 'Using %s\n' "$actual_codex_version"

curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh

connect_bin="${CLAWCHAT_CONNECT_BIN:-$HOME/.local/bin/clawchat-connect}"
if command -v clawchat-connect >/dev/null 2>&1; then
  connect_bin="$(command -v clawchat-connect)"
fi
if [ ! -x "$connect_bin" ]; then
  printf 'clawchat-connect was not found at %s\n' "$connect_bin" >&2
  exit 1
fi

config_path="${CLAWCHAT_CONNECT_CONFIG:-$HOME/.clawchat-connect/config.json}"
if [ -f "$config_path" ]; then
  if ! "$connect_bin" status --agent "$agent_id" >/dev/null 2>&1; then
    printf 'Config already exists but Agent Binding %s is not configured.\n' "$agent_id" >&2
    printf 'Set CLAWCHAT_AGENT_ID to an existing Binding or ask the user before changing the config.\n' >&2
    exit 1
  fi
else
  "$connect_bin" init
  "$connect_bin" plugin setup --non-interactive --select clawling.runtime.codex,clawling.exposure.liveware
  "$connect_bin" agent add "$agent_id" --plugin clawling.runtime.codex --capability codex
fi

"$connect_bin" activate "$agent_id" "$CLAWCHAT_INVITE_CODE"
unset CLAWCHAT_INVITE_CODE

"$connect_bin" doctor
"$connect_bin" service install

attempt=1
while [ "$attempt" -le 30 ]; do
  status_output="$("$connect_bin" status --agent "$agent_id" 2>&1 || true)"
  case "$status_output" in
    *"activated: yes"*"runtime: connected"*)
      printf '%s\n' "$status_output"
      "$connect_bin" service status
      exit 0
      ;;
  esac
  sleep 2
  attempt=$((attempt + 1))
done

printf 'Connect or Liveware did not become ready within 60 seconds.\n' >&2
"$connect_bin" status --agent "$agent_id" >&2 || true
"$connect_bin" service status >&2 || true
"$connect_bin" service logs --lines 100 >&2 || true
exit 1
```

Example invocation:

```bash
CLAWCHAT_INVITE_CODE='INVITE_CODE_FROM_CLAWCHAT' sh ./install-connect.sh
```

If Codex is not the executable on `PATH`, add `--codex-path /absolute/path/to/codex` to the `init` or `agent add` command.

On an existing installation, the script preserves the current Agent Binding configuration. Set `CLAWCHAT_AGENT_ID` to an existing Binding instead of overwriting its runtime preferences.

## Windows PowerShell

Set the invite code only in the current PowerShell process, then run:

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AgentId = if ($env:CLAWCHAT_AGENT_ID) { $env:CLAWCHAT_AGENT_ID } else { "work" }
if ([string]::IsNullOrWhiteSpace($env:CLAWCHAT_INVITE_CODE)) {
  throw "Set CLAWCHAT_INVITE_CODE before running this script"
}

$CodexOutput = & codex --version 2>&1
$CodexExitCode = $LASTEXITCODE
$ActualCodexVersion = ($CodexOutput | Out-String).Trim()
if ($CodexExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($ActualCodexVersion)) {
  throw "Codex CLI is missing or did not return a version"
}
Write-Output "Using $ActualCodexVersion"

Invoke-WebRequest `
  https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.ps1 `
  -OutFile install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

$Connect = Join-Path $env:LOCALAPPDATA "ClawChatConnect\bin\clawchat-connect.exe"
if (-not (Test-Path -LiteralPath $Connect)) {
  throw "clawchat-connect.exe was not found at $Connect"
}

$ConfigPath = if ($env:CLAWCHAT_CONNECT_CONFIG) {
  $env:CLAWCHAT_CONNECT_CONFIG
} else {
  Join-Path $HOME ".clawchat-connect\config.json"
}
if (Test-Path -LiteralPath $ConfigPath) {
  & $Connect status --agent $AgentId | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Config already exists but Agent Binding '$AgentId' is not configured. Set CLAWCHAT_AGENT_ID to an existing Binding or ask the user before changing the config."
  }
} else {
  & $Connect init
  if ($LASTEXITCODE -ne 0) { throw "Connect initialization failed" }
  & $Connect plugin setup --non-interactive --select clawling.runtime.codex,clawling.exposure.liveware
  if ($LASTEXITCODE -ne 0) { throw "Codex Runtime Plugin setup failed" }
  & $Connect agent add $AgentId --plugin clawling.runtime.codex --capability codex
  if ($LASTEXITCODE -ne 0) { throw "Agent Binding configuration failed" }
}

& $Connect activate $AgentId $env:CLAWCHAT_INVITE_CODE
if ($LASTEXITCODE -ne 0) { throw "ClawChat activation failed" }
Remove-Item Env:CLAWCHAT_INVITE_CODE

& $Connect doctor
if ($LASTEXITCODE -ne 0) { throw "Connect doctor failed" }

& $Connect service install
if ($LASTEXITCODE -ne 0) { throw "Connect Service installation failed" }

for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
  $StatusOutput = (& $Connect status --agent $AgentId 2>&1) -join "`n"
  if (
    $StatusOutput.Contains("activated: yes") -and
    $StatusOutput.Contains("runtime: connected")
  ) {
    Write-Output $StatusOutput
    & $Connect service status
    exit 0
  }
  Start-Sleep -Seconds 2
}

Write-Error "Connect or the selected Runtime did not become ready within 60 seconds."
& $Connect status --agent $AgentId
& $Connect service status
& $Connect service logs --lines 100
exit 1
```

## Existing installations

To update Connect, refresh the native service definition, and activate the selected Plugin versions:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
clawchat-connect service install
clawchat-connect service status
clawchat-connect status
```

On Windows, rerun `install.ps1`, then run the same `service install`, `service status`, and `status` commands from a new PowerShell window.

`service install` is intentional during an update: it refreshes the captured executable path and `PATH`, starts Connect, and keeps it enabled for future user logins.

## Liveware access policy

Use Connect Client's Plugin settings to configure the official `clawling.exposure.liveware/liveware` capability:

- `{ "accessPolicy": "private" }` publishes one owner-only App per activated Binding.
- `{ "accessPolicy": "off" }` persists retirement intent, retires every Binding Liveware Publication, and releases the Shared Client Gateway lease.

The capability has no `public` policy. Do not attempt to grant the installation-wide Client to arbitrary Plugin Bundles; only the release-verified official Bundle receives Core's privileged Client Exposure grant.

After changing the policy, verify the real signed-in ClawChat launcher state. For `private`, each activated Binding must have an independent App and tunnel that opens the same installed Client. For `off`, the launchers must be absent after retirement. Ordinary browser HTTP responses, including `401`, do not prove either behavior.

## Recovery

Run these commands in order:

```bash
clawchat-connect doctor
clawchat-connect status
clawchat-connect service status
clawchat-connect service restart
clawchat-connect service logs --lines 250
```

Interpret common failures as follows:

- `doctor` cannot find Liveware: reinstall Connect with the platform installer.
- Codex works in a terminal but not in the service: rerun `clawchat-connect service install` from that terminal.
- `activated: no`: obtain a new invite code and rerun `activate`.
- `liveware exposure: not active`: keep the service running, check network access, then restart the service to retry provisioning and tunnel startup.
- Local Connect works but Liveware fails: inspect the service logs. Liveware failure is isolated and does not stop the local Client.

Do not expose the unauthenticated Connect Client port to the public internet.
