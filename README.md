# ClawChat Connect

ClawChat Connect lets a ClawChat conversation use a coding agent running on your own computer.

The current alpha release supports:

- Codex CLI through `codex app-server`;
- macOS and Linux on arm64 and x64;
- persistent Sessions and reusable Project workspaces;
- image, audio, file, and video input from ClawChat;
- image replies from local Codex output;
- a local browser client for viewing Sessions and sending private local turns.

Only the Codex Runtime Adapter is included today, so a current installation can have one Codex Agent Binding. The runtime interface is adapter-based, but other coding agents are not yet released.

## Requirements

Before installing Connect, you need:

1. A ClawChat account and an Agent invite code.
2. `codex-cli 0.145.0` installed and authenticated on the same computer.
3. macOS or Linux. Windows is not currently packaged.

Check the Codex version:

```bash
codex --version
```

Connect requires exactly `codex-cli 0.145.0`. It uses your existing Codex login, configuration, MCP servers, and `~/.codex/sessions` storage. Connect does not install or reconfigure Codex.

## Quick start

### 1. Install Connect

The standalone installer does not require Bun or Node.js:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
```

The default executable location is `~/.local/bin`. If it is not already on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

To install a specific release or choose another directory:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | \
  CLAWCHAT_CONNECT_INSTALL_DIR="$HOME/bin" sh -s -- v0.1.0-alpha.4
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

### 4. Install the background service

```bash
clawchat-connect service install
clawchat-connect service status
```

Installation starts Connect immediately and enables it for future logins. Connect runs as a native per-user LaunchAgent on macOS or systemd user service on Linux; root access is not required.

There is no foreground `run` command. The background service owns the ClawChat WebSocket connection, Codex app-server process, and browser client.

### 5. Send a message

Open the activated Agent conversation in ClawChat and send an ordinary message. Without a selected Project, Connect creates an isolated workspace under `~/.clawchat-connect/workspaces/` and starts a persistent Codex Session automatically.

For example:

```text
Explain what this repository does and suggest the first improvement.
```

## Working with a repository

Project paths are local-machine administration, so register them in the terminal or Connect Client—not in ClawChat:

```bash
clawchat-connect project add connect /absolute/path/to/clawchat-plugin-connect
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
| `clawchat-connect project add <name> <absolute-path> [--additional-directory <path>]` | Register a Project and optional trusted additional directories. |
| `clawchat-connect project list` | List Projects with their local paths. |
| `clawchat-connect project remove <name-or-id>` | Remove an unused Project definition; files are never deleted. |

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
| `/project [name-or-id\|none]` | Show registered Project names, select one, or select an isolated Non-Project workspace. |
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

The browser client can create a Session by choosing its Project, mode, model, reasoning effort, and first task together. It can also inspect Sessions, read native Codex transcripts, change Session model options, manage Projects, and send more turns. Browser-originated turns stay local to Connect and are not posted into ClawChat.

Browser and ClawChat turns targeting the same Session are strictly ordered. Different Sessions may run concurrently, including two Sessions associated with one ClawChat conversation, up to `maxConcurrentTurns`.

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
| `approvalPolicy` | `never`, `on-request`, `untrusted` |
| `webSearchMode` | `disabled`, `cached`, `live` |
| `networkAccessEnabled` | `true`, `false` |

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
| `clawchat-connect status [--agent <id>]` | Show activation and runtime status. |
| `clawchat-connect doctor` | Check basic configuration. |
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

- **Codex version rejected:** install exactly `codex-cli 0.145.0`, or set `agents.<id>.codexPathOverride` to the correct executable.
- **Codex works in a terminal but not in Connect:** reinstall the service so it captures the current `PATH`.
- **Configuration changed but behavior did not:** restart the service.
- **Browser client does not open:** confirm the service is running, then use `clawchat-connect web --no-open` and open the printed URL.
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

Create a standalone binary with `bun run build:binary`. Preview the browser client with `bun run preview:web`.

Version tags such as `v0.1.0-alpha.4` run the alpha release workflow, which checks the tag against `package.json`, runs tests and the real Codex integration, builds macOS/Linux archives, and publishes checksums and license notices as a GitHub prerelease.

## License

ClawChat Connect is available under the [MIT License](LICENSE). Bundled dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
