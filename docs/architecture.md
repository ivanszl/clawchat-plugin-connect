# ClawChat Connect Architecture

## Process model

`clawchat-connect` is a Bun-native CLI package whose public lifecycle interface is the native per-user background service:

```text
clawchat-connect service install|start|stop|restart|status|logs
  launchd / systemd user service / Windows current-user scheduled task
    every activated Agent Binding
      ClawChat Protocol v2 WebSocket client
      inbound message normalization
      chat command routing
      Project/Session workspace resolution
      direct runtime adapter dispatch
      materialized message replies
    configured local Host → Connect Client SPA
    bundled Liveware agent → managed Liveware Exposure → the same Connect Client SPA

clawchat-connect profile update --agent <bindingId> [fields]
  authenticated ClawChat Profile update

clawchat-connect web
  open the configured local Connect Client URL
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
- A **Session Intent** is the pending Project, mode, model, reasoning effort, and optional name for the next Session. It has no Session Ref or Runtime Thread and is consumed by the first ordinary message.
- A **Session** owns Connect conversation continuity, is scoped by ClawChat conversation plus Agent Binding, references zero or one Project, may have a human-readable Session Name, and has a stable eight-character Session Ref.
- A **Non-Project Session** receives a deterministic isolated workspace under the directory beside the state database.
- A **Runtime Thread** is the external runtime's resumable conversation ID persisted on one Session.
- A **Session Ref** is the Connect-owned user-facing selector for a Session or discovered Runtime Thread; internal IDs are not displayed or derived into Refs.

`/new` and `/project <workspace-id|none>` create or replace a Session Intent, not an empty Session. The first ordinary ClawChat message materializes the intent as a Session. Connect Client may explicitly create an empty Session after choosing its workspace and runtime options. Explicitly adopting a discovered Runtime Thread also creates a Session immediately because the external thread already contains conversation history. No Runtime Thread crosses a Project boundary.

## Direct runtime adapter

The shared runtime seam lives in `src/runtime/types.ts`:

```text
Agent Binding
      ↓ kind
RuntimeAdapterRegistry → CodexRuntimeAdapter → private JSONL JSON-RPC client → codex app-server
                                      └────── versioned rollout fallback
```

- `src/runtime/released-adapters.ts` is the released-adapter catalog. It owns released kinds, operator metadata,
  Binding configuration normalization, defaults, validation, and Adapter construction.
- `src/runtime/registry.ts` selects a constructed Runtime Adapter from the Agent Binding's explicit `kind`.
- `src/runtime/codex-app-server.ts` owns the pinned `codex-cli 0.145.0` process and stable wire protocol; callers see only the Runtime Adapter interface.
- `src/runtime/codex-rollout.ts` supplements persisted app-server history with displayable raw tool calls omitted by that API. It is a read-only, pinned-version fallback inside the Codex Adapter and never exposes raw rollout records across the runtime seam.
- The Codex Runtime Adapter filters child threads from discovery and translates parent `subAgentActivity` items plus
  child history into recursive Runtime Activities.
- The Connect Service composition root registers and closes one shared Runtime Adapter registry. Binding runtimes close only their own Sessions, so stopping one Binding cannot tear down adapters used by another runtime kind.
- The first release registers the Codex Runtime Adapter; `ConnectRuntime` has no Codex dependency.
- `ConnectRuntime` owns turn queueing and exposes a narrow lifecycle claim that drains/cancels work and releases the
  in-memory handle. Session Continuity retains lifecycle validation, journaling, native mutation, and local commit.
- Runtime Adapters may expose a runtime-neutral model catalog. Connect resolves model inheritance as Session → Agent Binding → Runtime default. Reasoning effort resolves independently as strict Session effort → valid Agent Binding effort → the effective model's advertised default. Codex-native `model/list` pagination stays private to the Codex Adapter.
- ClawChat media fragments remain structured across `ConnectRuntimePrompt`: the Codex Adapter downloads media into the Connect-owned cache, submits images and audio as native local app-server inputs, and submits files and videos as local file mentions. Configured API/media origins are trusted for private self-hosting; other URLs require HTTPS and public DNS answers. Every redirect is revalidated. Downloads are capped at 100 MiB and use path-safe cached names. The cache is bounded to 512 MiB, refreshes access time on reuse, evicts least-recently-used files when full, and expires files after 15 days without access.
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

The Client catalog is installation-wide. It merges Connect Sessions with `discoverAllThreads`, keeps one stable Session Ref for an unadopted Runtime Thread, nests Project and persistent native-workspace entries, and leaves Non-Project entries at the binding root. Runtime Adapters may classify generated scratch workspaces as transient so their readable Session names remain direct leaves instead of exposing meaningless directory labels. A first Web send adopts an unclaimed thread without replacing its native identity; persistent native workspaces become Projects, while transient scratch workspaces remain Non-Project. Creating a Session submits its Project, mode, model, and reasoning effort; the server validates those options before materializing an empty Session. Its first Client-local task is submitted later through the ordinary turn command.

The Runtime Transcript remains authoritative for agent context and resume. The Transcript Projection is a SQLite
materialized view for the browser: it keeps normalized message, plan, reasoning-summary, command, file-change, tool,
progress, usage, interaction, error, and unknown blocks. Runtime Adapters translate live notifications, history, and
fallback records into the same Runtime Activity contract before crossing the seam. Adapter-owned IDs, positions, and
aliases become stable block identity and ordering; Projection never correlates runtime output by rendered text.
Codex positions use native turn and item ordinals across live and historical Activity, and Projection reserves
per-turn sequence ranges so replay or out-of-order delivery converges to the same order. All Adapters use the
runtime-neutral `<turn ordinal>.<item ordinal>` decimal position syntax; item `0` is reserved for turn-level Activity.
Adapters report `complete`, `partial`, or `live-only` completeness plus explicit identity, correlation, or ordering
limitations. Session snapshot polling reconciles work performed by another Codex surface, while live Connect turns
publish the same Activity upserts immediately through SSE.

Client-local turns and ClawChat turns share the logical Session queue. Only ClawChat-originated turns pass through reply materialization and the ClawChat WebSocket. Client-local output remains in the projection and SSE stream.

Runtime approvals and Agent questions follow the same origin boundary. Web-originated turns render and resolve their interactions only in Connect Client. ClawChat-originated turns send plain-text prompts to the owner's direct conversation: `/approve`, `/approve session`, and `/deny` settle approvals, numbered replies such as `/1` and `/2` select question options, and free-text questions consume the owner's next direct reply. They do not create Web interaction cards. Session activity is derived from the per-Session queue, so an active turn never marks unrelated Sessions as working.

Connect Client deliberately has no local login or browser session. It binds to `127.0.0.1` by default. An explicit `clientHost: "0.0.0.0"` setting exposes the same unauthenticated interface to a trusted IPv4 LAN. Loopback mode validates one exact Host; LAN mode accepts only IPv4-literal Hosts on the configured port. Both modes require mutations to match the request Host's exact Origin and validate Fetch Metadata, request sizes, asset paths, and CSP. Runtime-generated Markdown cannot execute HTML, unsafe links, or remote images. Anyone with LAN access can manage Project paths, select advertised Session modes including `danger-full-access`, change model preferences, and submit turns. LAN mode provides neither TLS nor internet-safe remote authorization and must not be port-forwarded.

The SPA uses TanStack Router file routes, TanStack Query for snapshots/commands, and TanStack Virtual as the sole transcript scroll owner. Astryx supplies the accessible application shell, navigation, chat, forms, banners, Markdown, and structured-output primitives. Astryx implements dynamic dimensions and positioned layers with React style attributes, so the production CSP permits `style-src-attr` while keeping `style-src-elem` and scripts self-only and blocking script attributes. The virtual viewport uses HTML/SVG layout attributes for dynamic spacers and does not broaden that exception.

## Project and workspace resolution

`ProjectCatalog` is the single Project interface used by local CLI/Client administration, ClawChat selection commands, and `ConnectRuntime`.

For Project Sessions it:

1. resolves the Session's `projectId` from SQLite;
2. verifies the canonical root and additional directories still exist;
3. returns the explicitly trusted Project root as `workingDirectory`; app-server accepts it without the SDK command's Git-repository preflight.

For Non-Project Sessions it:

1. hashes `chatId` and `sessionId` into path-safe stable segments;
2. creates `<state-dir>/workspaces/<agent>/<chat>/<session>` with owner-only permissions;
3. returns the isolated directory directly; app-server does not impose the SDK command's Git-repository preflight.

The runtime never uses `process.cwd()` as an implicit workspace.

Projects are global across Agent Bindings. Their display names and user-facing Workspace IDs are derived from canonical roots; names are not independently customizable, and roots are unique. Active persistent Runtime Workspace Identities with usable local roots are synchronized one-way into Projects. Deletion removes only the unused Connect record and its Runtime Workspace mappings; files and Runtime Threads are unchanged, and later active discovery may recreate the Project.

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

`thread/start`, `thread/resume`, and `turn/start` receive the working directory, sandbox, additional writable roots, network policy, resolved model and reasoning effort, approval policy, and web-search settings. A missing Codex Binding approval policy normalizes to `on-request`, including when an older config is loaded, so command and file-change requests can enter the Connect-owned Runtime Interaction flow; explicit `never` and `untrusted` values remain supported. Model resolution runs for each turn in Session → Agent Binding → Runtime Adapter default order. Reasoning effort uses a strict Session value when present, otherwise a Binding value only when the effective model supports it, otherwise the advertised model default. A missing stored Session model fails visibly. Project changes create a Session Intent; its first ordinary message creates a Session with a null `runtime_session_id`. `/switch`, model changes, and process restarts preserve and resume the existing ID. `/mode` updates a pending intent or invalidates a current Session's ID because sandbox mode is also a thread startup option.

The Codex adapter calls app-server `thread/list`, filters by the selected workspace, opts into every source kind, and uses the native name or preview as the Session Name. It reads rollout JSONL only inside its pinned-version transcript fallback when app-server history omits displayable tool calls. `ConnectRuntime` and the Client Interface never open or interpret rollout files. `ConnectRuntime` removes Runtime Threads already claimed by the current conversation and asks the state module for a stable Session Ref for every available result. `/sessions` presents only Connect Sessions from that workspace plus the remaining Runtime Threads as available; `/switch <name-or-ref>` explicitly creates a Connect Session that owns the selected Runtime Thread and preserves its Ref. Connect Client also offers persistent workspaces discovered for the selected Agent Binding when creating a new Session; choosing one explicitly registers or reuses its Project at creation time. Ambiguous names require a Ref.

Session Refs use eight characters from an unambiguous Base32 alphabet and contain 40 random bits. SQLite enforces global Ref uniqueness and stores mappings to both Connect Sessions and Runtime Threads. Existing databases are backfilled on startup. When a discovered Runtime Thread is adopted, its mapping is attached to the new Session; when a Session invalidates its Runtime Thread, the Session keeps its Ref and a later rediscovery of the old thread receives a different Ref.

Runtime-ID callbacks are accepted only while the originating in-memory Session still owns its key, preventing a cancelled or stale turn from repopulating an invalidated ID. Cancellation calls app-server `turn/interrupt` with the active native thread and turn IDs.

Session lifecycle uses an explicit acquire/release claim. The claim rejects new turns immediately, cancels and drains
an active turn, releases its Runtime handle, and remains held while Session Continuity performs its journaled
native/local operation. Discovered but unadopted Runtime Threads use the same per-Ref serialization key. Adapter
lifecycle failures are normalized to stable not-found, conflict, or unsupported errors before reaching the Client.

## Codex output mapping

Stable app-server turn/item notifications are normalized inside the Codex Adapter into complete current-state Runtime
Activities:

- completed agent messages → `assistant`
- reasoning → `reasoning`
- commands → `command`
- file changes → `file-change`
- web searches and MCP calls → `tool`
- task lists and lifecycle/usage → `plan` or `progress`
- app-server and turn failures → `error`

The Adapter attaches the output-visibility category used for ClawChat materialization as Activity metadata; it is not a
second projection representation.

The runtime applies `minimal`, `normal`, or `full` visibility and sends complete ClawChat `message.reply` frames. Direct-message responses do not quote the triggering message. Group responses retain that reply context. Group messages enter Runtime routing according to the conversation's Group Intake Policy: mention-only requires a structured Agent Mention, while `all` uses the configured delayed or real-time Group Message Batch window; mute suppresses routing. Protocol streaming lifecycle events are not used.

Local Markdown images become outbound media only when their canonical path is inside the media cache or resolved Runtime Workspace and their extension plus binary signature identify PNG, JPEG, GIF, or WebP content. Arbitrary Markdown file references remain text.

## Reliable inbound processing

Protocol v2 frames and materialized messages are recorded before dispatch. Once a materialized message has been durably handed to the recoverable inbound processor, Connect may advance the live ACK without waiting for a long command or Runtime turn. The processor stores a content-specific completion marker after processing and scans persisted rows without a matching marker at startup and after reconnect. Before retrying an unfinished row, Connect asks every candidate Runtime Thread for an authoritative receipt keyed by the ClawChat message ID and canonical delivery-content digest. An exact accepted receipt atomically completes every matching actionable Batch and consumed-context row; only authoritative absence permits another submission. Incomplete or failed native history is `unknown`, leaves the row pending, and is retried with bounded backoff. A coalesced update with the same message ID but a different digest remains new input. See ADR-0039.

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
src/media-api-client.ts        Authenticated ClawChat media upload client
src/message-mapper.ts          ClawChat message fragment mapping
src/chat-commands.ts           Session and Project command intent
src/projects.ts                Project catalog and workspace resolution
src/runtime/types.ts           Direct runtime seam
src/runtime/registry.ts        Runtime Adapter selection by Binding kind
src/runtime/codex-app-server.ts Pinned app-server process and JSON-RPC transport
src/runtime/codex-rollout.ts   Pinned-version Codex transcript fallback
src/runtime/codex-adapter.ts   Codex Runtime Adapter and Connect event mapping
src/runtime/connect-runtime.ts Queue, lifecycle, discovery, output, and reply dispatch
src/runtime/media-cache.ts    Bounded state-local cache for runtime file/video inputs
src/client-contract/index.ts    Browser-safe versioned Client views and intents
src/client-interface/          Loopback server, catalog, and transcript projection
web/src/                       React/Astryx/TanStack Connect Client
src/api-client.ts              Minimal activation and Profile REST client
src/state.ts                   Bun SQLite persistence
```

## Command authorization and ordering

All Connect control commands except help require `message.sender.id` to match the activated Agent Binding's `ownerUserId`. ClawChat may select a registered Project by name or ID but never accepts or displays host paths; Project registry administration belongs to the local CLI and Connect Client.

Runtime turns are queued by Connect Session ID. ClawChat and Client turns for one Session never overlap, while different Sessions may run concurrently up to `maxConcurrentTurns`. A short per-conversation routing gate atomically targets first messages and orders selection-changing commands behind the previously selected Session without holding the gate during Runtime Adapter execution. The pending limit is `maxPendingPerSession`; the removed conversation-named setting is not accepted. `/cancel` deliberately bypasses both queues so it can abort the selected Session's active turn. Runtime status counts actual running turns and distinct active ClawChat conversations separately.

## Output policy

Output visibility is resolved in this order:

1. per-chat override from SQLite;
2. JSON config default;
3. `normal`.

Required controls always remain visible. In group chats, required controls route to the owner direct route and never silently fall back to group delivery.

## Persistence

JSON configuration stores Agent Bindings and defaults. Project definitions remain operational domain data in SQLite, not config. `stateDbPath` and configured additional directories must be absolute so workspace behavior never depends on the launcher process's current directory.

Bun's built-in `bun:sqlite` stores credentials, device ID, Projects, Session Intents, logical Sessions, Project/model/mode selections, Runtime Thread IDs, output visibility, message audit/idempotency, runtime status, Client command idempotency, Transcript blocks, and Client event cursors. Session Intent and current Session state are mutually exclusive for one ClawChat conversation plus Agent Binding. The public state interface atomically resolves or materializes the current Session so concurrent first messages consume one Intent and receive one Session ID. Model columns use additive, idempotent migrations; null means inherit. On upgrade, legacy empty Sessions are removed and a current empty Session is migrated to an intent. `ConnectStateStore` presents an asynchronous interface while its internal adapter executes Bun's synchronous native queries.

Do not add `sqlite`, `sqlite3`, `node:sqlite`, or `better-sqlite3`.

## Build and quality tooling

Bun owns dependency installation (`bun.lock`), TypeScript execution, `bun:test`, and service bundling. Vite builds the browser-only SPA to `dist/client`; `bun build --target=bun --packages=external` emits service entrypoints under `dist/src`. Standalone release archives place the same build beside `clawchat-connect-client` and the pinned, platform-specific `liveware` executable; the installer preserves that sibling layout. The repository and npm package carry all six supported, unmodified Liveware v0.0.16 assets because the source release is private. Every asset is checked against the repository's SHA-256 manifest before packaging. GitHub Actions cross-compiles arm64/x64 Connect executables for macOS, Linux, and Windows; Windows uses a ZIP plus checksum-verifying PowerShell installer. `tsconfig.json` type-checks service/tests and `tsconfig.web.json` independently checks the DOM bundle and browser-safe contract.

Biome owns formatting, import organization, and linting. `tsc --noEmit` remains the independent type check. Generated `dist/` artifacts stay ignored and outside Git history.
