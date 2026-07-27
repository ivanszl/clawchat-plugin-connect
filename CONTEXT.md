# ClawChat Connect

ClawChat Connect binds ClawChat conversations to local agent runtimes while keeping conversation, project, and runtime concepts distinct.

## Language

**Agent Binding**:
A named association between Connect and one configured local agent runtime. A Connect installation may have at most one Agent Binding for each Runtime Adapter kind.
_Avoid_: Agent, when referring to the configured association rather than the external agent itself

**Runtime Adapter**:
A concrete integration that lets Connect start and operate one kind of coding agent runtime. Codex is the first Runtime Adapter, not the definition of Connect or Agent Binding.
_Avoid_: Agent Binding, Codex, when referring to the adapter role

**Connect Service**:
The single host-level Connect process that operates every activated Agent Binding, regardless of Runtime Adapter kind.
_Avoid_: Agent Service, Codex Service, per-agent service

**Connect Owner**:
The single ClawChat user associated with a Connect installation and every activated Agent Binding in it. Activating Connect as a different user replaces the previous Connect Owner rather than adding another owner.
_Avoid_: Agent Binding owner, when implying that Bindings in one installation may have different owners

**Connect Client**:
A local application for administering Connect, observing ClawChat conversations, and interacting with Runtime Threads. Messages originating in the Client remain local rather than being published to ClawChat.
_Avoid_: Connect Console, Frontend

**Client Interface**:
The Connect Service HTTP contract tailored to Connect Client views and user intents. It is loopback-bound by default and may be explicitly exposed to a trusted IPv4 LAN. It exposes Connect-owned presentation models and capabilities rather than runtime-native protocols or UI-framework types.
_Avoid_: Runtime API, app-server API, Astryx API

**Liveware Exposure**:
An optional publication of Connect Client inside ClawChat through a Liveware App. It adds a ClawChat interaction surface without replacing Connect Service, Connect Client, or Client Interface ownership.
_Avoid_: Connect deployment, Liveware Client, when referring to the publication boundary

**Liveware Access Policy**:
The Liveware-owned rule governing which authenticated ClawChat users may enter a Liveware Exposure. `private` admits only the App owner; `public` admits any authenticated ClawChat WebView user.
_Avoid_: Connect authorization, Client Interface authentication

**ClawChat Liveware Registration**:
The ClawChat-owned association from the activated ClawChat Agent to an existing Liveware App. It makes the App discoverable as a launcher tile through the App's `liveware_id` and URL; it is separate from creating the App or binding its tunnel in the Liveware Control Plane.
_Avoid_: Liveware App creation, tunnel registration

**Client Transcript**:
The complete ordered view of displayable turns and runtime activity available to Connect for one Session. It is materialized from the Connect Transcript Projection and includes ClawChat-originated turns and Client-local turns that are not published to ClawChat. It excludes secrets and runtime-private reasoning that was not emitted for display.
_Avoid_: ClawChat History, when Client-local turns are included

**Connect Transcript Projection**:
The Connect-owned normalized event record persisted in SQLite for Client rendering, search, reconnect recovery, event provenance, and output visibility. Connect appends live Runtime Adapter events and reconciles available history from the Runtime Transcript. It is not Agent memory and does not replace or recreate Runtime Thread context.
_Avoid_: Runtime Transcript, Agent Memory, Message Backup

**Project**:
A named, reusable local code workspace that a Session may use. A Project has a root location, but it is not merely a directory path.
_Avoid_: Directory, cwd, repository

**Workspace Group**:
A Connect Client navigation group derived from a Project root or a discovered Runtime Thread's persistent native working directory. Runtime Adapter-classified transient scratch workspaces remain direct Non-Project leaves. The group keeps native threads from unrelated durable workspaces visually separate without pretending every discovered directory is already a registered Project.
_Avoid_: Project, when the group comes only from Runtime Thread discovery

**Session**:
A continuous Connect conversation using one Agent Binding and optionally one Project. A Session owns conversation continuity, not project identity.
_Avoid_: Project, Runtime Thread

**Session Intent**:
The pending Project, mode, model, reasoning effort, and optional name selected for the next Session. It is not a Session and is consumed when the first ordinary message creates that Session.
_Avoid_: Session, Draft Session

**Session Name**:
An optional human-readable label used to display and select a Session. It is not identity; ambiguous names require a Session Ref.
_Avoid_: Session ID, Runtime Thread ID

**Session Ref**:
A stable Connect-owned eight-character handle used to display and select a Session or a discovered Runtime Thread. Connect generates and persists it; adopting a Runtime Thread preserves its Ref. It is not the underlying Session or Runtime Thread identity.
_Avoid_: Session ID prefix, Runtime Thread ID prefix

**Session Catalog**:
The collection of Sessions discoverable from one interaction surface. Connect Client sees every Agent Binding, while a ClawChat control sees only the Agent Binding that received the command.
_Avoid_: Workspace Session List, Runtime Thread Catalog

**Archived Session**:
A Session whose Runtime Thread has been archived through its Runtime Adapter. It remains discoverable and readable in a separate Session Catalog group, but cannot accept another turn until restored.
_Avoid_: Deleted Session, Closed Session

**Non-Project Session**:
A Session that is not associated with a Project. It supports ordinary agent conversation without requiring an existing code workspace.
_Avoid_: Directoryless Session

**Runtime Thread**:
The external agent runtime's resumable conversation associated with a Session. Its identity is owned by the runtime and referenced by Connect.
_Avoid_: Session, Project

**Subagent Thread**:
A child Runtime Thread spawned by an Agent while working in a parent Runtime Thread. It remains part of the parent's Session tree, is not a standalone Session Catalog entry, and its displayable Runtime Transcript is projected into the parent Client Transcript as a collapsed subagent block.
_Avoid_: Session, Agent Binding

**Runtime Transcript**:
The external agent runtime's native durable record for a Runtime Thread. It is authoritative for Agent context and native resume. Connect may read it only through the Runtime Adapter for discovery, backfill, and reconciliation; availability and fidelity vary by runtime.
_Avoid_: Client Transcript, Connect Transcript Projection

**Turn Origin**:
The interaction surface that submitted a turn, either Connect Client or ClawChat. It remains attached to the turn and governs where its Runtime Interactions may be answered.
_Avoid_: Message Source, Channel

**Runtime Interaction**:
A structured request for an authorized human decision or input emitted while a runtime turn is active. It has Connect-owned identity and settlement state independent of the runtime's native request identity.
_Avoid_: Approval, when structured questions are also included; Control Message

## Invariants

- Connect binds and manages multiple Agent Bindings independently of any one runtime kind.
- A Connect installation has at most one Agent Binding for each Runtime Adapter kind.
- A Connect installation has one Connect Owner shared by all activated Agent Bindings; a different owner's activation replaces the existing owner instead of coexisting with it.
- Replacing the Connect Owner transfers the existing Projects, Sessions, and Runtime Threads to the new owner; replacement does not clear or isolate prior local data.
- A Connect installation has one Connect Service; Agent Bindings and Runtime Adapters do not own background services.
- Agent Binding IDs are arbitrary; Runtime Adapter selection comes only from the Binding's explicit `kind`.
- The first release registers only the Codex Runtime Adapter; that is a release scope, not a domain invariant.
- Successful activation synchronizes the Agent Binding ID to the connected ClawChat Profile nickname.
- Projects are global and reusable across Agent Bindings.
- Sessions are scoped by ClawChat conversation and Agent Binding.
- A Session has zero or one Project.
- A Runtime Thread is associated with at most one Session for an Agent Binding. Connect Client and ClawChat operate that same Session rather than creating separate Session copies for one native thread.
- ClawChat control commands create or replace a Session Intent; an ordinary message consumes it. Connect Client may explicitly create an empty Session, and adoption of an existing Runtime Thread also creates a Session.
- Turns from ClawChat and Connect Client are strictly ordered per Session; different Sessions may run concurrently even when they belong to one ClawChat conversation.
- A Session model selection overrides its Agent Binding model default, which overrides the Runtime Adapter default. Reasoning effort resolves independently from a strict Session effort, then a valid Agent Binding effort for the effective model, then the model's advertised default. An unavailable persisted Session selection never silently falls back; an invalid Binding effort falls back because it is only a default.
- Changing Project association creates a Session Intent whose eventual Session starts a new Runtime Thread boundary.
- Connect Client Session Catalog discovery is installation-wide across Projects, Non-Project Sessions, ClawChat conversations, and Agent Bindings.
- Client Interface binds to loopback by default; unauthenticated IPv4 LAN exposure requires an explicit wildcard Host configuration and is not an internet-facing mode.
- Connect Client groups discovered Runtime Threads by persistent native working directory even when that workspace is not yet a registered Project; Runtime Adapter-classified transient scratch workspaces and genuine Non-Project Sessions remain direct catalog leaves.
- Adopting a discovered Runtime Thread with a persistent native working directory registers or reuses the corresponding Project before Connect sends another turn, preserving the Runtime Thread's workspace. A transient scratch Runtime Thread is adopted as a Non-Project Session without creating a Project from its generated directory.
- ClawChat Session Catalog discovery spans Projects, Non-Project Sessions, and ClawChat conversations but is scoped to the Agent Binding that received the command.
- Runtime Thread discovery uses only that Agent Binding's Runtime Adapter and remains scoped to the selected workspace from the Session Intent or current Session; an external Runtime Thread is adopted only through an explicit switch.
- A Runtime Thread and its Runtime Transcript remain authoritative for Agent context and native resume; Connect does not replace them with its own thread or rebuild context by replaying the Client Transcript.
- A Subagent Thread remains part of its parent Runtime Thread's Session tree. Connect does not list it as a standalone Session and projects its available transcript at the parent runtime activity that spawned it.
- Connect persists a Connect Transcript Projection in SQLite. It records every displayable normalized event observed live and reconciles history exposed by the Runtime Adapter without treating SQLite as Agent memory.
- The Connect Transcript Projection is authoritative for Connect-owned metadata such as Session mapping, event provenance, and ClawChat visibility; the Runtime Transcript is authoritative for native Agent context and runtime history.
- When a Runtime Adapter cannot backfill all displayable historical events, Connect preserves the events it observed and reports transcript completeness rather than presenting the projection as complete.
- Runtime Adapter history reads return runtime-neutral entries plus `complete`, `partial`, or `live-only` completeness. Entry provenance distinguishes ordinary runtime history from an Adapter-owned fallback without exposing native storage formats.
- The Codex Runtime Adapter uses app-server as its primary history interface and may supplement omitted displayable tool calls from the matching pinned-version rollout JSONL. Raw rollout records and private reasoning never cross the Runtime Adapter seam.
- ClawChat `outputVisibility` filters remote delivery only and never discards an event from the Connect Transcript Projection.
- Session names are display and selection labels; Session Refs are stable unambiguous selectors, while internal Session and Runtime Thread IDs remain hidden.
- Session lifecycle commands resolve a Session Ref to its native Runtime Thread and are delegated through that Agent Binding's Runtime Adapter.
- An Archived Session remains readable in Connect Client but cannot accept a new turn until its Runtime Thread is restored.
- Permanent deletion succeeds at the runtime before Connect removes the Session mapping and Connect Transcript Projection. Connect does not independently cascade deletion to Subagent Threads.
- A Non-Project Session receives a deterministic isolated workspace and never inherits `process.cwd()`.
- Connect control commands are restricted to the Connect Owner.
- Every runtime turn records its Turn Origin, and every Runtime Interaction inherits that origin.
- A Client-originated Runtime Interaction is visible and answerable only in Connect Client.
- A ClawChat-originated Runtime Interaction is visible in Connect Client and to the Agent Binding owner in ClawChat; the first authorized valid response settles it, and every surface that received it observes the same resolution.
- Connect Client connection state does not own Runtime Interaction lifetime. A pending Client-originated interaction survives Client disconnect and never falls back to ClawChat.
- Client Interface queries are shaped for Connect Client views, and its commands express user intent. Connect Client does not decode runtime-native payloads or reconstruct Connect state from runtime protocols.
- Liveware Exposure changes only how Connect Client is reached and which ClawChat users may enter it; it does not replace or narrow Connect Client or Client Interface behavior.
- Liveware Access Policy is the only remote-entry authorization for a Liveware Exposure. Connect adds no user roles or per-user capability filtering; every admitted user receives the complete Connect Client capability set.
- Connect owns Liveware App provisioning, policy configuration, tunnel binding, ClawChat Liveware Registration, and process coordination for the Liveware Exposure it creates.
- A launcher-visible Liveware Exposure requires both a Liveware Control Plane App and a ClawChat Liveware Registration; creating the App alone does not register it in ClawChat.
- Connect uses its activated ClawChat Agent token for Liveware Control Plane login and ClawChat Liveware Registration. ClawChat and Liveware own the separate user-token and WebView-ticket flow used when a person opens the App.
- Replacing the Connect Owner unregisters the previous ClawChat Liveware Registration, retires the previous owner's Liveware App, creates a new App for the new owner with the existing Liveware Access Policy, and registers the new App in ClawChat; the public URL is not preserved.
- Connect does not expose ClawChat tools or inject a bundled MCP server into Runtime Threads.
- ClawChat Profile updates are explicit authenticated CLI operations.
