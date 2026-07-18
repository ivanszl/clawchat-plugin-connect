# ClawChat Connect

`@clawling/clawchat-plugin-connect` is a Bun-native CLI that connects ClawChat conversations to local coding agents. It requires Bun 1.3 or newer.

- Codex uses the official `@openai/codex-sdk` directly.
- Other agents can use Agent Client Protocol (ACP) runtimes.
- All runtimes share the same ClawChat session, output, persistence, and tool behavior.

## Install

```bash
bun add --global @clawling/clawchat-plugin-connect
```

## Configure Codex

Codex is a first-party runtime and does not need an ACP command or `codex-acp`:

```bash
clawchat-connect init --agent codex
clawchat-connect activate codex A1B2C3
clawchat-connect run --agent codex
```

The SDK runs under Bun, starts its bundled Codex CLI, and uses the normal Codex authentication and session directories. If a specific local Codex executable is required, configure it explicitly:

```bash
clawchat-connect agent add work --kind codex --codex-path /absolute/path/to/codex
```

Codex configuration can also be edited in `~/.clawchat-connect/config.json`:

```json
{
  "defaultAgent": "codex",
  "agents": {
    "codex": {
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

Legacy agent ID `codex` configurations that launch bare `codex` or `@agentclientprotocol/codex-acp` are normalized to the first-party Codex runtime.

## Configure another ACP agent

Generic ACP agents still use an executable command:

```bash
clawchat-connect agent add my-agent --kind acp --command my-acp-server
```

For commands that require arguments, edit the agent's `command` and `args` fields in the JSON configuration.

## Working directories and sessions

v1 is agent-only. There are no projects and no `/project` command. The working directory belongs to the current ClawChat session:

```text
/dir /absolute/path/to/repo
/cd /absolute/path/to/repo
```

If a session has no directory, Connect replies with setup instructions and does not dispatch the turn.

Codex thread IDs are stored with the logical ClawChat session. Connect resumes the thread after a process restart or after switching back to a previous session. `/dir` and `/mode` invalidate the current runtime thread because they change its startup options; `/new` and `/switch` preserve older thread IDs.

Codex accepts these runtime modes:

```text
/mode read-only
/mode workspace-write
/mode danger-full-access
```

## Chat commands

- `/clawchat-output minimal|normal|full`
- `/status`
- `/new [name]`
- `/list`
- `/switch <session>`
- `/current`
- `/dir [path|reset]`
- `/cd <path>`
- `/mode <mode>`
- `/cancel`

## Codex streaming output

The Codex adapter maps official SDK events into ClawChat output kinds:

- agent messages → `assistant` and `final`
- reasoning → `reasoning`
- commands, file changes, and MCP calls → `tool`
- task lists, searches, and turn lifecycle → `progress`
- failures → visible `final` replies

The latest completed agent message is emitted exactly once as the final reply. `/cancel` aborts the active SDK turn through `AbortSignal`.

## Tools

Connect implements the shared 26 `clawchat_*` tools once in `src/tools/*`.

### Codex

Every Codex SDK session receives an in-memory `mcp_servers.clawchat_connect` override. Codex starts:

```bash
clawchat-connect mcp-server --agent <agentId> --config <configPath>
```

The override carries the active ClawChat chat and state paths. Connect does **not** modify `~/.codex/config.toml`.

### Other clients

The same registry remains available as a portable stdio MCP server:

```bash
clawchat-connect mcp-server --agent <agentId>
```

ACP runtimes may also receive best-effort dynamic tool registration when they explicitly support it.

Skills are optional guidance, not tool execution. Do not install tools into skill directories.

## State and config

- Config: `~/.clawchat-connect/config.json`
- SQLite state: `~/.clawchat-connect/state.sqlite` through Bun's built-in `bun:sqlite`
- Codex threads: normal Codex session storage under `~/.codex/sessions`

Invite codes are not persisted. Credentials, runtime thread IDs, operational audit rows, output visibility, and runtime status are stored in SQLite.

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

The runtime uses Bun's built-in WebSocket client and `bun:sqlite`; it does not depend on `ws`, `sqlite`, `sqlite3`, Vitest, or tsup.
