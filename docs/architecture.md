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
      Workspace/Session target resolution
      exact Runtime Plugin capability dispatch
      materialized message replies
    Core-owned Shared Client Gateway → Connect Client SPA
    optional official Liveware Plugin → one private Publication per Binding → the same Shared Client Gateway

clawchat-connect profile update --agent <bindingId> [fields]
  authenticated ClawChat Profile update

clawchat-connect web
  open the configured local Connect Client URL
```

The generated native service definition owns the internal process entry. Connect does not expose a foreground run command.

Connect does not expose tools, run an MCP server, or inject an MCP server into Codex Sessions.

## Domain model

```text
Installation Owner
      │
      ├── Agent Binding ── exact pluginId + capabilityId ── Binding Runtime Instance
      │         │
      │         └── Binding-scoped Workspace Catalog ── Workspace Ref
      │
      └── Session Intent ── first ordinary message ── Session ── Runtime Thread
                              exact Binding + Workspace
```

- The first successful Agent Binding activation establishes one **Installation Owner**. Later activations must return the same ClawChat owner identity.
- An **Agent Binding** is a locally named association between Connect and one exact installed Runtime Plugin capability. Its persisted provider identity is `pluginId` plus `capabilityId`.
- A **Runtime Adapter** is one Binding-scoped instance created by that capability provider. Runtime family is metadata; several installed capabilities may advertise the same family.
- A **Workspace Catalog** belongs to one Agent Binding. Core creates one Default Workspace, assigns stable Workspace Refs, and merges Runtime Adapter-reported Workspace identities without sharing identity across Bindings.
- A **Session Intent** is the pending Workspace Ref, mode, model, reasoning effort, and optional name for the next Session. It has no Session Ref or Runtime Thread.
- A **Session** owns Connect conversation continuity and remains fixed to one Agent Binding, one Runtime Adapter capability, and exactly one Workspace. It may have a human-readable Session Name and has a stable eight-character Session Ref.
- A **Runtime Thread** is the external runtime's resumable conversation ID persisted on one Session.
- A **Session Ref** is the Connect-owned selector for a Session or discovered Runtime Thread; native IDs are never used as user-facing selectors.

`/new` and `/workspace <workspace-ref>` create or replace a Session Intent. The first ordinary ClawChat message materializes it. Connect Client may create an empty Session only after the server validates the selected Binding and Workspace Ref. Adopting a discovered Runtime Thread creates a Session immediately. Continuing with another Agent creates a new Session against a Workspace resolved independently in the target Binding; it transfers no conversation or tool context and leaves the original Session unchanged.

## Plugin composition and activation

One Cordis root owns mandatory internal modules and user-installed Plugin lifecycles. Persistence initializes first; Workspace Catalog, Session Continuity, Session Queue, Client Interface, Plugin Host, and transport surfaces do not have a parallel manual composition path.

Plugin replacement uses one prepare/commit/start boundary. Import, contribution registration, configuration validation, and copied Durable State migration run without published contributions or external-effect capabilities. Core then atomically commits the selected version, validated configuration, migrated state revision, and next Activation Generation; old-generation dispatch is revoked before disposal, and only the committed generation may register providers, mutate Durable State, publish remote resources, or contribute Client effects. A precommit failure preserves the old generation. A postcommit disposal or start failure leaves the selected generation visible as erroneous and does not restore revoked authority.

The public SDK exposes Runtime Adapter and Client Extension capabilities through a narrow Plugin Context; it exposes neither raw Cordis nor mutable Core domain state. Client Exposure is an internal privileged grant issued only to the release-verified official Liveware Bundle. Plugin installation is trusted in-process code execution, not an OS sandbox.

## Client Exposure and Liveware publication

Core owns one installation-wide Shared Client Gateway. The official Liveware Plugin acquires an opaque gateway endpoint and manages one independent **Binding Liveware Publication** per activated Binding. Each Publication has its own correlation key, private App, tunnel, registration, and persisted lifecycle state; creation recovery performs authoritative correlation lookup before retry. Retirement intent is durable and prevents automatic reprovisioning until retirement completes.

The capability configuration accepts only `private` or `off`. `private` reconciles one owner-only Publication per Binding; `off` retires all Publications and releases the gateway lease. Removing one Binding retires only its Publication. The loopback Client remains available when the optional Plugin is missing or erroneous.

## Runtime Adapter seam

The shared runtime seam lives in `src/runtime/types.ts`:

```text
Installed Runtime Plugin Bundle
      ↓ exact pluginId + capabilityId
RuntimeAdapterRegistry → per-Binding Runtime Adapter → private native runtime protocol
```

- `src/plugin/host.ts` activates installed Plugin Bundles and publishes their exact Runtime capability providers.
- `src/runtime/registry.ts` starts empty, keys providers by `pluginId/capabilityId`, derives Runtime family from provider
  metadata, and owns one Adapter instance per Agent Binding.
- Runtime-specific process implementations are private to the official Plugin Bundle entry bridges.
- `src/runtime/codex-rollout.ts` supplements persisted app-server history with displayable raw tool calls omitted by that API. It is a read-only, pinned-version fallback inside the Codex Adapter and never exposes raw rollout records across the runtime seam.
- The Codex Runtime Adapter filters child threads from discovery and translates parent `subAgentActivity` items plus
  child history into recursive Runtime Activities.
- The Connect Service composition root creates and closes one initially empty Runtime Adapter registry. Installed Plugin Bundles publish providers before surfaces start. Binding runtimes close only their own Sessions, while Bundle replacement quiesces and replaces every dependent Binding instance.
- `ConnectRuntime` depends only on the provider-backed Runtime Adapter registry and has no runtime-specific construction path.
- `ConnectRuntime` owns turn queueing and exposes a narrow lifecycle claim that drains/cancels work and releases the
  in-memory handle. Session Continuity retains lifecycle validation, journaling, native mutation, and local commit.
- Runtime Adapters may expose a runtime-neutral model catalog. Connect resolves model inheritance as Session → Agent Binding → Runtime default. Reasoning effort resolves independently as strict Session effort → valid Agent Binding effort → the effective model's advertised default. Codex-native `model/list` pagination stays private to the Codex Adapter.
- ClawChat media fragments remain structured across `ConnectRuntimePrompt`: the Codex Adapter downloads media into the Connect-owned cache, submits images and audio as native local app-server inputs, and submits files and videos as local file mentions. Configured API/media origins are trusted for private self-hosting; other URLs require HTTPS and public DNS answers. Every redirect is revalidated. Downloads are capped at 100 MiB and use path-safe cached names. The cache is bounded to 512 MiB, refreshes access time on reuse, evicts least-recently-used files when full, and expires files after 15 days without access.
- Adapters receive a resolved `RuntimeWorkspace` and never access SQLite directly. They may discover resumable Runtime Threads scoped to that workspace through the same seam.

Future coding clients must ship as Runtime Plugin Bundles that contribute Runtime Adapters behind the same seam rather than adding host-owned Adapter construction or changing Agent Binding or `ConnectRuntime` semantics.

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
        └── RuntimeAdapterRegistry ── selected Plugin capability instance
```

`src/client-contract` is browser-safe and contains only Connect-owned versioned views and intents. `src/client-interface` owns static serving, Host/Origin request checks, catalog construction, transcript reconciliation, commands, and event delivery. Native app-server types remain private to `src/runtime/codex-app-server.ts` and `src/runtime/codex-adapter.ts`.

The Client catalog is installation-wide but every Workspace Catalog is Binding-scoped. It merges Connect Sessions with Runtime Adapter thread discovery, retains one stable Session Ref for each unadopted Runtime Thread, and groups entries beneath their validated Workspace. Runtime Adapter snapshots report `complete`, `partial`, or `unavailable`: a complete omission prevents new selection of an earlier runtime-reported Workspace, while partial or unavailable discovery preserves earlier associations. A first Web send may adopt an unclaimed thread without replacing native identity. Host-directory browsing exposes directory names and structure but never file contents; a staged directory becomes a Workspace only when Session creation is confirmed and server validation succeeds.

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

Connect Client deliberately has no local login or browser session. It binds to `127.0.0.1` by default. An explicit `clientHost: "0.0.0.0"` setting exposes the same unauthenticated interface to a trusted IPv4 LAN. Loopback mode validates one exact Host; LAN mode accepts only IPv4-literal Hosts on the configured port. Both modes require mutations to match the request Host's exact Origin and validate Fetch Metadata, request sizes, asset paths, and CSP. Plugin administration is a narrower host-trust boundary: when wildcard-bound, every Plugin read and mutation requires Bun's socket peer to be loopback; forwarded headers never grant authority. A private official Liveware Publication reaches the same loopback Shared Client Gateway and is owner-only. Anyone with LAN access can enumerate host directory names and structure, manage Workspace paths, select advertised Session modes including `danger-full-access`, change model preferences, and submit turns. LAN mode provides neither TLS nor remote identity and must never be internet-exposed.

The SPA uses TanStack Router file routes, TanStack Query for snapshots/commands, and TanStack Virtual as the sole transcript scroll owner. Astryx supplies the accessible application shell, navigation, chat, forms, banners, Markdown, and structured-output primitives. Astryx implements dynamic dimensions and positioned layers with React style attributes, so the production CSP permits `style-src-attr` while keeping `style-src-elem` and scripts self-only and blocking script attributes. The virtual viewport uses HTML/SVG layout attributes for dynamic spacers and does not broaden that exception.

The non-replaceable Client Kernel owns routing, bootstrap, scoped services, the browser Cordis root, and fallback rendering. It derives one graph hash and epoch from the exact selected Client Extension artifacts. A graph change disposes all old components, slots, styles, subscriptions, timers, and scoped effects before replacement; inability to prove clean replacement forces a full-page reload. Extension service mutations carry the epoch, stale epochs are rejected, and one failing Extension cannot replace Kernel recovery.

## Workspace resolution

`WorkspaceCatalog` is the sole Workspace interface used by CLI and Client administration, ClawChat selection commands, Session creation, and `ConnectRuntime`.

Every Agent Binding receives one Default Workspace under `<state-dir>/workspaces/<binding>`. Core assigns every Workspace Ref and owns the mapping from Runtime Adapter-reported stable Workspace identities to canonical local roots. Runtime Plugins report discovery snapshots but cannot allocate Refs, merge Catalogs, or mutate Session targets.

Session creation resolves its Workspace Ref in the selected Binding's Catalog, verifies the canonical root still exists, and passes the resulting `RuntimeWorkspace` to the Adapter. A Session stores that exact Binding and Workspace identity for its lifetime. Two Bindings may resolve different Workspace Refs to the same filesystem root without sharing Workspace identity or runtime context.

Complete discovery removes omitted runtime-reported Workspaces from new selection while preserving existing Session identity. Partial or unavailable discovery never erases an earlier association. Removing a Workspace record never deletes files or runtime-native Threads. The runtime never uses `process.cwd()` as an implicit Workspace.

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

`thread/start`, `thread/resume`, and `turn/start` receive the resolved Workspace, sandbox, additional writable roots, network policy, model, reasoning effort, approval policy, and web-search settings. Model resolution runs for each turn in Session → Agent Binding → Runtime Adapter default order. Reasoning effort uses a strict Session value when present, otherwise a Binding value only when the effective model supports it, otherwise the advertised model default. A missing stored model fails visibly. Workspace changes create a Session Intent; `/switch`, in-place model changes, and process restarts preserve and resume the existing Runtime Thread ID, while a boundary-forming mode change invalidates it.

The Codex adapter calls app-server `thread/list`, filters by the resolved Workspace, opts into every source kind, and uses the native name or preview as the Session Name. It reads rollout JSONL only inside its pinned-version transcript fallback when app-server history omits displayable tool calls. `ConnectRuntime` and the Client Interface never interpret rollout files. `/sessions` shows Connect Sessions in that Workspace plus unclaimed Runtime Threads; `/switch <name-or-ref>` creates a Connect Session that owns the selected Runtime Thread and preserves its Ref. Connect Client may create a Workspace from an explicitly confirmed host directory in the selected Binding's Catalog. Ambiguous names require a Ref.

Session Refs use eight characters from an unambiguous Base32 alphabet and contain 40 random bits. SQLite enforces global Ref uniqueness and stores mappings to both Connect Sessions and Runtime Threads. When a discovered Runtime Thread is adopted, its mapping attaches to the new Session; when a Session invalidates its Runtime Thread, the Session keeps its Ref and later rediscovery of the old Thread receives a different Ref.

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
- Profile updates are explicit CLI operations through `src/account/profile.ts`.
- The REST client retains only activation and Profile-update operations required by Connect.
- MCP servers configured independently in the user's Codex environment remain outside Connect's ownership.

## Layering

```text
src/bin.ts                Executable entrypoint
src/index.ts              Package exports
src/account/              Activation, Binding removal, and Profile updates
src/agent/                Agent-callable Skills, tools, and Liveware commands
src/clawchat/             Protocol v2, WebSocket transport, media, intake, and commands
src/workspaces/           Workspace Catalog, Session continuity, and host-directory behavior
src/persistence/          SQLite adapter, schema, codecs, Session Refs, and state Interface
src/service/              CLI, process startup, Binding runtime, Shared Client Gateway, and updates
src/runtime/types.ts      Direct Runtime Adapter seam
src/runtime/registry.ts   Exact Plugin capability provider selection
src/runtime/*-adapter.ts  Runtime-specific implementations used by official Plugin Bundle entries
src/client-contract/      Browser-safe versioned Client views and intents
src/client-interface/     HTTP/SSE interface, catalog, transcript projection, and commands
web/src/                  React/Astryx/TanStack Connect Client
```

## Command authorization and ordering

All Connect control commands except help require `message.sender.id` to match the Installation Owner. ClawChat selects a registered Workspace by Ref and never accepts or displays host paths; Workspace administration belongs to the local CLI and Connect Client.

Runtime turns are queued by Connect Session ID. ClawChat and Client turns for one Session never overlap, while different Sessions may run concurrently up to `maxConcurrentTurns`. A short per-conversation routing gate atomically targets first messages and orders selection-changing commands behind the previously selected Session without holding the gate during Runtime Adapter execution. The pending limit is `maxPendingPerSession`; the removed conversation-named setting is not accepted. `/cancel` deliberately bypasses both queues so it can abort the selected Session's active turn. Runtime status counts actual running turns and distinct active ClawChat conversations separately.

## Output policy

Output visibility is resolved in this order:

1. per-chat override from SQLite;
2. JSON config default;
3. `normal`.

Required controls always remain visible. In group chats, required controls route to the owner direct route and never silently fall back to group delivery.

## Persistence

JSON configuration stores Agent Bindings, exact Runtime capability references, schema-validated Binding runtime configuration, and installation defaults. Binding-scoped Workspace records remain operational domain data in SQLite. `stateDbPath` and configured additional directories must be absolute, so Workspace behavior never depends on the launcher process's current directory.

Bun's built-in `bun:sqlite` stores the Installation Owner, Binding credentials, Binding-scoped Workspace Catalogs, Session Intents, Sessions, Runtime Thread mappings, output visibility, idempotency records, Runtime status, Client command state, Transcript blocks, Client events, Binding Liveware Publication lifecycle, and generation-scoped Plugin Durable State. Incompatible legacy Connect-owned schemas are reset or rejected at startup; filesystem-owned Workspace contents and runtime-native Threads remain untouched. The mandatory SQLite provider initializes and validates persistence before downstream Cordis modules activate. Public Plugins receive only namespaced, bounded Durable State operations and never SQL or Core records.

Do not add `sqlite`, `sqlite3`, `node:sqlite`, or `better-sqlite3`.

## Build and quality tooling

Bun owns dependency installation (`bun.lock`), TypeScript execution, `bun:test`, and service bundling. Vite builds the browser-only SPA to `dist/client`; `bun build --target=bun --packages=external` emits service entrypoints under `dist/src`. Release assembly builds and verifies self-contained official Plugin Bundles, includes the official Liveware Bundle's pinned platform companion artifact, and packages the standalone Connect binaries for macOS, Linux, and Windows arm64/x64. Runtime and Client Extension artifacts remain independently installable Plugin assets rather than unconditional Core startup payloads.

Biome owns formatting, import organization, and linting. `tsc --noEmit` remains the independent type check. Generated `dist/` artifacts stay ignored and outside Git history.
