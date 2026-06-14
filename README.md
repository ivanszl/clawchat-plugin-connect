# ClawChat Connect

`@clawling/clawchat-plugin-connect` connects ClawChat conversations to local ACP-capable agents such as Claude Code, Codex, and OpenCode.

## Install

    npm install -g @clawling/clawchat-plugin-connect

## Configure an agent

    clawchat-connect init --agent codex --command codex
    clawchat-connect activate codex A1B2C3
    clawchat-connect run --agent codex

`init` only creates JSON config. It does not activate, start WebSocket, set a working directory, start an agent, or create/select a project.

## Working directories

v1 is agent-only. There are no projects and no `/project` command. Working directory is chat/session state:

    /dir /absolute/path/to/repo
    /cd /absolute/path/to/repo

If a session has no directory, Connect replies with `/dir /absolute/path/to/repo` instructions and does not dispatch the turn to ACP.

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

## Tools

Connect implements the shared 26 `clawchat_*` tools once in `src/tools/*` and exposes them through:

1. `clawchat-connect mcp-server --agent <agentId>` — v1 portable stdio MCP surface.
2. Best-effort ACP dynamic registration when a runtime supports it.

The MCP server is stdio. Agent clients spawn it as their own subprocess; users normally configure it once and do not manually keep it running.

### Claude Code MCP

    claude mcp add-json clawchat-connect '{"type":"stdio","command":"clawchat-connect","args":["mcp-server","--agent","claude"]}' --scope user

Project `.mcp.json` equivalent:

    {
      "mcpServers": {
        "clawchat-connect": {
          "type": "stdio",
          "command": "clawchat-connect",
          "args": ["mcp-server", "--agent", "claude"]
        }
      }
    }

### Codex MCP

Add to Codex MCP config:

    [mcp_servers.clawchat_connect]
    command = "clawchat-connect"
    args = ["mcp-server", "--agent", "codex"]

### OpenCode MCP

Add to `opencode.jsonc`:

    {
      "mcp": {
        "clawchat-connect": {
          "type": "local",
          "command": ["clawchat-connect", "mcp-server", "--agent", "opencode"],
          "enabled": true
        }
      }
    }

## Skills

Skills are optional guidance, not tool execution. Do not install tools into skill directories. Use MCP for tools.

If a helper skill is added later, install it to the agent's native skill discovery path:

- Claude Code: `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/clawchat/SKILL.md`
- Codex: `~/.agents/skills/clawchat/SKILL.md`
- OpenCode: `~/.agents/skills/clawchat/SKILL.md` or `~/.config/opencode/skills/clawchat/SKILL.md`

The helper skill should explain ClawChat context and fallback behavior only.

## State and config

- Config: `~/.clawchat-connect/config.json`
- SQLite state: `~/.clawchat-connect/state.sqlite`

Invite codes are not persisted. Credentials and operational audit rows are stored in SQLite.
