# ClawChat Connect Architecture

## Process model

`clawchat-connect` is a Bun-native CLI package with a WebSocket service entrypoint and host-side management commands:

```text
clawchat-connect run --agent <bindingId>
  ClawChat Protocol v2 WebSocket client
  inbound message normalization
  chat command routing
  Project/Session workspace resolution
  direct runtime adapter dispatch
  materialized message replies

clawchat-connect profile update --agent <bindingId> [fields]
  authenticated ClawChat Profile update
```

Connect does not expose tools, run an MCP server, or inject an MCP server into Codex Sessions.

## Domain model

```text
Agent Binding ─────┐
                   ├── Session ── Runtime Thread
Project (0 or 1) ──┘

Agent Binding.kind ── Runtime Adapter Registry ── Runtime Adapter
```

- An **Agent Binding** is a locally named association between Connect and one configured coding agent runtime. Its ID has no runtime semantics. Activation synchronizes that ID to the connected ClawChat Profile nickname.
- A **Runtime Adapter** is a concrete integration for one runtime kind. The first release registers only Codex, while Connect continues to manage multiple Agent Bindings independently of that release scope.
- A **Project** is a global, reusable Connect workspace with a canonical root and optional additional directories.
- A **Session** owns Connect conversation continuity, is scoped by ClawChat conversation plus Agent Binding, and references zero or one Project.
- A **Non-Project Session** receives a deterministic isolated workspace under the directory beside the state database.
- A **Runtime Thread** is the external runtime's resumable conversation ID persisted on one Session.

Changing Project association always creates a new Session. No Runtime Thread crosses a Project boundary.

## Direct runtime adapter

The shared runtime seam lives in `src/runtime/types.ts`:

```text
Agent Binding
      ↓ kind
RuntimeAdapterRegistry → CodexRuntimeAdapter → @openai/codex-sdk → Codex CLI
```

- `src/runtime/registry.ts` selects a Runtime Adapter from the Agent Binding's explicit `kind`.
- `src/runtime/codex-adapter.ts` is the only `@openai/codex-sdk` import seam.
- The CLI composition root registers the Codex Runtime Adapter for the first release; `ConnectRuntime` has no Codex dependency.
- `ConnectRuntime` owns queueing, Session lifecycle, workspace resolution, output visibility, reply delivery, and persisted Runtime Thread IDs.
- Adapters receive a resolved `RuntimeWorkspace` and never access SQLite directly.

Future coding clients should add direct Runtime Adapters behind the same seam rather than changing Agent Binding or `ConnectRuntime` semantics.

## Project and workspace resolution

`ProjectCatalog` is the single Project interface used by chat commands and `ConnectRuntime`.

For Project Sessions it:

1. resolves the Session's `projectId` from SQLite;
2. verifies the canonical root and additional directories still exist;
3. returns the explicitly trusted Project root as `workingDirectory` with Codex's Git-repository-check bypass enabled.

For Non-Project Sessions it:

1. hashes `chatId` and `sessionId` into path-safe stable segments;
2. creates `<state-dir>/workspaces/<agent>/<chat>/<session>` with owner-only permissions;
3. enables Codex's `skipGitRepoCheck` for that isolated workspace.

The runtime never uses `process.cwd()` as an implicit workspace.

Projects are global across Agent Bindings. Project names are case-insensitively unique, roots are unique, and deletion is rejected while any Session still references the Project.

## Runtime Thread lifecycle

The Codex adapter creates or resumes one SDK thread per logical Connect Session:

```text
Connect Session ID
      ↓
SQLite runtime_session_id
      ↓
Codex resumeThread(threadId, workspace options)
      ↓
~/.codex/sessions
```

`ThreadOptions.workingDirectory` and `additionalDirectories` come from the resolved workspace plus Agent Binding configuration. Project changes create a new Session with a null `runtime_session_id`. `/switch` and process restarts preserve and resume the existing ID. `/mode` invalidates the ID because sandbox mode is also a thread startup option.

Runtime-ID callbacks are accepted only while the originating in-memory Session still owns its key, preventing a cancelled or stale turn from repopulating an invalidated ID. Cancellation uses one `AbortController` per active Codex turn.

## Codex output mapping

`runStreamed()` events are normalized into runtime output kinds:

- completed agent messages → `assistant`; the latest is held for one `final`
- reasoning → `reasoning`
- commands, file changes, web searches, and MCP calls → `tool` or `progress`
- task lists and lifecycle/usage → `progress`
- SDK failures → visible `final` output

The runtime applies `minimal`, `normal`, or `full` visibility and sends complete ClawChat `message.reply` frames. Protocol streaming lifecycle events are not used.

## External capability policy

- Connect has no dynamic tool registry, local memory tools, or MCP entrypoint.
- The Codex adapter does not inject tool or MCP configuration.
- Profile updates are explicit CLI operations through `src/profile.ts`.
- The REST client retains only activation and Profile-update operations required by Connect.
- MCP servers configured independently in the user's Codex environment remain outside Connect's ownership.

## Layering

```text
src/cli.ts                     CLI commands and process startup
src/activation.ts              Activation and Profile nickname synchronization
src/profile.ts                 Explicit authenticated Profile updates
src/ws-client.ts               Protocol v2 over Bun WebSocket
src/message-mapper.ts          ClawChat message fragment mapping
src/chat-commands.ts           Session and Project command intent
src/projects.ts                Project catalog and workspace resolution
src/runtime/types.ts           Direct runtime seam
src/runtime/registry.ts        Runtime Adapter selection by Binding kind
src/runtime/codex-adapter.ts   Official Codex SDK adapter
src/runtime/connect-runtime.ts Queue, lifecycle, output, and reply dispatch
src/api-client.ts              Minimal activation and Profile REST client
src/state.ts                   Bun SQLite persistence
```

## Command authorization and ordering

All Connect control commands except help require `message.sender.id` to match the activated Agent Binding's `ownerUserId`. This prevents other direct or group participants from enumerating host paths, changing Sessions or Projects, or broadening Codex mode.

Lifecycle commands and runtime turns share the same per-chat queue. `/cancel` is the deliberate exception: it bypasses that queue so it can abort the active turn.

## Output policy

Output visibility is resolved in this order:

1. per-chat override from SQLite;
2. JSON config default;
3. `normal`.

Required controls always remain visible. In group chats, required controls route to the owner direct route and never silently fall back to group delivery.

## Persistence

JSON configuration stores Agent Bindings and defaults. Project definitions remain operational domain data in SQLite, not config. `stateDbPath` and configured additional directories must be absolute so workspace behavior never depends on the launcher process's current directory.

Bun's built-in `bun:sqlite` stores credentials, device ID, Projects, logical Sessions, Project associations, Runtime Thread IDs, output visibility, message audit/idempotency, and runtime status. `ConnectStateStore` presents an asynchronous interface while its internal adapter executes Bun's synchronous native queries.

Do not add `sqlite`, `sqlite3`, `node:sqlite`, or `better-sqlite3`.

## Build and quality tooling

Bun owns dependency installation (`bun.lock`), TypeScript execution, `bun:test`, and bundling. Source uses extensionless relative imports with TypeScript bundler resolution; `bun build --target=bun --packages=external` emits publishable entrypoints under `dist/src`.

Biome owns formatting, import organization, and linting. `tsc --noEmit` remains the independent type check. Generated `dist/` artifacts stay ignored and outside Git history.
