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

**Client View Continuity**:
The rule that a reconnecting Connect Client restores the complete latest Client view without replaying transient streaming states. Every committed displayable occurrence remains present, and an older view never replaces a newer view.
_Avoid_: Stream Replay, Exactly-Once Streaming

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
A reusable local code workspace that a Session may use. A Project has a canonical root location and a display name derived from that root; it has no independently customizable alias, but it is not merely a directory path.
_Avoid_: Directory, cwd, repository, custom Project name

**Workspace Group**:
A Connect Client navigation group derived from a Project or a discovered Runtime Workspace Identity. Runtime Adapter-classified transient scratch workspaces remain direct Non-Project leaves. The group keeps native threads from unrelated durable workspaces visually separate without pretending every discovered workspace is already a registered Project.
_Avoid_: Project, when the group comes only from Runtime Thread discovery

**Runtime Workspace Identity**:
A stable runtime-neutral identity reported by a Runtime Adapter for grouping Runtime Threads that belong to the same native workspace. It may include a local root when one exists, but it is not a Connect Project and does not decide Project registration or association.
_Avoid_: Working Directory, Runtime Project, Project

**Workspace ID**:
A stable Connect-owned user-facing identifier derived from a Project's canonical root. It selects Projects consistently across ClawChat controls, Connect Client, and CLI, while the persisted Project ID remains an internal association key.
_Avoid_: Project name, Project ID, when referring to the user-facing selector

**Session**:
A continuous Connect conversation using one Agent Binding and optionally one Project. A Session owns conversation continuity, not project identity.
_Avoid_: Project, Runtime Thread

**Session Continuity**:
The rules that preserve a conversation's selected Session or pending Session Intent, keep Session Ref identity stable as Runtime Threads are created or adopted, and prevent one Runtime Thread from belonging to multiple Sessions for an Agent Binding.
_Avoid_: Session persistence, when referring to the domain rules rather than their storage

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

**Runtime Activity**:
A runtime-neutral displayable occurrence within a Runtime Thread, such as a message, reasoning summary, plan, tool call, command, file change, progress update, usage report, error, or Runtime Interaction. A Runtime Adapter may observe the same Runtime Activity live or recover it from the Runtime Transcript; it is not itself a Client Transcript block.
_Avoid_: Runtime Event, when implying a transport notification; Transcript Block

**Turn Origin**:
The interaction surface that submitted a turn, either Connect Client or ClawChat. It remains attached to the turn and governs where its Runtime Interactions may be answered.
_Avoid_: Message Source, Channel

**Message Sender Identity**:
The stable ClawChat user identity and optional display name attached to a ClawChat-originated user message. It identifies who submitted the message within a direct conversation or group and remains distinct from Turn Origin; authorization uses the stable identity, while presentation uses only the display name.
_Avoid_: Author, when referring to an authorization identity; Turn Origin

**Turn Surface**:
The Connect Client or ClawChat interaction surface through which a turn is submitted and whose origin-specific policy governs its Connect-owned input, output, failure, and Runtime Interaction routes. A ClawChat-originated Runtime Interaction may still have an authorized Connect Client response route. The current browser SPA, whether opened locally, on a trusted LAN, or through Liveware Exposure, is one Connect Client Turn Surface rather than separate Web or Liveware origins.
_Avoid_: Web Origin, Transport, Runtime Adapter

**Turn Submission**:
A Turn Surface's attempt to submit one prompt and its attachments as a single Turn. The submission is accepted as a whole or rejected as a whole; a failed submission never creates a partial Turn or retains partial uploaded media.
_Avoid_: Message Upload, when referring only to one attachment transfer; Partial Turn

**Turn Submission Capability**:
The effective prompt and attachment constraints for a Turn Submission. It is the intersection of the Runtime Adapter's native input capabilities and the submitting Turn Surface's delivery constraints; the Connect Client consumes the effective result rather than defining its own limits.
_Avoid_: Client Upload Limit, Runtime Limit, when either describes only one source of the effective constraint

**Turn Target**:
The immutable Session, Agent Binding, Project, Runtime Thread association, and Session selections captured when Connect accepts a turn for its Session queue. Later Session Intent, selection, or switch changes do not redirect that accepted turn.
_Avoid_: Current Session, when referring to a turn that has already been accepted

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
- Connect defines Project, Session, and Runtime Thread semantics uniformly across Runtime Adapter kinds. Each Runtime Adapter translates its coding agent's native project, workspace, conversation, session, or thread concepts into that Connect model rather than changing the model for its kind.
- Successful activation synchronizes the Agent Binding ID to the connected ClawChat Profile nickname.
- Projects are global and reusable across Agent Bindings.
- A Runtime Workspace Identity maps to at most one Project within its Agent Binding and Runtime Adapter kind. One global Project may be reused by Runtime Workspace Identities from multiple Agent Bindings or Runtime Adapter kinds.
- Sessions are scoped by ClawChat conversation and Agent Binding.
- A Session never changes Agent Binding or Runtime Adapter kind. Choosing a different coding agent creates a new Session that may reuse the same Project; Connect does not transfer Runtime Thread context between coding agents.
- A Session has zero or one Project.
- A Runtime Thread is associated with at most one Session for an Agent Binding. Connect Client and ClawChat operate that same Session rather than creating separate Session copies for one native thread.
- ClawChat control commands create or replace a Session Intent; an ordinary message consumes it. Connect Client may explicitly create an empty Session, and adoption of an existing Runtime Thread also creates a Session.
- Turns from ClawChat and Connect Client are strictly ordered per Session; different Sessions may run concurrently even when they belong to one ClawChat conversation.
- Each accepted turn is bound to an immutable Turn Target before entering the Session queue. Later Session selection changes never redirect queued work to another Session, Project, Agent Binding, or Runtime Thread.
- A Session model selection overrides its Agent Binding model default, which overrides the Runtime Adapter default. Reasoning effort resolves independently from a strict Session effort, then a valid Agent Binding effort for the effective model, then the model's advertised default. An unavailable persisted Session selection never silently falls back; an invalid Binding effort falls back because it is only a default.
- Changing Project association creates a Session Intent whose eventual Session starts a new Runtime Thread boundary.
- Connect Client Session Catalog discovery is installation-wide across Projects, Non-Project Sessions, ClawChat conversations, and Agent Bindings.
- Client Interface binds to loopback by default; unauthenticated IPv4 LAN exposure requires an explicit wildcard Host configuration and is not an internet-facing mode.
- Connect synchronizes every active persistent Runtime Workspace Identity with a usable local root into a Project, reusing an existing Project with the same canonical root and creating only missing Projects. Synchronization never deletes a Project merely because its Runtime Threads are inactive or archived.
- Project synchronization is a one-way projection from Runtime Workspace Identity into Connect; changing or removing a Connect Project does not mutate the runtime's workspace or Runtime Threads.
- Runtime Adapter-classified transient scratch workspaces, archived-only workspaces, identities without a usable local root, and genuine Non-Project Sessions remain outside Project synchronization and appear as direct Non-Project catalog leaves.
- ClawChat Session Catalog discovery spans Projects, Non-Project Sessions, and ClawChat conversations but is scoped to the Agent Binding that received the command.
- The ClawChat `/project` control and Connect Client use the same synchronized Project candidates and root-derived labels for that Agent Binding; archived-only and transient workspaces are excluded, while registered Projects remain selectable without an active Runtime Thread.
- Project names are presentation-only values derived from canonical roots. User-facing Project selection uses Workspace ID rather than Project name, path, or internal Project ID; `/project none` remains the explicit Non-Project control.
- Runtime Thread discovery uses only that Agent Binding's Runtime Adapter and remains scoped to the selected workspace from the Session Intent or current Session; an external Runtime Thread is adopted only through an explicit switch.
- A Runtime Thread and its Runtime Transcript remain authoritative for Agent context and native resume; Connect does not replace them with its own thread or rebuild context by replaying the Client Transcript.
- A Subagent Thread remains part of its parent Runtime Thread's Session tree. Connect does not list it as a standalone Session and projects its available transcript at the parent runtime activity that spawned it.
- Runtime Adapters translate native child threads, delegated runs, and nested tasks into a runtime-neutral Runtime Activity hierarchy. Session association remains on the root Runtime Thread, while the Connect Client owns whether nested Activity is displayed collapsed or expanded.
- Connect persists a Connect Transcript Projection in SQLite. It records every displayable normalized event observed live and reconciles history exposed by the Runtime Adapter without treating SQLite as Agent memory.
- The Connect Transcript Projection is authoritative for Connect-owned metadata such as Session mapping, event provenance, and ClawChat visibility; the Runtime Transcript is authoritative for native Agent context and runtime history.
- When a Runtime Adapter cannot backfill all displayable historical events, Connect preserves the events it observed and reports transcript completeness rather than presenting the projection as complete.
- Runtime Adapter history reads return runtime-neutral entries plus `complete`, `partial`, or `live-only` completeness. Entry provenance distinguishes ordinary runtime history from an Adapter-owned fallback without exposing native storage formats.
- A Runtime Adapter owns identity correlation between live and recovered observations of the same Runtime Activity. It supplies one stable runtime-neutral identity or an explicit alias and reports correlation limitations; the Connect Transcript Projection does not infer identity from matching display content.
- Runtime Adapters expose Runtime Activities as complete current-state upserts. Native start, delta, completion, and fallback records remain inside the Adapter implementation; the Connect Transcript Projection does not reconstruct Activity state from runtime-native deltas.
- Runtime Adapters provide a stable Runtime Thread-local position for each Runtime Activity across live and recovered observations. The Connect Transcript Projection maps that runtime-neutral order into Client Transcript sequence and treats an Adapter-declared ordering limitation as partial completeness instead of guessing from arrival time.
- Runtime Activity kinds are runtime-neutral and closed over Connect's shared display semantics. An Adapter maps an unsupported native kind to a sanitized `unknown` Activity; adapter-specific kinds and raw native payloads never cross the Runtime Adapter seam.
- The Codex Runtime Adapter uses app-server as its primary history interface and may supplement omitted displayable tool calls from the matching pinned-version rollout JSONL. Raw rollout records and private reasoning never cross the Runtime Adapter seam.
- ClawChat `outputVisibility` filters remote delivery only and never discards an event from the Connect Transcript Projection.
- Every displayable Runtime Activity is committed to the Connect Transcript Projection before Turn Surface delivery is attempted. A Turn Surface delivery failure does not remove or hide Activity already projected for the Client Transcript.
- Session names are display and selection labels; Session Refs are stable unambiguous selectors, while internal Session and Runtime Thread IDs remain hidden.
- Session lifecycle commands resolve a Session Ref to its native Runtime Thread and are delegated through that Agent Binding's Runtime Adapter.
- Runtime Adapters report which native Runtime Thread lifecycle operations they support. Connect exposes only those operations and never simulates a missing native archive, restore, or permanent delete by changing local Session state alone.
- An Archived Session remains readable in Connect Client but cannot accept a new turn until its Runtime Thread is restored.
- Permanent deletion succeeds at the runtime before Connect removes the Session mapping and Connect Transcript Projection. Connect does not independently cascade deletion to Subagent Threads.
- A Non-Project Session receives a deterministic isolated workspace and never inherits `process.cwd()`.
- Connect control commands are restricted to the Connect Owner.
- Every runtime turn records its Turn Origin, and every Runtime Interaction inherits that origin.
- A Codex Agent Binding without an explicit approval policy normalizes to `on-request`, allowing Connect to surface Runtime Interactions while still requiring a human decision before an escalation is granted.
- A Client-originated Runtime Interaction is visible and answerable only in Connect Client.
- A ClawChat-originated Runtime Interaction is visible in Connect Client and to the Agent Binding owner in ClawChat; the first authorized valid response settles it, and every surface that received it observes the same resolution.
- Runtime Interaction settlement distinguishes an atomic local claim from confirmed native resolution. The first authorized valid response claims the Interaction; it becomes resolved only after the Runtime Adapter confirms delivery to the native request. Failed delivery ends as failed or expired and never silently reopens the claim.
- Connect Client connection state does not own Runtime Interaction lifetime. A pending Client-originated interaction survives Client disconnect and never falls back to ClawChat.
- Runtime Interaction settlement state belongs to the active runtime process and does not resume after the Connect process, Runtime Adapter connection, or native request ends. Connect persists its presentation and final result, marks a leftover pending presentation expired after restart, and never treats that record as a resumable native request.
- Client Interface queries are shaped for Connect Client views, and its commands express user intent. Connect Client does not decode runtime-native payloads or reconstruct Connect state from runtime protocols.
- Liveware Exposure changes only how Connect Client is reached and which ClawChat users may enter it; it does not replace or narrow Connect Client or Client Interface behavior.
- Liveware Access Policy is the only remote-entry authorization for a Liveware Exposure. Connect adds no user roles or per-user capability filtering; every admitted user receives the complete Connect Client capability set.
- Connect owns Liveware App provisioning, policy configuration, tunnel binding, ClawChat Liveware Registration, and process coordination for the Liveware Exposure it creates.
- A launcher-visible Liveware Exposure requires both a Liveware Control Plane App and a ClawChat Liveware Registration; creating the App alone does not register it in ClawChat.
- Connect uses its activated ClawChat Agent token for Liveware Control Plane login and ClawChat Liveware Registration. ClawChat and Liveware own the separate user-token and WebView-ticket flow used when a person opens the App.
- Replacing the Connect Owner unregisters the previous ClawChat Liveware Registration, retires the previous owner's Liveware App, creates a new App for the new owner with the existing Liveware Access Policy, and registers the new App in ClawChat; the public URL is not preserved.
- Connect does not expose ClawChat tools or inject a bundled MCP server into Runtime Threads.
- ClawChat Profile updates are explicit authenticated CLI operations.
