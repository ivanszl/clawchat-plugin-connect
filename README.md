<div align="center">
  <p><strong>English</strong> | <a href="./README_zh.md">中文</a></p>
  <a href="https://clawling.com/chat/"><img src="./docs/assets/clawchat.svg" alt="ClawChat logo" width="152" /></a>
  <h1>ClawChat Connect</h1>
  <p><strong>Bring a coding agent running on your computer into any ClawChat conversation.</strong></p>
  <p>
    <a href="https://github.com/clawling/clawchat-plugin-connect/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/clawling/clawchat-plugin-connect?include_prereleases&style=flat-square"></a>
    <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-4c8bf5?style=flat-square"></a>
    <img alt="Platforms: macOS, Linux, and Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-59636e?style=flat-square">
    <img alt="Runtime: Codex CLI" src="https://img.shields.io/badge/runtime-Codex%20CLI-f97316?style=flat-square">
  </p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#working-with-a-repository">Projects</a> ·
    <a href="#connect-client">Connect Client</a> ·
    <a href="#configuration">Configuration</a> ·
    <a href="#development">Development</a>
  </p>
</div>

---

ClawChat Connect is a local bridge between ClawChat and coding-agent runtimes. It keeps the agent, its credentials, project files, and runtime history on your computer while making the same persistent Sessions available from ClawChat and the browser-based Connect Client.

## Highlights

- **Chat from anywhere.** Start or resume local coding work from a ClawChat conversation.
- **Keep projects local.** Project paths and Runtime Threads stay on the machine running Connect.
- **Continue across surfaces.** ClawChat and Connect Client turns share the same ordered Session.
- **Bring rich context.** Send images, audio, files, and video references to Codex.
- **Choose your access.** Use loopback by default, a trusted LAN explicitly, or a Liveware Exposure in ClawChat.
- **Run as a native user service.** No administrator/root access is required.

The current alpha release supports:

- Codex CLI through `codex app-server`;
- macOS, Linux, and Windows on arm64 and x64;
- persistent Sessions and reusable Project workspaces;
- image, audio, file, and video input from ClawChat;
- image replies from local Codex output;
- a local browser client for viewing Sessions and sending private local turns.

Only the Codex Runtime Adapter is included today, so a current installation can have one Codex Agent Binding. The runtime interface is adapter-based, but other coding agents are not yet released.

> [!IMPORTANT]
> ClawChat Connect is alpha software. Review [Local data and security](#local-data-and-security) before enabling trusted-LAN or public Liveware access.

## Requirements

Before installing Connect, you need:

1. A ClawChat account and an Agent invite code.
2. Codex CLI installed and authenticated on the same computer.
3. macOS, Linux, or Windows 10/11 on arm64 or x64.

Check the Codex version:

```bash
codex --version
```

Connect accepts any Codex CLI version that can start the required app-server interface. It uses your existing Codex login, configuration, MCP servers, and `~/.codex/sessions` storage. Connect does not install or reconfigure Codex.

## Quick start

### Install with an Agent

Copy and send this prompt to your coding Agent:

```text
Install the latest ClawChat Connect release on this computer. Read and follow https://github.com/clawling/clawchat-plugin-connect/blob/main/install.md before taking action. Reuse an existing configuration when present; do not overwrite it. Install and start the native Connect Service and its managed Liveware, then verify doctor, service status, runtime connection, and Liveware exposure. Ask me for an Agent invite code only if activation is required, and never print, store, or commit the invite code. Continue until every success criterion in install.md passes, then report the installed version and final status.
```

### 1. Install Connect

On macOS or Linux, the standalone installer does not require Bun or Node.js:

```bash
curl -fsSL https://raw.githubusercontent.com/clawling/clawchat-plugin-connect/main/install.sh | sh
```

Standalone releases include the pinned, unmodified Liveware companion for the selected platform. Connect installs it beside `clawchat-connect`; no separate Liveware repository checkout, build, login, or installation is required.

The installer resolves the latest published GitHub release at runtime, including prereleases. Pass a version explicitly only when you need to pin an installation.

The default executable location is `~/.local/bin`. If it is not already on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

To install a specific release or choose another directory:

```bash
curl -fsSL https://raw.githubusercontent.com/clawling/clawchat-plugin-connect/main/install.sh | \
  CLAWCHAT_CONNECT_INSTALL_DIR="$HOME/bin" sh -s -- v0.1.0-alpha.15
```

On Windows PowerShell, download and inspect the installer before running it:

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/clawling/clawchat-plugin-connect/main/install.ps1 `
  -OutFile install.ps1

powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The Windows installer verifies the Release ZIP checksum, installs `clawchat-connect.exe`, `liveware.exe`, and Client assets under `%LOCALAPPDATA%\ClawChatConnect\bin`, and adds that directory to the current user's persistent `PATH`. Install a specific release or directory with:

```powershell
.\install.ps1 `
  -Version v0.1.0-alpha.15 `
  -InstallDirectory "D:\Tools\ClawChatConnect"
```

Developers may install the Bun package instead:

```bash
bun add --global @clawling/clawchat-plugin-connect
```

### 2. Create the first Agent Binding

`work` is a local name; choose any short name you want:

```bash
clawchat-connect init --agent work --kind codex
```

If `codex` is not the executable you want Connect to launch:

```bash
clawchat-connect init --agent work --kind codex --codex-path /absolute/path/to/codex
```

`init` creates a new configuration. On an existing installation, use `agent add` to update a Binding instead of running `init` again:

```bash
clawchat-connect agent add work --kind codex --codex-path /absolute/path/to/codex
```

### 3. Activate the Binding

Use the invite code issued by ClawChat:

```bash
clawchat-connect activate work YOUR_INVITE_CODE
```

Connect stores the returned credentials, not the invite code, and updates the ClawChat Profile nickname to the Binding ID (`work` in this example).

Activation also provisions (or adopts) one Liveware App named `ClawChat Connect`, binds it to the local Client Interface, and registers it with the activated ClawChat Agent. The default Liveware Access Policy is `private`, so only the Connect Owner can open it from ClawChat. Liveware synchronization failures do not discard the saved activation; restarting the Connect Service retries them.

### 4. Install the background service

```bash
clawchat-connect service install
clawchat-connect service status
```

Installation starts Connect immediately and enables it for future logins. Connect runs as a native per-user LaunchAgent on macOS, systemd user service on Linux, or current-user Task Scheduler task on Windows; administrator/root access is not required.

There is no foreground `run` command. The background service owns the ClawChat WebSocket connection, Codex app-server process, browser client, and bundled Liveware companion.

### 5. Send a message

Open the activated Agent conversation in ClawChat and send an ordinary message. Without a selected Project, Connect creates an isolated workspace under `~/.clawchat-connect/workspaces/` and starts a persistent Codex Session automatically.

For example:

```text
Explain what this repository does and suggest the first improvement.
```

## Working with a repository

Project paths are local-machine administration, so register them in the terminal or Connect Client—not in ClawChat:

```bash
clawchat-connect project add /absolute/path/to/clawchat-plugin-connect
clawchat-connect project list
```

Use `--additional-directory /absolute/path` more than once when a Project needs other trusted writable roots. Then select the Project and Session options in ClawChat:

```text
/project connect
/new Review authentication
/mode workspace-write
/model
/model MODEL_ID high
Review the authentication implementation and report any security issues.
```

`/project`, `/new`, `/mode`, and `/model` prepare a Session Intent. The first ordinary message atomically creates the Session and starts its Codex Runtime Thread. `/model` with no argument lists the models and reasoning efforts advertised by the installed Runtime Adapter.

Local Project administration:

| Command | Purpose |
| --- | --- |
| `clawchat-connect project add <absolute-path> [--additional-directory <path>]` | Register a root-named Project and optional trusted additional directories. |
| `clawchat-connect project list` | List Projects with their local paths. |
| `clawchat-connect project remove <workspace-id>` | Remove an unused Project definition; files and Runtime Threads are never deleted. |

A Project cannot be removed while a Session or pending Session selection references it.

## Sessions and chat commands

Connect keeps one current Session per ClawChat conversation and Agent Binding. A Session owns a stable eight-character Ref and, once started, a resumable Codex Runtime Thread.

Send these as standalone ClawChat messages:

| Command | Purpose |
| --- | --- |
| `/help` | Show the command summary. |
| `/status` | Show the current/pending Session, effective options, connection, and turn status. |
| `/new [name]` | Prepare a new Session for the next ordinary message. |
| `/sessions` | List Sessions and available Runtime Threads in the selected workspace. |
| `/switch <name-or-ref>` | Resume a Session or adopt an available Runtime Thread. |
| `/project [workspace-id\|none]` | Show synchronized Projects, select one by Workspace ID, or select an isolated Non-Project workspace. |
| `/model [model-id [reasoning-effort]\|default]` | Show or set the Session model and effort; `default` restores inheritance. |
| `/mode [mode\|default]` | Show or set `read-only`, `workspace-write`, or `danger-full-access`; `default` restores inheritance. |
| `/cancel` | Interrupt the active Codex turn when possible. |
| `/clawchat-output <mode>` | Set ClawChat output to `minimal`, `normal`, or `full`. |

`/help` is available to every participant. Other Connect control commands require the Agent Binding owner. Removed forms such as `/list`, `/current`, `/clawchat-status`, and `/project add|list|use|current|clear|remove` fail with a pointer to `/help`; they are not forwarded to the coding agent. Unknown `/clawchat-*` commands show Connect help, while unrelated slash commands are passed through.

The effective model is resolved for every turn: Session override → Agent Binding default → Runtime Adapter default. Reasoning effort resolves separately: Session override → a valid Agent Binding effort → the model's advertised default. An unavailable saved Session selection fails visibly instead of silently falling back; an invalid Binding effort falls back to the advertised default because it is only a default. Changing a model keeps the same Runtime Thread; changing the mode of a materialized Session starts a new Runtime Thread boundary.

Output modes:

| Mode | ClawChat receives |
| --- | --- |
| `minimal` | Final answer only. |
| `normal` | Final answer and assistant-visible output. |
| `full` | Tool, progress, reasoning, assistant, and final output. |

Failures and required control messages remain visible in every mode.

## Connect Client

The service exposes a browser client at `http://127.0.0.1:47823/` by default:

```bash
clawchat-connect web
```

Use `--no-open` to print the URL without opening a browser:

```bash
clawchat-connect web --no-open
```

The browser client can create an empty Session by choosing its Project, mode, model, and reasoning effort, then submit its first task from the Session composer. It can also inspect Sessions, read native Codex transcripts, change Session model options, manage Projects, and send more turns. Browser-originated turns stay local to Connect and are not posted into ClawChat.

Browser and ClawChat turns targeting the same Session are strictly ordered. Different Sessions may run concurrently, including two Sessions associated with one ClawChat conversation, up to `maxConcurrentTurns`.

### ClawChat access through Liveware

The activated Agent exposes `ClawChat Connect` in ClawChat. Its URL tunnels to the same complete Connect Client that is available locally; Connect does not add a second permissions layer or remove capabilities from the remote view.

Choose who Liveware admits, then restart the service:

```bash
# Connect Owner only (default)
clawchat-connect config set livewareAccessPolicy private

# Any authenticated ClawChat user who can open the Liveware App
clawchat-connect config set livewareAccessPolicy public

# Unregister and retire the Liveware Exposure
clawchat-connect config set livewareAccessPolicy off

clawchat-connect service restart
```

Changing the Connect Owner replaces the previous activation: Connect unregisters and retires the previous owner's Liveware App, preserves local Projects, Sessions, and Runtime Threads, and provisions a new App for the replacement owner. The public URL may change.

### Trusted LAN access

To make the browser client reachable from another device on a trusted private network:

```bash
clawchat-connect config set clientHost 0.0.0.0
clawchat-connect service restart
```

Then open `http://<computer-LAN-IP>:47823/`.

LAN mode has no authentication or TLS. Anyone who can reach the port can read Sessions, manage Project paths and model preferences, and submit local Codex turns with the modes exposed by the Runtime Adapter. Never expose it to the internet. Return to loopback mode with:

```bash
clawchat-connect config set clientHost 127.0.0.1
clawchat-connect service restart
```

Set a different port with `clawchat-connect config set clientPort 47824` (allowed range: 1024–65535).

## Media support

Incoming ClawChat media remains structured:

- images and audio are downloaded to the Connect-owned cache and submitted to Codex as native local inputs;
- files and videos are downloaded and included as local file references in the Codex prompt;
- each download is limited to 100 MiB;
- the cache is limited to 512 MiB and expires files after 15 days without access.

When Codex returns a local Markdown image, Connect uploads it to ClawChat if:

- it is inside the resolved Project workspace, an allowed additional directory, or the Connect media cache; and
- its extension and file signature identify PNG, JPEG, GIF, or WebP content.

Other local paths remain text and are not uploaded.

Untrusted media URLs must use HTTPS and resolve to public addresses. Redirects are revalidated. The configured ClawChat API and media origins are trusted explicitly so private self-hosted deployments continue to work.

## Configuration

The default configuration file is `~/.clawchat-connect/config.json`. Inspect it with:

```bash
clawchat-connect config get
clawchat-connect config get agents.work.sandboxMode
```

Common settings can be changed from the CLI:

```bash
clawchat-connect config set livewareAccessPolicy private
clawchat-connect config set agents.work.model YOUR_MODEL_ID
clawchat-connect config set agents.work.sandboxMode workspace-write
clawchat-connect config set agents.work.modelReasoningEffort high
clawchat-connect config set agents.work.approvalPolicy on-request
clawchat-connect config set agents.work.webSearchMode live
clawchat-connect config set agents.work.networkAccessEnabled true
clawchat-connect service restart
```

Supported Codex values:

| Setting | Values |
| --- | --- |
| `sandboxMode` | `read-only`, `workspace-write`, `danger-full-access` |
| `modelReasoningEffort` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| `approvalPolicy` | `never`, `on-request` (default), `untrusted` |
| `webSearchMode` | `disabled`, `cached`, `live` |
| `networkAccessEnabled` | `true`, `false` |

Installation-wide values:

| Setting | Values |
| --- | --- |
| `livewareAccessPolicy` | `private` (default), `public`, `off` |
| `clientHost` | `127.0.0.1`, `0.0.0.0` |
| `clientPort` | `1024`–`65535` |

Edit JSON directly for `env` and `additionalDirectories`, which are intentionally not exposed by `config set`:

```json
{
  "defaultAgent": "work",
  "maxConcurrentTurns": 4,
  "maxPendingPerSession": 20,
  "agents": {
    "work": {
      "kind": "codex",
      "displayName": "Work Codex",
      "codexPathOverride": "/absolute/path/to/codex",
      "sandboxMode": "workspace-write",
      "modelReasoningEffort": "high",
      "approvalPolicy": "on-request",
      "webSearchMode": "live",
      "networkAccessEnabled": true,
      "additionalDirectories": ["/absolute/path/to/shared-library"],
      "env": {
        "EXAMPLE_VARIABLE": "value"
      }
    }
  }
}
```

Restart the service after changing runtime or endpoint configuration.

### Self-hosted ClawChat

Configure the HTTP and WebSocket endpoints before activation:

```bash
clawchat-connect config set baseUrl https://clawchat.example.com
clawchat-connect config set websocketUrl wss://clawchat.example.com/ws
```

`mediaUploadUrl` defaults to `/media/upload` on `baseUrl`. Override it only when media is served separately:

```bash
clawchat-connect config set mediaUploadUrl https://media.example.com/media/upload
```

## Service and account commands

| Command | Purpose |
| --- | --- |
| `clawchat-connect status [--agent <id>]` | Show activation, runtime, and Liveware Exposure status. |
| `clawchat-connect doctor` | Check basic configuration and the bundled Liveware executable. |
| `clawchat-connect agent list` | List configured Agent Bindings. |
| `clawchat-connect agent remove <id>` | Remove a local Binding configuration. |
| `clawchat-connect service start` | Start the installed service. |
| `clawchat-connect service stop` | Stop it without uninstalling it. |
| `clawchat-connect service restart` | Restart after configuration changes. |
| `clawchat-connect service status` | Show native service status. |
| `clawchat-connect service logs` | Show recent logs. |
| `clawchat-connect service logs --lines 250 --follow` | Follow service logs. |

Update the activated ClawChat Profile with at least one field:

```bash
clawchat-connect profile update --agent work --nickname Luna
clawchat-connect profile update --agent work --avatar-url https://example.com/luna.png --bio "Local coding agent"
```

`service install` captures the current executable path and `PATH`. Run it again after moving Connect or changing the `PATH` needed to find Codex.

## Troubleshooting

Start with:

```bash
clawchat-connect doctor
clawchat-connect status
clawchat-connect service status
clawchat-connect service logs --lines 250
```

Common causes:

- **Codex cannot start:** run `codex --version`, confirm Codex is authenticated, and inspect the app-server initialization error. Use `agents.<id>.codexPathOverride` when Connect should launch a different executable.
- **Codex works in a terminal but not in Connect:** reinstall the service so it captures the current `PATH`.
- **Windows service does not start:** run `clawchat-connect service install` again from a terminal where `codex` works, then inspect `clawchat-connect service logs`.
- **Configuration changed but behavior did not:** restart the service.
- **Browser client does not open:** confirm the service is running, then use `clawchat-connect web --no-open` and open the printed URL.
- **ClawChat does not show `ClawChat Connect`:** run `clawchat-connect status`, then restart the service and inspect its logs for `Liveware Exposure`.
- **Local Connect works but Liveware does not:** this is intentional failure isolation. Run `clawchat-connect doctor` to verify the bundled executable, then restart the service to retry registration and the tunnel.
- **A Project cannot be removed:** switch away from it and remove any pending/current Session references first.

## Local data and security

| Data | Default location |
| --- | --- |
| Configuration | `~/.clawchat-connect/config.json` |
| SQLite state and credentials | `~/.clawchat-connect/state.sqlite` |
| Service logs on macOS | `~/.clawchat-connect/logs/` |
| Isolated Non-Project workspaces | `~/.clawchat-connect/workspaces/` |
| Downloaded media cache | `~/.clawchat-connect/media-cache/` |
| Codex Runtime Threads | `~/.codex/sessions/` |

On Windows, Connect data uses `%USERPROFILE%\.clawchat-connect\`, while the standalone binaries and notices default to `%LOCALAPPDATA%\ClawChatConnect\`.

Invite codes are not persisted. Connect does not expose tools, run an MCP server, or inject MCP configuration into Codex. MCP servers already configured in the user's Codex environment remain under Codex's ownership.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and LAN/media security guidance. See [docs/architecture.md](docs/architecture.md) for protocol, reliability, and module design details.

## Development

Development requires the Bun version pinned in `package.json`:

```bash
bun install --frozen-lockfile
bun run check
bun run clean && bun run build
```

`bun run check` includes a headless Connect Client interaction test. It automatically uses Brave or Chrome when installed; set `BRAVE_PATH` or `CHROMIUM_PATH` for a nonstandard executable location. CI installs Playwright Chromium.

Run the real Codex model-catalog and same-Runtime-Thread model-switch test with:

```bash
CODEX_INTEGRATION_PATH=/absolute/path/to/codex bun run test:integration:codex
```

Create a local standalone bundle with `bun run build:binary`; it verifies the vendored host-platform Liveware asset's SHA-256 and places it beside the Connect executable under `dist/`. Windows builds use `.exe` names. Preview the browser client with `bun run preview:web`.

Version tags such as `v0.1.0-alpha.15` run the alpha release workflow, which checks the tag against `package.json`, runs tests and the real Codex integration, verifies all six vendored Liveware assets, and uses GitHub Actions to compile macOS, Linux, and Windows arm64/x64 binaries. macOS/Linux are published as `.tar.gz`; Windows is published as `.zip` with `install.ps1`. Both installers resolve the latest published release unless a version is explicitly supplied. npm packages include all six assets so a global Bun install remains portable.

## License

ClawChat Connect is available under the [MIT License](LICENSE). Bundled dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
