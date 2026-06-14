# ClawChat Connect Architecture

## Process model

`clawchat-connect` ships one package with separate entrypoints:

    clawchat-connect run
      ClawChat Protocol v2 WebSocket client
      inbound message normalization
      chat command routing
      ACP runtime dispatch
      materialized message replies

    clawchat-connect mcp-server --agent <agentId>
      stdio MCP server spawned by Claude/Codex/OpenCode
      exposes 26 shared clawchat_* tools

The WebSocket service and MCP server are separate processes because stdio MCP requires clean stdin/stdout JSON-RPC. Logs from the WebSocket service must never share the MCP stdout stream.

## Layering

    src/cli.ts                  CLI commands and service startup
    src/ws-client.ts            Protocol v2 WebSocket handshake, ack/error handling
    src/message-mapper.ts       ClawChat message fragment mapping
    src/chat-commands.ts        Chat command router
    src/runtime/acp-adapter.ts  Only @agentclientprotocol/sdk import boundary
    src/runtime/connect-runtime.ts Session queue + ACP turn dispatch
    src/tools/schema.ts         26 tool names and zod schemas
    src/tools/registry.ts       Shared tool handlers and audit
    src/tools/bridge.ts         Best-effort ACP dynamic tool registration
    src/mcp/server.ts           Only @modelcontextprotocol/sdk import boundary
    src/api-client.ts           ClawChat REST/media client
    src/state.ts                sqlite/sqlite3 operational state

## Tool exposure policy

- The tool registry is the source of truth.
- `src/mcp/server.ts` exposes that registry through `@modelcontextprotocol/sdk` v1 stdio transport.
- `src/tools/bridge.ts` may register tools with ACP runtimes only when the runtime explicitly supports dynamic tools.
- Unsupported ACP dynamic tool registration is not fatal; the user should configure the stdio MCP server.
- Skills are documentation/guidance only. They must not be treated as executable tool installation.

## Agent-only v1

Config contains `agents` and `defaultAgent`. It does not contain `projects` or `defaultProject`. Working directory lives in runtime session state and is set from chat via `/dir` or `/cd`.

## Output policy

The runtime buffers ACP output into complete materialized ClawChat `message.reply` frames. It does not use Protocol streaming lifecycle events in v1.

Output visibility is resolved in this order:

1. per-chat override from SQLite
2. JSON config default
3. `normal`

Required controls always remain visible. In group chats, required controls route to the owner direct route and never silently fall back to group delivery.

## Persistence

JSON config is user-editable. SQLite stores credentials, device id, sessions, output visibility, message audit/idempotency, tool audit, and runtime status.

Use `sqlite` + `sqlite3`; do not use `node:sqlite` or `better-sqlite3`.
