# ClawChat Connect

`@clawling/clawchat-plugin-connect` is a Bun-native CLI that binds ClawChat identities and conversations to local coding agents. It requires Bun 1.3 or newer.

- Connect manages multiple independent Agent Bindings; the first release provides a Codex Runtime Adapter.
- Codex runs directly through the official `@openai/codex-sdk`.
- Connect Sessions may use a reusable Connect-managed Project or an isolated Non-Project workspace.
- Connect does not expose tools or inject a bundled MCP server into Codex.

## Install

```bash
bun add --global @clawling/clawchat-plugin-connect
```

## Configure an Agent Binding

An Agent Binding ID is an arbitrary local name. A Binding owns its activation, runtime configuration, Sessions, and Runtime Threads. Runtime Adapter selection comes from the explicit `kind`, never from the ID:

```bash
clawchat-connect init --agent work --kind codex
clawchat-connect activate work A1B2C3
clawchat-connect run --agent work
```

After activation succeeds, Connect sets the ClawChat Profile nickname to the Agent Binding ID (`work` in this example).

The activated account Profile can later be updated from the CLI. At least one field is required:

```bash
clawchat-connect profile update --agent work --nickname Luna
clawchat-connect profile update --agent work --avatar-url https://example.com/luna.png --bio "Local coding agent"
```

Codex runs under Bun, starts its bundled Codex CLI, and uses normal Codex authentication and Session storage. To select a specific Codex executable:

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
- `/new` starts a new Session using the current Project association.
- `/project use` starts a new Project Session; it never mutates the existing Session.
- `/project clear` starts a new Non-Project Session.
- Every Project change creates a new Session and therefore a new Runtime Thread boundary.
- `/switch` can return to an earlier Session and resume its persisted Runtime Thread.
- A Project can only be removed while no Session references it.

A Non-Project Session works immediately. Connect creates a deterministic isolated workspace below `~/.clawchat-connect/workspaces/`; it never falls back to the process working directory. Registered Project roots are explicit trusted workspaces, so Connect enables Codex's Git-repository-check bypass for both Project and Non-Project Sessions.

Codex accepts these Session modes:

```text
/mode read-only
/mode workspace-write
/mode danger-full-access
```

Changing mode invalidates the current Runtime Thread because the mode is a Codex thread option.

## Chat commands

- `/clawchat-help`
- `/clawchat-output minimal|normal|full`
- `/status`
- `/new [name]`
- `/list`
- `/switch <session>`
- `/current`
- `/project add <name> <absolute-path>`
- `/project list`
- `/project use <name-or-id>`
- `/project current`
- `/project clear`
- `/project remove <name-or-id>`
- `/mode <mode>`
- `/cancel`

Except for help, Connect control commands are restricted to the Agent Binding owner. `/cancel` bypasses the normal per-chat lifecycle queue so it can interrupt an active turn; other commands and turns are serialized per chat.

## Codex Runtime Threads and output

Connect stores the Codex thread ID on its owning logical Session. It resumes that Runtime Thread after a process restart or after `/switch` returns to the Session. A Runtime Thread never crosses a Project boundary.

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

Invite codes are not persisted. Credentials, Projects, Session-to-Project associations, Runtime Thread IDs, message audit rows, output visibility, and runtime status are stored in SQLite.

## Development

Bun owns package installation, runtime execution, testing, and bundling. Source files use extensionless relative imports, `bun:test` runs the test suite, and `bun build --target=bun` creates the publishable CLI and library entrypoints.

```bash
bun install
bun run format
bun run lint
bun run typecheck
bun test
bun run build
```

The runtime uses Bun's built-in WebSocket client and `bun:sqlite`; it does not depend on `ws`, `sqlite`, `sqlite3`, Vitest, or tsup. Generated `dist/` output remains ignored.
