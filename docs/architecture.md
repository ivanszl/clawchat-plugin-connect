# ClawChat Connect Architecture

## Process model

`clawchat-connect` is a Bun-native CLI package with separate entrypoints:

```text
clawchat-connect run
  ClawChat Protocol v2 WebSocket client
  inbound message normalization
  chat command routing
  runtime adapter dispatch
  materialized message replies

clawchat-connect mcp-server --agent <agentId>
  stdio MCP server spawned by Codex or another agent client
  exposes 26 shared clawchat_* tools
```

The WebSocket process and MCP server are separate because stdio MCP requires clean stdin/stdout JSON-RPC. Logs from the WebSocket process must never share the MCP stdout stream.

## Runtime adapters

The shared runtime seam lives in `src/runtime/types.ts`.

```text
ConnectRuntime
├── Codex adapter → @openai/codex-sdk → bundled Codex CLI
└── ACP adapter   → @agentclientprotocol/sdk → configured ACP process
```

- `src/runtime/codex-adapter.ts` is the only `@openai/codex-sdk` import seam.
- `src/runtime/acp-adapter.ts` is the only `@agentclientprotocol/sdk` import seam.
- `src/mcp/server.ts` is the only `@modelcontextprotocol/sdk` import seam.
- Agent configuration uses the `kind: "codex" | "acp"` discriminant.
- Codex never passes through an ACP translation process.

`ConnectRuntime` owns adapter selection, queueing, output visibility, reply delivery, and persisted runtime IDs. Adapters do not access SQLite directly.

## Codex thread lifecycle

The Codex adapter creates or resumes one SDK thread per logical ClawChat session. The SDK emits `thread.started`; `ConnectRuntime` persists that ID into the matching SQLite session row.

```text
ClawChat session ID
      ↓
SQLite runtime_session_id
      ↓
Codex resumeThread(threadId)
      ↓
~/.codex/sessions
```

Closing a live runtime session preserves its thread ID. This allows `/switch` and process restarts to resume it. Changing `/dir` or `/mode` invalidates the thread ID because those values become Codex thread options. Runtime-ID callbacks are accepted only while the originating in-memory session still owns its key, preventing a cancelled or stale turn from repopulating an invalidated ID.

Cancellation uses one `AbortController` per active Codex turn.

## Codex output mapping

`runStreamed()` events are normalized into the existing runtime output kinds:

- completed agent messages → `assistant`; the latest is held for one `final`
- reasoning → `reasoning`
- commands, file changes, web searches, and MCP calls → `tool` or `progress`
- task lists and lifecycle/usage → `progress`
- SDK failures → visible `final` output

The runtime then applies `minimal`, `normal`, or `full` visibility and sends complete materialized ClawChat `message.reply` frames. Protocol streaming lifecycle events are not used in v1.

## Layering

```text
src/cli.ts                     CLI commands and process startup
src/ws-client.ts               Protocol v2 over Bun's built-in WebSocket client
src/message-mapper.ts          ClawChat message fragment mapping
src/chat-commands.ts           Chat command parsing and session intent
src/runtime/types.ts           Shared runtime seam
src/runtime/codex-adapter.ts   Official Codex SDK adapter
src/runtime/acp-adapter.ts     Generic ACP adapter
src/runtime/connect-runtime.ts Session queue, lifecycle, output, and reply dispatch
src/tools/schema.ts            26 tool names and Zod schemas
src/tools/registry.ts          Shared tool handlers and audit
src/tools/bridge.ts            Best-effort ACP dynamic tool registration
src/mcp/server.ts              stdio MCP adapter
src/api-client.ts              ClawChat REST/media client
src/state.ts                   Bun-native SQLite operational state
```

## Tool exposure policy

- The tool registry is the source of truth.
- `src/mcp/server.ts` exposes that registry through the MCP SDK's stdio transport.
- Every Codex adapter injects a session-local `mcp_servers.clawchat_connect` configuration override into the SDK.
- The override starts this package's compiled `bin.js` with the Bun executable, passes the active agent/config, and supplies chat/state context through environment variables.
- Automatic Codex exposure never writes `~/.codex/config.toml`.
- `src/tools/bridge.ts` may register tools with ACP runtimes only when the runtime explicitly supports dynamic tools.
- Unsupported ACP dynamic tool registration is not fatal; the user can configure the stdio MCP server.
- Skills are documentation/guidance only. They must not be treated as executable tool installation.

## Agent-only v1

Config contains `agents` and `defaultAgent`. It does not contain `projects` or `defaultProject`. Working directory lives in runtime session state and is set from chat through `/dir` or `/cd`.

## Output policy

Output visibility is resolved in this order:

1. per-chat override from SQLite
2. JSON config default
3. `normal`

Required controls always remain visible. In group chats, required controls route to the owner direct route and never silently fall back to group delivery.

## Persistence

JSON config is user-editable. Bun's built-in `bun:sqlite` stores credentials, device ID, logical sessions, runtime thread IDs, output visibility, message audit/idempotency, tool audit, and runtime status.

`ConnectStateStore` keeps an asynchronous interface for its callers while its internal Bun SQLite adapter executes synchronous native queries. Do not add `sqlite`, `sqlite3`, `node:sqlite`, or `better-sqlite3`.

## Build and quality tooling

Bun owns dependency installation (`bun.lock`), TypeScript execution, `bun:test`, and bundling. Source uses extensionless relative imports with TypeScript bundler resolution; `bun build --target=bun --packages=external` emits publishable entrypoints under `dist/src`.

Biome owns formatting, import organization, and linting. `tsc --noEmit` remains the independent type check.
