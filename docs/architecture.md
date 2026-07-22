# ClawChat Connect Architecture

## Process model

`clawchat-connect` is a Bun-native CLI package whose public lifecycle interface is the native per-user background service:

```text
clawchat-connect service install|start|stop|restart|status|logs
  launchd / systemd user service
    every activated Agent Binding
      ClawChat Protocol v2 WebSocket client
      inbound message normalization
      chat command routing
      Project/Session workspace resolution
      direct runtime adapter dispatch
      materialized message replies

clawchat-connect profile update --agent <bindingId> [fields]
  authenticated ClawChat Profile update

clawchat-connect web
  configured local Host → Connect Client SPA
```

The generated native service definition owns the internal process entry. Connect does not expose a foreground run command.

Connect does not expose tools, run an MCP server, or inject an MCP server into Codex Sessions.

## Domain model

```text
Agent Binding ─────┐
Project (0 or 1) ──┼── Session Intent ── first ordinary message ── Session ── Runtime Thread
                   └───────────────────────────────────────────────┘

Agent Binding.kind ── Runtime Adapter Registry ── Runtime Adapter
```

- An **Agent Binding** is a locally named association between Connect and one configured coding agent runtime. Its ID has no runtime semantics. Activation synchronizes that ID to the connected ClawChat Profile nickname.
- A **Runtime Adapter** is a concrete integration for one runtime kind. The first release registers only Codex, while Connect continues to manage multiple Agent Bindings independently of that release scope.
- A **Project** is a global, reusable Connect workspace with a canonical root and optional additional directories.
- A **Session Intent** is the pending Project, mode, and optional name for the next Session. It has no Session Ref or Runtime Thread and is consumed by the first ordinary message.
- A **Session** owns Connect conversation continuity, is scoped by ClawChat conversation plus Agent Binding, references zero or one Project, may have a human-readable Session Name, and has a stable eight-character Session Ref.
- A **Non-Project Session** receives a deterministic isolated workspace under the directory beside the state database.
- A **Runtime Thread** is the external runtime's resumable conversation ID persisted on one Session.
- A **Session Ref** is the Connect-owned user-facing selector for a Session or discovered Runtime Thread; internal IDs are not displayed or derived into Refs.

`/new`, `/project use`, and `/project clear` create or replace a Session Intent, not an empty Session. The first ordinary message materializes the intent as a Session. Explicitly adopting a discovered Runtime Thread also creates a Session immediately because the external thread already contains conversation history. No Runtime Thread crosses a Project boundary.

## Direct runtime adapter

The shared runtime seam lives in `src/runtime/types.ts`:

```text
Agent Binding
      ↓ kind
RuntimeAdapterRegistry → CodexRuntimeAdapter → private JSONL JSON-RPC client → codex app-server
```

- `src/runtime/registry.ts` selects a Runtime Adapter from the Agent Binding's explicit `kind`.
- `src/runtime/codex-app-server.ts` owns the pinned `codex-cli 0.145.0` process and stable wire protocol; callers see only the Runtime Adapter interface.
- The Codex Runtime Adapter filters child threads from discovery and translates parent `subAgentActivity` items plus child history into recursive runtime-neutral transcript entries.
- The Connect Service composition root registers and closes one shared Runtime Adapter registry. Binding runtimes close only their own Sessions, so stopping one Binding cannot tear down adapters used by another runtime kind.
- The first release registers the Codex Runtime Adapter; `ConnectRuntime` has no Codex dependency.
- `ConnectRuntime` owns queueing, Session lifecycle, workspace resolution, output visibility, reply delivery, and persisted Runtime Thread IDs.
- Adapters receive a resolved `RuntimeWorkspace` and never access SQLite directly. They may discover resumable Runtime Threads scoped to that workspace through the same seam.

Future coding clients should add direct Runtime Adapters behind the same seam rather than changing Agent Binding or `ConnectRuntime` semantics.

## Connect Client boundary

Connect Client is a browser-only React SPA served by the Connect Service. The browser never launches, authenticates to, or speaks a native agent protocol:

```text
React + Astryx + TanStack
        │
        │ same-origin HTTP snapshots/commands + one SSE stream
        ▼
Client Interface ── Session Catalog / Transcript Projection / safe preferences
        │
        ├── SQLite projection and event cursor
        └── RuntimeAdapterRegistry ── Codex app-server
```

`src/client-contract` is browser-safe and contains only Connect-owned versioned views and intents. `src/client-interface` owns static serving, Host/Origin request checks, catalog construction, transcript reconciliation, commands, and event delivery. Native app-server types remain private to `src/runtime/codex-app-server.ts` and `src/runtime/codex-adapter.ts`.

The Client catalog is installation-wide. It merges Connect Sessions with `discoverAllThreads`, keeps one stable Session Ref for an unadopted Runtime Thread, nests Project entries, and leaves Non-Project entries at the binding root. A first Web send adopts an unclaimed thread without replacing its native identity.

The Runtime Transcript remains authoritative for agent context and resume. The Transcript Projection is a SQLite materialized view for the browser: it keeps normalized message, plan, reasoning-summary, command, file-change, tool, progress, usage, interaction, error, and unknown blocks. Runtime-native item IDs become stable block IDs; repeated `thread/read` reconciliation is idempotent. Session snapshot polling reconciles work performed by another Codex surface, while live Connect turns publish block upserts immediately through SSE.

Client-local turns and ClawChat turns share the logical Session queue. Only ClawChat-originated turns pass through reply materialization and the ClawChat WebSocket. Client-local output remains in the projection and SSE stream.

Connect Client deliberately has no local login or browser session. It binds to `127.0.0.1` by default. An explicit `clientHost: "0.0.0.0"` setting exposes the same unauthenticated interface to a trusted IPv4 LAN. Loopback mode validates one exact Host; LAN mode accepts only IPv4-literal Hosts on the configured port. Both modes require mutations to match the request Host's exact Origin and validate Fetch Metadata, request sizes, asset paths, and CSP. Runtime-generated Markdown cannot execute HTML, unsafe links, or remote images. LAN mode provides neither TLS nor internet-safe remote authorization and must not be port-forwarded.

The SPA uses TanStack Router file routes, TanStack Query for snapshots/commands, and TanStack Virtual as the sole transcript scroll owner. Astryx supplies the accessible application shell, navigation, chat, forms, banners, Markdown, and structured-output primitives. Astryx implements dynamic dimensions and positioned layers with React style attributes, so the production CSP permits `style-src-attr` while keeping `style-src-elem` and scripts self-only and blocking script attributes. The virtual viewport uses HTML/SVG layout attributes for dynamic spacers and does not broaden that exception.

## Project and workspace resolution

`ProjectCatalog` is the single Project interface used by chat commands and `ConnectRuntime`.

For Project Sessions it:

1. resolves the Session's `projectId` from SQLite;
2. verifies the canonical root and additional directories still exist;
3. returns the explicitly trusted Project root as `workingDirectory`; app-server accepts it without the SDK command's Git-repository preflight.

For Non-Project Sessions it:

1. hashes `chatId` and `sessionId` into path-safe stable segments;
2. creates `<state-dir>/workspaces/<agent>/<chat>/<session>` with owner-only permissions;
3. returns the isolated directory directly; app-server does not impose the SDK command's Git-repository preflight.

The runtime never uses `process.cwd()` as an implicit workspace.

Projects are global across Agent Bindings. Project names are case-insensitively unique, roots are unique, and deletion is rejected while any Session or Session Intent still references the Project.

## Runtime Thread lifecycle

The Codex adapter creates or resumes one app-server thread handle per logical Connect Session while every handle shares one process:

```text
Session Ref (display/select) → Connect Session ID (internal)
                                      │
                                      ▼
                           SQLite runtime_session_id
                                      │
                                      ▼
                  app-server thread/resume(threadId, workspace options)
                                      │
                                      ▼
                              ~/.codex/sessions
```

`thread/start`, `thread/resume`, and `turn/start` receive the working directory, sandbox, additional writable roots, network policy, model, reasoning effort, approval policy, and web-search settings derived from the resolved workspace and Agent Binding. Project changes create a Session Intent; its first ordinary message creates a Session with a null `runtime_session_id`. `/switch` and process restarts preserve and resume the existing ID. `/mode` updates a pending intent or invalidates a current Session's ID because sandbox mode is also a thread startup option.

The Codex adapter calls app-server `thread/list`, filters by the selected workspace, opts into every source kind, and uses the native name or preview as the Session Name. Connect never opens rollout JSONL itself. `ConnectRuntime` removes Runtime Threads already claimed by the current conversation and asks the state module for a stable Session Ref for every available result. `/list` presents only Connect Sessions from that workspace plus the remaining Runtime Threads as available; `/switch <name-or-ref>` explicitly creates a Connect Session that owns the selected Runtime Thread and preserves its Ref. Ambiguous names require a Ref.

Session Refs use eight characters from an unambiguous Base32 alphabet and contain 40 random bits. SQLite enforces global Ref uniqueness and stores mappings to both Connect Sessions and Runtime Threads. Existing databases are backfilled on startup. When a discovered Runtime Thread is adopted, its mapping is attached to the new Session; when a Session invalidates its Runtime Thread, the Session keeps its Ref and a later rediscovery of the old thread receives a different Ref.

Runtime-ID callbacks are accepted only while the originating in-memory Session still owns its key, preventing a cancelled or stale turn from repopulating an invalidated ID. Cancellation calls app-server `turn/interrupt` with the active native thread and turn IDs.

## Codex output mapping

Stable app-server turn/item notifications are normalized into runtime output kinds:

- completed agent messages → `assistant`; the latest is held for one `final`
- reasoning → `reasoning`
- commands, file changes, web searches, and MCP calls → `tool` or `progress`
- task lists and lifecycle/usage → `progress`
- app-server and turn failures → visible `final` output

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
src/runtime/codex-app-server.ts Pinned app-server process and JSON-RPC transport
src/runtime/codex-adapter.ts   Codex Runtime Adapter and Connect event mapping
src/runtime/connect-runtime.ts Queue, lifecycle, discovery, output, and reply dispatch
src/client-contract/index.ts    Browser-safe versioned Client views and intents
src/client-interface/          Loopback server, catalog, and transcript projection
web/src/                       React/Astryx/TanStack Connect Client
src/api-client.ts              Minimal activation and Profile REST client
src/state.ts                   Bun SQLite persistence
```

## Command authorization and ordering

All Connect control commands except help require `message.sender.id` to match the activated Agent Binding's `ownerUserId`. This prevents other direct or group participants from enumerating host paths, changing Sessions or Projects, or broadening Codex mode.

Lifecycle commands and runtime turns share the same per-chat queue. `/cancel` is the deliberate exception: it bypasses that queue so it can abort the active turn. Runtime status is persisted when a queued item starts and after it fully leaves the queue; only actual runtime turns contribute to `globalRunning`, not control commands.

## Output policy

Output visibility is resolved in this order:

1. per-chat override from SQLite;
2. JSON config default;
3. `normal`.

Required controls always remain visible. In group chats, required controls route to the owner direct route and never silently fall back to group delivery.

## Persistence

JSON configuration stores Agent Bindings and defaults. Project definitions remain operational domain data in SQLite, not config. `stateDbPath` and configured additional directories must be absolute so workspace behavior never depends on the launcher process's current directory.

Bun's built-in `bun:sqlite` stores credentials, device ID, Projects, Session Intents, logical Sessions, Project associations, Runtime Thread IDs, output visibility, message audit/idempotency, runtime status, Client command idempotency, Transcript blocks, and Client event cursors. Session Intent and current Session state are mutually exclusive for one ClawChat conversation plus Agent Binding. On upgrade, legacy empty Sessions are removed and a current empty Session is migrated to an intent. `ConnectStateStore` presents an asynchronous interface while its internal adapter executes Bun's synchronous native queries.

Do not add `sqlite`, `sqlite3`, `node:sqlite`, or `better-sqlite3`.

## Build and quality tooling

Bun owns dependency installation (`bun.lock`), TypeScript execution, `bun:test`, and service bundling. Vite builds the browser-only SPA to `dist/client`; `bun build --target=bun --packages=external` emits service entrypoints under `dist/src`. Standalone release archives place the same build beside the executable as `clawchat-connect-client`, and the installer preserves that layout. `tsconfig.json` type-checks service/tests and `tsconfig.web.json` independently checks the DOM bundle and browser-safe contract.

Biome owns formatting, import organization, and linting. `tsc --noEmit` remains the independent type check. Generated `dist/` artifacts stay ignored and outside Git history.
