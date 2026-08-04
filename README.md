<div align="center">
  <p><strong>English</strong> | <a href="./README_zh.md">中文</a></p>
  <h1>ClawChat Connect</h1>
  <p><strong>Bring a coding agent running on your computer into any ClawChat conversation.</strong></p>
  <p>
    <a href="https://clawling.com/u/usr_01KPSPM0D3FFERFTYPY0PF8J2J"><img src="./docs/assets/clawchat.svg" alt="ClawChat" width="24" /></a><br />
    Author: <a href="https://clawling.com/u/usr_01KPSPM0D3FFERFTYPY0PF8J2J">Contact on ClawChat</a>
  </p>
  <p>
    <a href="https://github.com/XMethues/clawchat-plugin-connect/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/XMethues/clawchat-plugin-connect?include_prereleases&style=flat-square"></a>
    <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-4c8bf5?style=flat-square"></a>
    <img alt="Platforms: macOS, Linux, and Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-59636e?style=flat-square">
    <img alt="Runtimes: Codex, OpenCode, and WorkBuddy" src="https://img.shields.io/badge/runtimes-Codex%20%7C%20OpenCode%20%7C%20WorkBuddy-f97316?style=flat-square">
  </p>
  <p>
    <a href="#features">Features</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="#working-with-a-repository">Projects</a> ·
    <a href="#connect-client">Connect Client</a> ·
    <a href="#configuration">Configuration</a> ·
    <a href="#development">Development</a>
  </p>
</div>

---

ClawChat Connect is a local bridge between ClawChat and coding-agent runtimes. It keeps the agent, its credentials, project files, and runtime history on your computer while making the same persistent Sessions available from ClawChat and the browser-based Connect Client.

<p align="center">
  <img src="./docs/assets/clawchat-agent-conversation.png" alt="A ClawChat conversation with a connected local coding agent" width="60%" />
</p>

<p align="center">
  <img src="./docs/assets/connect-client-liveware-empty.png" alt="ClawChat Connect Client Liveware empty state" width="100%" />
</p>

<p align="center">
  <img src="./docs/assets/connect-client-liveware-session.png" alt="ClawChat Connect Client Liveware active Codex Session" width="100%" />
</p>

## Features

| Area | What Connect provides |
| --- | --- |
| Runtime Adapters | Connects to a user-installed Codex CLI or OpenCode executable without taking over runtime login, providers, plugins, or MCP configuration. |
| Persistent work | Resumes native Runtime Threads through stable Connect Sessions and reusable local Projects. |
| Shared conversation | Orders ClawChat and Connect Client turns in the same per-Session queue; separate Sessions can run concurrently. |
| Runtime controls | Discovers runtime-provided models and options, routes approvals and questions back to the originating surface, and supports cancellation. |
| Skill discovery | Shows supported runtime Skills in the Connect Client slash picker and preserves explicit Skill invocation as part of the submitted turn. |
| Rich input and output | Accepts images, audio, files, and video references from ClawChat, and safely returns supported local image output. |
| Multiple Agent Bindings | Keeps credentials, Sessions, Runtime instances, defaults, output visibility, and Liveware access isolated per Binding. |
| Local-first access | Runs as a native user service with a loopback Client by default, optional trusted-LAN access, and a Binding-scoped Liveware Exposure. |
| Agent-callable ClawChat operations | Separately ships tools and managed Agent skills for profile, social, messaging, Moments, and Liveware workflows. |

### Inside ClawChat

- **Start work from a conversation.** Send an ordinary message in a direct chat, or address the Agent with a structured mention in a group.
- **Control the active Session.** Create, list, and switch Sessions; select a local Project; inspect status; choose runtime model and mode; cancel an active turn; and control output visibility with slash commands.
- **Continue persistent runtime work.** Each ClawChat conversation and Agent Binding keeps its own current Session while native Runtime Threads remain resumable.
- **Handle runtime interactions in place.** Approvals and agent questions return to the direct or group conversation that started the turn.
- **Send and receive rich context.** ClawChat images, audio, files, and videos stay structured, and supported local image results are uploaded safely in the reply.
- **Use Connect Client without leaving ClawChat.** Each activated Binding can expose its Binding-scoped browser Client through a private or public Liveware App.

The ClawChat surface is for conversation-scoped work. Local Project registration, service administration, and other machine-level configuration stay in the terminal or Connect Client.

### Runtime support

| Runtime | Process owned by Connect | Session options | Native Runtime Thread lifecycle |
| --- | --- | --- | --- |
| Codex | `codex app-server` | model, reasoning effort, sandbox mode | discover, resume, cancel, archive, restore, delete |
| OpenCode | `opencode serve` | agent, provider-qualified model, variant | discover, resume, cancel, delete |
| WorkBuddy | desktop-owned Task ACP endpoint | Task-owned model, mode, configuration, Commands, Skills | discover, adopt, resume, cancel |

OpenCode compatibility is pinned to OpenCode `1.18.10`. WorkBuddy supports only the two exact desktop tuples documented in [WorkBuddy Runtime Adapter](./docs/workbuddy-adapter.md). Connect does not install or upgrade any runtime. See [Runtime Adapters](./docs/runtime-adapters.md) for the general capability boundary.

> [!IMPORTANT]
> ClawChat Connect is beta software. Review [Local data and security](#local-data-and-security) before enabling trusted-LAN or public Liveware access.

## Requirements

Before installing Connect, you need:

1. A ClawChat account and an Agent invite code.
2. At least one supported coding-agent runtime installed and authenticated on the same computer.
3. macOS, Linux, or Windows 10/11 on arm64 or x64.

Check the runtime you plan to use:

```bash
codex --version
# or
opencode --version
```

Connect uses the runtime's existing login, configuration, providers, plugins, MCP servers, and native Session storage. Codex must expose the required app-server interface; OpenCode must be version `1.18.10`. Connect does not install, authenticate, or reconfigure either runtime.

## Quick start

### Install with an Agent

Copy and send this prompt to your coding Agent:

```text
Install the latest ClawChat Connect release on this computer. Read and follow https://github.com/XMethues/clawchat-plugin-connect/blob/main/install.md before taking action. Reuse an existing configuration when present; do not overwrite it. Install and start the native Connect Service and its managed Liveware, then verify doctor, service status, runtime connection, and Liveware exposure. Ask me for an Agent invite code only if activation is required, and never print, store, or commit the invite code. Continue until every success criterion in install.md passes, then report the installed version and final status.
```

### 1. Install Connect

On macOS or Linux, the standalone installer does not require Bun or Node.js:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
```

Standalone releases include the pinned, unmodified Liveware companion for the selected platform. Connect installs it beside `clawchat-connect`; no separate Liveware repository checkout, build, login, or installation is required.

The installer resolves the latest published GitHub release at runtime, including prereleases. Pass a version explicitly only when you need to pin an installation.

The default executable location is `~/.local/bin`. If it is not already on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

To install a specific release or choose another directory:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | \
  CLAWCHAT_CONNECT_INSTALL_DIR="$HOME/bin" sh -s -- v0.1.0-beta.1
```

On Windows PowerShell, download and inspect the installer before running it:

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.ps1 `
  -OutFile install.ps1

powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The Windows installer verifies the Release ZIP checksum, installs `clawchat-connect.exe`, `liveware.exe`, and Client assets under `%LOCALAPPDATA%\ClawChatConnect\bin`, and adds that directory to the current user's persistent `PATH`. Install a specific release or directory with:

```powershell
.\install.ps1 `
  -Version v0.1.0-beta.1 `
  -InstallDirectory "D:\Tools\ClawChatConnect"
```

Developers may install the Bun package instead:

```bash
bun add --global @clawling/clawchat-plugin-connect
```

Update an existing installation to the latest published release:

```bash
clawchat-connect update
```

Use `clawchat-connect update --version v0.1.0-beta.1` to install a specific release. The update command preserves the existing configuration and refreshes the native Connect Service. Historical versions remain installable when explicitly specified.

### 2. Create the first Agent Binding

`work` is a local name; choose any short name you want. Select the Runtime Adapter that matches your installed coding agent:

```bash
# Codex
clawchat-connect init --agent work --kind codex

# OpenCode 1.18.10
clawchat-connect init --agent work --kind opencode
```

If the runtime executable is not available on the service `PATH`, pass its absolute path:

```bash
clawchat-connect init --agent work --kind codex --runtime-path /absolute/path/to/codex
```

`init` creates a new configuration. On an existing installation, use `agent add` to update a Binding instead of running `init` again:

```bash
clawchat-connect agent add work --kind codex --runtime-path /absolute/path/to/codex
```

`--codex-path` remains available as a compatibility alias for Codex Bindings.

### 3. Activate the Binding

Use the invite code issued by ClawChat:

```bash
clawchat-connect activate work YOUR_INVITE_CODE
```

Connect stores the returned credentials, not the invite code, and updates the ClawChat Profile nickname to the Binding ID (`work` in this example).

One Connect installation can activate multiple ClawChat accounts and mix Runtime Adapter kinds:

```bash
clawchat-connect agent add personal --kind codex
clawchat-connect activate personal PERSONAL_ACCOUNT_INVITE_CODE

clawchat-connect agent add work --kind opencode
clawchat-connect activate work WORK_ACCOUNT_INVITE_CODE
clawchat-connect service restart
```

Each Binding owns independent credentials, Sessions, Runtime instance, and Liveware Exposure. Projects remain installation-global and may be shared deliberately. Reactivating a Binding may refresh the same ClawChat account, but it cannot assign that Binding's existing history to a different account.

Connect Service provisions or adopts one Binding-named `ClawChat Connect · <binding-id>` Liveware App per activated Binding after its Binding-Scoped Client Gateway is ready. Existing singleton `ClawChat Connect` Apps remain adopted during migration. The default Liveware Access Policy is `private`, so only that Binding Owner can open its App. Activation itself never publishes the installation-wide Client port.

One ClawChat account may own multiple Agent Bindings in an installation. Reactivating the same Binding with the same account refreshes its credentials.
For an occupied Binding, Connect sends the stored Agent user ID through ClawChat's atomic re-pair path; a code from another Owner is rejected by ClawChat before it is consumed, and Connect preserves the existing local credentials if the returned identity violates that contract.

### 4. Install the background service

```bash
clawchat-connect service install
clawchat-connect service status
```

Installation starts Connect immediately and enables it for future logins. Connect runs as a native per-user LaunchAgent on macOS, systemd user service on Linux, or current-user Task Scheduler task on Windows; administrator/root access is not required.

There is no foreground `run` command. The background service owns the ClawChat WebSocket connection, Runtime Adapter processes, browser client, and bundled Liveware companion.

### 5. Send a message

Open the activated Agent conversation in ClawChat and send an ordinary message. Without a selected Project, Connect creates an isolated workspace under `~/.clawchat-connect/workspaces/` and starts a persistent runtime Session automatically.

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

Connect Client can browse directories on the Connect Service host, create a folder, and register it as a Project. The new-Session dialog can stage the same operation and creates the folder, Project, and Session only when you confirm the Session. Then select the Project and Session options in ClawChat:

The directory picker exposes host directory names and structure, but not file contents, to anyone who can open the Client. This includes users admitted by a public Liveware Exposure or trusted-LAN access.

```text
/project connect
/new Review authentication
/mode workspace-write
/model
/model MODEL_ID high
Review the authentication implementation and report any security issues.
```

`/project`, `/new`, `/mode`, and `/model` prepare a Session Intent. The first ordinary message atomically creates the Session and starts its native Runtime Thread. `/model` with no argument lists the models and reasoning options advertised by the selected Runtime Adapter. Runtime-specific options such as an OpenCode agent or variant are also available in Connect Client.

Local Project administration:

| Command | Purpose |
| --- | --- |
| `clawchat-connect project add <absolute-path>` | Register a root-named Project. |
| `clawchat-connect project list` | List Projects with their local paths. |
| `clawchat-connect project remove <workspace-id>` | Remove an unused Project definition; files and Runtime Threads are never deleted. |

A Project cannot be removed while a Session or pending Session selection references it.

## Sessions and chat commands

Connect keeps one current Session per ClawChat conversation and Agent Binding. A Session owns a stable eight-character Ref and, once started, a resumable native Runtime Thread.

Send these as standalone ClawChat messages. In a direct conversation, use the forms shown below. In a group, prefix a command with a leading structured mention of the Agent and one space, for example `@Agent /help`. A group slash command without that addressing mention is ignored as a command and may be handled as ordinary Agent input.

| Command | Purpose |
| --- | --- |
| `/help` | Show the command summary. |
| `/status` | Show the current/pending Session, effective options, connection, and turn status. |
| `/new [name]` | Prepare a new Session for the next ordinary message. |
| `/sessions` | List Sessions and available Runtime Threads in the selected workspace. |
| `/switch <name-or-ref>` | Resume a Session or adopt an available Runtime Thread. |
| `/project [workspace-id\|none]` | Show synchronized Projects, select one by Workspace ID, or select an isolated Non-Project workspace. |
| `/model [model-id [reasoning-effort]\|default]` | Show or set the Session model and effort; `default` restores inheritance. |
| `/mode [mode\|default]` | Show or set a mode advertised by the Runtime Adapter; `default` restores inheritance. Codex provides `read-only`, `workspace-write`, and `danger-full-access`. |
| `/cancel` | Interrupt the active runtime turn when possible. |
| `/clawchat-output <mode>` | Set ClawChat output to `minimal`, `normal`, or `full`. |

`/help` is available to every participant. Other Connect control commands require the Agent Binding owner. Removed forms such as `/list`, `/current`, `/clawchat-status`, and `/project add|list|use|current|clear|remove` fail with a pointer to `/help`; they are not forwarded to the coding agent. Unknown `/clawchat-*` commands show Connect help, while unrelated slash commands are passed through.

Output visibility is scoped to the Agent Binding: a chat override applies only to that Binding even when another Agent is present in the same ClawChat conversation. Binding settings inherit the installation default until explicitly changed.

Runtime approvals and questions stay in the direct or group conversation whose turn created them. Direct responses use `/approve`, `/approve session`, `/deny`, `/N`, or `/answer <text>`; group responses use the same exact lowercase, single-line forms after `@Agent `. For now, any participant in the originating group may answer an Interaction, including a Session-level approval. Connect controls remain restricted to the receiving Binding's Binding Owner.

The effective model is resolved for every turn: Session override → Agent Binding default → Runtime Adapter default. The secondary model option is Codex reasoning effort or OpenCode variant. An unavailable saved Session selection fails visibly instead of silently falling back. Changing an in-place model option keeps the same Runtime Thread; changing a boundary-forming mode starts a new Runtime Thread.

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

The browser client can:

- create and switch Sessions, select Projects, and inspect native runtime transcripts;
- choose the Runtime Adapter's model, mode, agent, effort, or variant options;
- discover runtime commands and Skills from the composer's slash picker;
- attach supported media, submit follow-up turns, and withdraw a queued turn back into the composer;
- archive, restore, or permanently delete Sessions when the selected Runtime Adapter supports that action.

Browser-originated turns stay local to Connect and are not posted into ClawChat.

Browser and ClawChat turns targeting the same Session are strictly ordered. Different Sessions may run concurrently, including two Sessions associated with one ClawChat conversation, up to `maxConcurrentTurns`.

### ClawChat access through Liveware

Each activated Binding exposes its own `ClawChat Connect` launcher in its ClawChat account. The local loopback Client can manage every Binding, but a Liveware-opened Client can read and mutate only the Binding that owns that Exposure. Projects remain shared; Sessions, transcripts, messages, events, and Runtime state do not cross the gateway boundary.

Choose who Liveware admits, then restart the service:

```bash
# Binding Owner only (default)
clawchat-connect config set livewareAccessPolicy private

# Any authenticated ClawChat user who can open the Liveware App
clawchat-connect config set livewareAccessPolicy public

# Unregister and retire the Liveware Exposure
clawchat-connect config set livewareAccessPolicy off

clawchat-connect service restart
```

To remove a Binding, its Liveware App and local history, stop using its ID and confirm the destructive command:

```bash
clawchat-connect agent remove work --yes
```

Removal stops Connect Service, retires only that Binding's Liveware Exposure, deletes its credentials and Binding-scoped local data, and preserves shared Projects and other Bindings. The Binding ID may then be reused.

### Trusted LAN access

To make the browser client reachable from another device on a trusted private network:

```bash
clawchat-connect config set clientHost 0.0.0.0
clawchat-connect service restart
```

Then open `http://<computer-LAN-IP>:47823/`.

LAN mode has no authentication or TLS. Anyone who can reach the port can enumerate host directory names and structure, read Sessions, manage Project paths and runtime preferences, and submit local coding-agent turns. Never expose it to the internet. Return to loopback mode with:

```bash
clawchat-connect config set clientHost 127.0.0.1
clawchat-connect service restart
```

Set a different port with `clawchat-connect config set clientPort 47824` (allowed range: 1024–65535).

## Media support

Incoming ClawChat media remains structured:

- images, audio, files, and videos are downloaded to the Connect-owned cache with their MIME type and safe filename;
- the selected Runtime Adapter submits supported media as native inputs and surfaces model/provider rejection without silent conversion;
- each download is limited to 100 MiB;
- the cache is limited to 512 MiB and expires files after 15 days without access.

When a runtime returns a local Markdown image, Connect uploads it to ClawChat if:

- it is inside the resolved Project workspace or the Connect media cache; and
- its extension and file signature identify PNG, JPEG, GIF, or WebP content.

Other local paths remain text and are not uploaded.

Untrusted media URLs must use HTTPS and resolve to public addresses. Redirects are revalidated. The configured ClawChat API and media origins are trusted explicitly so private self-hosted deployments continue to work.

## Configuration

The default configuration file is `~/.clawchat-connect/config.json`. Inspect it with:

```bash
clawchat-connect config get
clawchat-connect config get agents.work.sandboxMode
```

Common Codex settings can be changed from the CLI:

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

Codex Binding values:

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

Every Binding also supports `displayName` and `executablePathOverride`. OpenCode agent, provider-qualified model, and variant defaults live in the Binding's `sessionOptions` object; Connect Client discovers and validates the available values from the running OpenCode instance. Edit JSON directly for `sessionOptions`, `env`, and `additionalDirectories`.

Example with both released Runtime Adapters:

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
    },
    "personal": {
      "kind": "opencode",
      "displayName": "Personal OpenCode",
      "executablePathOverride": "/absolute/path/to/opencode",
      "sessionOptions": {
        "agent": "YOUR_OPENCODE_AGENT"
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
| `clawchat-connect tool list` | List the 24 Agent-callable ClawChat tool names. |
| `clawchat-connect tool describe <name>` | Show one tool's generated input schema. |
| `clawchat-connect tool call <name> --input-json <json-or->` | Submit one at-most-once tool request to the running Service. |
| `clawchat-connect liveware app ...` | Manage an additional Agent-owned Liveware App through the Service. |
| `clawchat-connect liveware tunnel ...` | Bind or unbind a loopback service and synchronize its ClawChat registration. |
| `clawchat-connect skills install` | Force-repair the two bundled user-scope Agent skills. |
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

`service install` captures the current executable path and `PATH`. Run it again after moving Connect or changing the `PATH` needed to find a configured runtime.

## Troubleshooting

Start with:

```bash
clawchat-connect doctor
clawchat-connect status
clawchat-connect service status
clawchat-connect service logs --lines 250
```

Common causes:

- **A runtime cannot start:** run `codex --version` or `opencode --version`, confirm the runtime is authenticated, and inspect the initialization error. Use `agents.<id>.executablePathOverride` when Connect should launch a different executable.
- **A runtime works in a terminal but not in Connect:** reinstall the service so it captures the current `PATH`.
- **OpenCode reports a version mismatch:** install the supported OpenCode `1.18.10`; Connect deliberately refuses unverified versions.
- **Windows service does not start:** run `clawchat-connect service install` again from a terminal where the configured runtime works, then inspect `clawchat-connect service logs`.
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
| Native Runtime Threads | Runtime-owned storage, such as `~/.codex/sessions/` for Codex |

On Windows, Connect data uses `%USERPROFILE%\.clawchat-connect\`, while the standalone binaries and notices default to `%LOCALAPPDATA%\ClawChatConnect\`.

Invite codes are not persisted. Connect does not expose its ClawChat tools to the coding-agent runtime, run an MCP server, or inject MCP configuration. MCP servers already configured in the selected runtime remain under that runtime's ownership.

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

Run the OpenCode capability and native Session lifecycle integration with:

```bash
OPENCODE_EXECUTABLE=/absolute/path/to/opencode bun run test:integration:opencode
```

Create a lighter, unpackaged standalone build with `bun run build:binary`; it verifies the vendored host-platform Liveware asset's SHA-256 and places it beside the Connect executable under `dist/`. Windows builds use `.exe` names. Preview the browser client with `bun run preview:web`.

Create a distributable release for the current host with `bun run build:release`. It writes the archive, installers, `CHANGELOG.md`, and SHA-256 checksums under `build/release/`.

Version tags such as `v0.1.0-beta.1` run the beta release workflow, which checks the tag against `package.json`, runs deterministic code checks, verifies all six vendored Liveware assets, and uses GitHub Actions to compile macOS, Linux, and Windows arm64/x64 binaries. Installed WorkBuddy, ClawChat, and Liveware UI qualification runs locally before tagging and never sends native Task configuration to GitHub Actions. macOS/Linux are published as `.tar.gz`; Windows is published as `.zip` with `install.ps1`. After all assets are published, the workflow advances the API-independent `release-channel/latest-beta.txt` pointer used by default installs and updates. npm packages include all six assets so a global Bun install remains portable.

## License

ClawChat Connect is available under the [MIT License](LICENSE). Bundled dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
