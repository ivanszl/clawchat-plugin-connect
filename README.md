# ClawChat Connect

`@clawling/clawchat-plugin-connect` binds ClawChat identities and conversations to local coding agents. Prebuilt releases run as standalone executables; Bun 1.3 or newer is only required for development from source.

- Connect manages multiple independent Agent Bindings; the first release provides a Codex Runtime Adapter.
- Codex runs directly through the official `@openai/codex-sdk`.
- Connect Sessions may use a reusable Connect-managed Project or an isolated Non-Project workspace.
- Connect does not expose tools or inject a bundled MCP server into Codex.

## Install

ClawChat Connect is currently alpha software. GitHub Releases are published as prereleases for macOS and Linux on arm64 and x64.

Install the current pinned alpha without Bun or Node.js:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
```

Install a specific alpha version or choose another user-writable installation directory:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | \
  CLAWCHAT_CONNECT_INSTALL_DIR="$HOME/bin" sh -s -- v0.1.0-alpha.3
```

The installer downloads the matching archive from GitHub Releases, verifies its SHA-256 checksum, and installs `clawchat-connect` to `~/.local/bin` by default. Add that directory to `PATH` if necessary. Connect expects the coding-agent executable selected by its Runtime Adapter to already be installed and available; it does not install coding agents.

Developers can instead install the Bun package directly:

```bash
bun add --global @clawling/clawchat-plugin-connect
```

## Configure an Agent Binding

An Agent Binding ID is an arbitrary local name. A Binding owns its activation, runtime configuration, Sessions, and Runtime Threads. Runtime Adapter selection comes from the explicit `kind`, never from the ID:

```bash
clawchat-connect init --agent work --kind codex
clawchat-connect activate work A1B2C3
```

After activation succeeds, Connect sets the ClawChat Profile nickname to the Agent Binding ID (`work` in this example). Install the native background service described below to start Connect; there is no foreground run command.

The activated account Profile can later be updated from the CLI. At least one field is required:

```bash
clawchat-connect profile update --agent work --nickname Luna
clawchat-connect profile update --agent work --avatar-url https://example.com/luna.png --bio "Local coding agent"
```

The Codex Runtime Adapter starts the user's existing Codex executable from `PATH` and uses normal Codex authentication and Session storage. To select a specific Codex executable:

```bash
clawchat-connect agent add work --kind codex --codex-path /absolute/path/to/codex
```

Codex configuration can also be edited in `~/.clawchat-connect/config.json`:

```json
{
  "defaultAgent": "work",
  "agents": {
    "work": {
      "kind": "codex",
      "model": "gpt-5-codex",
      "sandboxMode": "workspace-write",
      "modelReasoningEffort": "high",
      "approvalPolicy": "never",
      "webSearchMode": "live",
      "networkAccessEnabled": true
    }
  }
}
```

Supported Codex options include `codexPathOverride`, `env`, `model`, `sandboxMode`, `modelReasoningEffort`, `approvalPolicy`, `webSearchMode`, `networkAccessEnabled`, `skipGitRepoCheck`, and `additionalDirectories`.

The first release registers only `kind: "codex"`. Connect's Agent Binding model and runtime seam are not Codex-specific; later releases can register additional Runtime Adapters. Legacy agent shapes and unavailable runtime kinds are rejected rather than inferred or migrated.

## Background service

Connect can install itself as one native per-user background service. That Connect Service starts every activated Agent Binding and selects each Binding's Runtime Adapter independently. macOS uses a LaunchAgent and Linux uses a systemd user service; root access is not required. Install after configuring and activating at least one Agent Binding:

```bash
clawchat-connect service install
```

Installation starts Connect immediately, enables it for future user logins, stores the absolute config path, and captures the current `PATH` so Runtime Adapters can find their executables. Re-run `service install` after moving the Connect executable or changing the required `PATH`. Restart the service after adding or activating another Agent Binding.

Manage and inspect the service with:

```bash
clawchat-connect service start
clawchat-connect service stop
clawchat-connect service restart
clawchat-connect service status
clawchat-connect service logs
clawchat-connect service logs --lines 250 --follow
```

One Connect installation has exactly one service definition; Agent Bindings and Runtime Adapters never own system services. `stop` stops the current background process but retains its installed login configuration; `start` loads it again. Logs are stored below `~/.clawchat-connect/logs/` on macOS and in the user journal on Linux.

## Projects and Sessions

A Project is a named, reusable Connect workspace. Projects are global and may be used by Sessions from any Agent Binding.

```text
/project add connect /absolute/path/to/clawchat-plugin-connect
/project list
/project use connect
/project current
/project clear
/project remove connect
```

Rules:

- Sessions are scoped by ClawChat conversation and Agent Binding.
- A Session has zero or one Project.
- `/new`, `/project use`, and `/project clear` prepare the next Session without creating an empty Session.
- The first ordinary message consumes that pending selection and creates the Session; adopting an existing Runtime Thread with `/switch` creates one immediately because that thread already contains messages.
- Every Project change prepares a new Session and therefore a new Runtime Thread boundary once work begins.
- `/current` distinguishes a pending next Session from a current Session.
- `/list` shows Connect Sessions and resumable Codex Runtime Threads only for the selected workspace, by name plus a stable eight-character Session Ref.
- `/switch <name-or-ref>` returns to a Connect Session or explicitly imports a discovered Runtime Thread.
- A Project can only be removed while no Session or pending Session selection references it.

A Non-Project Session works immediately. Connect creates a deterministic isolated workspace below `~/.clawchat-connect/workspaces/`; it never falls back to the process working directory. Registered Project roots are explicit trusted workspaces, so Connect enables Codex's Git-repository-check bypass for both Project and Non-Project Sessions.

Codex accepts these Session modes:

```text
/mode read-only
/mode workspace-write
/mode danger-full-access
```

Changing mode invalidates the current Runtime Thread because the mode is a Codex thread option. Before a Session starts, `/mode` only updates the pending selection.

## Chat commands

Send Connect commands as standalone messages in the ClawChat conversation bound to the agent.

Command rules:

- `/help` is the single Connect help command and is never forwarded to a Runtime Adapter.
- Except for `/help`, control commands can only be used by the Agent Binding owner.
- Commands and ordinary turns are serialized per conversation. `/cancel` bypasses that queue so it can interrupt the active turn.
- Session state is scoped by ClawChat conversation and Agent Binding. Project definitions are global to the Connect installation.
- An unknown `/clawchat-*` command returns Connect help. Other unrecognized slash commands are forwarded to the coding agent.

### Help, status, and output

#### `/help`

Shows the Connect command summary. This command is available to every participant and does not create a Session.

#### `/status` and `/clawchat-status`

Shows the active Agent Binding, WebSocket connection state, active conversations, running turns, and queued turns. Both forms are equivalent.

```text
/status
```

#### `/clawchat-output minimal|normal|full`

Sets the persisted output visibility for the current ClawChat conversation:

| Mode | Visible output |
| --- | --- |
| `minimal` | Final answer only |
| `normal` | Final answer and assistant-visible output |
| `full` | All runtime, tool, progress, reasoning, and final output |

```text
/clawchat-output normal
```

Required control messages and runtime failures remain visible regardless of this setting.

### Session commands

Connect separates three pieces of state:

- A **Session Intent** is the pending name, Project, and mode for the next Session. It has no Session Ref or Runtime Thread.
- A **Session** is Connect's logical conversation and owns a stable eight-character Session Ref.
- A **Runtime Thread** is the coding agent's resumable conversation ID owned by a materialized Session.

#### `/new [name]`

Prepares a new Session Intent using the currently selected Project and mode. It does not create an empty Session. The first subsequent ordinary message materializes the Session and starts its Runtime Thread.

```text
/new
/new Fix login flow
```

If no name is supplied, Connect can derive one from the Runtime Thread's first user message. The previous Session remains resumable through `/list` and `/switch`.

#### `/current`

Shows one of the following:

- `Next Session (not started)` with the pending name, Project, and mode;
- the current materialized Session with its name, Ref, Project, and mode; or
- that no Session or pending selection exists.

```text
/current
```

#### `/list`

Lists materialized Connect Sessions and unclaimed resumable Runtime Threads for the selected workspace.

```text
/list
```

The output uses these markers:

- `(current)` identifies the current Connect Session.
- `(available) — Runtime Thread` identifies a discovered Runtime Thread that Connect has not adopted.
- Project selections list only Sessions and Runtime Threads from that Project root.
- A pending Non-Project selection lists no old Non-Project Sessions; a current Non-Project Session lists only itself.

Each entry has a Connect-owned eight-character Ref. Refs are stable selectors and do not expose or derive from internal UUIDs.

#### `/switch <name-or-ref>`

Switches to a materialized Connect Session or adopts an available Runtime Thread from the selected workspace.

```text
/switch WATT9U2E
/switch Fix login flow
```

Names and Refs must match exactly, ignoring letter case. If a name matches more than one item, Connect asks for the unambiguous Ref. Switching to an existing Session preserves its Runtime Thread. Adopting an available Runtime Thread immediately creates a materialized Connect Session because that thread already contains messages.

### Project commands

A Project is a named reusable workspace. Its root is passed to the Runtime Adapter as the working directory.

#### `/project add <name> <absolute-path>`

Registers a Project globally.

```text
/project add connect /Volumes/SAMSUNG/Projects/clawchat-plugin-connect
```

The root must be an existing absolute directory. Project names are case-insensitively unique, and the same canonical root cannot be registered twice. Project names cannot contain spaces.

#### `/project list`

Lists every registered Project with its ID and canonical root.

```text
/project list
```

#### `/project use <name-or-id>`

Selects a Project for the next Session. This creates or replaces a Session Intent; it does not create a Session or Runtime Thread.

```text
/project use connect
```

The selected name and mode are retained. Use `/new [name]` to choose a different Session name before sending the first ordinary message.

#### `/project current`

Shows the current Session's Project or the Project selected for the next Session.

```text
/project current
```

#### `/project clear`

Selects a deterministic isolated Non-Project workspace for the next Session. It creates or replaces a Session Intent without materializing a Session.

```text
/project clear
```

The isolated workspace is stored below `~/.clawchat-connect/workspaces/`; Connect never substitutes the service process's current directory.

#### `/project remove <name-or-id>`

Removes an unused Project definition.

```text
/project remove connect
```

Removal is rejected while any materialized Session or Session Intent references the Project. Removing a Project never deletes its directory or files.

### Runtime mode and cancellation

#### `/mode <mode>`

Sets the Runtime Adapter mode. The first-release Codex adapter accepts:

```text
/mode read-only
/mode workspace-write
/mode danger-full-access
```

For a Session Intent, the command only changes the pending mode. For a materialized Session, it keeps the Connect Session and Ref but invalidates the existing Runtime Thread because the sandbox mode is a thread startup option. The next ordinary message starts a new Runtime Thread with the selected mode.

#### `/cancel`

Attempts to abort the active turn for the current conversation.

```text
/cancel
```

If the Runtime Adapter supports cancellation, Connect aborts the active turn and confirms it. If no cancellable turn exists, Connect reports that without changing Session state.

### Example workflow

```text
/project add connect /Volumes/SAMSUNG/Projects/clawchat-plugin-connect
/project use connect
/new Review authentication
/mode workspace-write
Review the authentication implementation and report any security issues.
/current
/list
/switch WATT9U2E
```

The first four control commands only prepare the Session. The review request is the first ordinary message, so it materializes the Session and starts the Runtime Thread.

## Codex Runtime Threads and output

Connect stores the Codex thread ID on its owning logical Session. It resumes that Runtime Thread after a process restart or after `/switch` returns to the Session. For the current workspace, `/list` reads Codex's persisted history under `CODEX_HOME` (or `~/.codex`) and shows unclaimed Runtime Threads by their first user-message title and Session Ref. `/switch <name-or-ref>` explicitly adopts one into a new Connect Session while preserving that Ref. Refs are random Connect-owned Base32 handles, not prefixes of internal UUIDs. A Runtime Thread never crosses a Project boundary.

The official Codex SDK creates non-interactive Threads, which Codex omits from its default resume picker. To include them, run `codex resume --include-non-interactive` directly.

The Codex adapter maps official SDK events into ClawChat output kinds:

- agent messages → `assistant` and `final`
- reasoning → `reasoning`
- commands, file changes, and MCP calls → `tool`
- task lists, searches, and turn lifecycle → `progress`
- failures → visible `final` replies

The latest completed agent message is emitted exactly once as the final reply. `/cancel` aborts the active SDK turn through `AbortSignal`.

## External tools and MCP

Connect does not register ClawChat tools, run an MCP server, or inject MCP configuration into Codex. Profile mutation is an explicit host-side CLI operation backed by the activated Agent Binding credentials. Any MCP servers configured independently in the user's normal Codex environment remain outside Connect's ownership.

## State

- Config: `~/.clawchat-connect/config.json`
- SQLite state: `~/.clawchat-connect/state.sqlite` through Bun's built-in `bun:sqlite` (must be an absolute path)
- Non-Project workspaces: `~/.clawchat-connect/workspaces/`
- Codex Runtime Threads: normal Codex storage under `~/.codex/sessions`

Invite codes are not persisted. Credentials, Projects, pending Session selections, Session-to-Project associations, Runtime Thread IDs, message audit rows, output visibility, and runtime status are stored in SQLite.

## Development

Bun owns package installation, runtime execution, testing, and bundling. Source files use extensionless relative imports, `bun:test` runs the test suite, and `bun build --target=bun` creates the publishable CLI and library entrypoints.

```bash
bun install
bun run format
bun run lint
bun run typecheck
bun test
bun run build
bun run build:binary
```

Pushing a version tag such as `v0.1.0-alpha.3` runs the alpha release workflow. The workflow requires the tag to match `package.json`, runs the complete check suite, builds standalone macOS/Linux binaries for arm64 and x64, and publishes them with `install.sh` and SHA-256 checksums as a GitHub prerelease. Non-alpha tags are not accepted by this workflow.

The runtime uses Bun's built-in WebSocket client and `bun:sqlite`; it does not depend on `ws`, `sqlite`, `sqlite3`, Vitest, or tsup. Generated `dist/` output remains ignored.
