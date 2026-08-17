# ClawChat Connect

ClawChat Connect binds ClawChat conversations to local agent runtimes while keeping conversation, project, and runtime concepts distinct.

## Language

**Agent Binding**:
A named association between one ClawChat account and one exact installed Runtime Plugin capability. Multiple Agent Bindings may select the same capability, but each owns independent credentials, Sessions, and runtime state.
_Avoid_: Agent, when referring to the configured association rather than the external agent itself

**Runtime Adapter**:
A concrete integration contributed by a Runtime Plugin capability that lets Connect start and operate one coding-agent runtime family. Runtime Adapter remains the internal execution seam; it is not an Agent Binding or a compile-time provider catalog.
_Avoid_: Agent Binding, Codex, when referring to the adapter role

**Runtime Discovery Rule**:
A release-bundled declarative executable lookup and bounded version-command rule from the built-in official Plugin registry that Core evaluates before importing or installing a candidate Runtime Plugin. It reports host presence and executable identity but does not constrain Code Agent runtime version numbers, install, select, activate, or execute Plugin code. ACP, sidecar, and other interface versions remain separate protocol compatibility contracts.
_Avoid_: Runtime Probe, Plugin probe, Runtime health check, startup authorization

**Claude Code Runtime**:
A user-installed Claude Code coding-agent runtime whose native Sessions can be operated through an Agent Binding. Selecting a Claude model through another Runtime Adapter does not make that runtime a Claude Code Runtime.
_Avoid_: Claude model, Anthropic API provider, Claude Runtime

**CodeBuddy Runtime**:
A user-installed CodeBuddy Code CLI installation whose native Sessions can be operated through an Agent Binding. It may expose Agent capabilities also used by WorkBuddy Desktop, but it does not expose WorkBuddy product state; its Sessions and tool-level Tasks are not WorkBuddy Tasks.
_Avoid_: WorkBuddy Runtime, WorkBuddy Task

**CodeBuddy Session**:
A native conversation created or loaded through the CodeBuddy Runtime. Under a WorkBuddy Agent Binding it is Connect-owned, selectable and resumable in ClawChat, and may use the same Workspace as a WorkBuddy Task, but it is not visible or synchronized in WorkBuddy Desktop.
_Avoid_: WorkBuddy Task, WorkBuddy Session, tool Task

**DeepSeek Harness Runtime**:
A user-installed DeepSeek Harness (DSH) coding-agent runtime whose native Sessions and full plugin ecosystem can be operated through an Agent Binding. DSH plugins (tools, skills, workflows, MCP servers, subagents) are installed and owned inside the DSH runtime itself, never through Connect's plugin platform; installing Node.js and DSH is the user's decision, and Connect only integrates when the runtime is present.
_Avoid_: DSH plugin host, DSH Plugin Bundle, when referring to the runtime family

**Binding Runtime Instance**:
The stateful runtime process and adapter state owned by one Agent Binding. Instances of the same exact Runtime Plugin capability remain isolated.
_Avoid_: Runtime Adapter, shared runtime process

**Connect Service**:
The single host-level Connect process that operates every activated Agent Binding, regardless of selected Runtime Plugin capability.
_Avoid_: Agent Service, Codex Service, per-agent service

**Connect Durable State**:
The Connect-owned operational record required to preserve Binding identity, message delivery recovery, Workspace and Session association, policy, request lifecycle, and Client View Continuity across Connect Service restarts. It excludes configuration declarations, Workspace files, Runtime Threads, and Runtime Transcripts.
_Avoid_: Configuration, Runtime State, database

**Plugin Durable State**:
Core-owned transactional JSON state isolated to one Plugin capability instance and preserved across Connect restarts and compatible Plugin updates. Every namespace has one Core-enforced lifetime scope—installation, Installation Owner, or Agent Binding—and its schema and version belong to that Plugin; it contains no credential, token, password, or other secret and is not Plugin configuration, a Core database interface, or authority over another namespace.
_Avoid_: Plugin database, Core Durable State, configuration, Secret Store

**Plugin Host**:
The non-replaceable Connect authority that verifies installed Plugin Bundles, grants only their declared Host Capabilities, publishes eligible contributions, commits selected Bundle generations, and fences lifecycle effects. It is the plugin platform's root of trust rather than another installable Plugin.
_Avoid_: Cordis, Plugin Store, Plugin Bundle

**Activation Generation**:
A Core-issued monotonic identity for one selected Plugin Bundle activation. Every contribution, Plugin Durable State mutation, Client Extension graph, and managed-resource lifecycle operation is fenced to its generation so a replaced generation cannot regain authority.
_Avoid_: Plugin version, Session generation, retry counter

**Installation Owner**:
The single ClawChat user account authorized to own every Agent Binding and administer installation-wide Connect capabilities. The first successful Agent Binding activation establishes it, and only an explicit Owner Reset removes it.
_Avoid_: Binding Owner, when referring to installation-wide authority

**Binding Owner**:
The ClawChat user account whose activation credentials own one Agent Binding. It must equal the Installation Owner; one Installation Owner may own multiple Agent Bindings.
_Avoid_: Installation Owner, when referring only to one Binding's credentials or ClawChat identity

**Owner Reset**:
An explicit local destructive transition that retires the Installation Owner's external Connect resources before atomically deleting all owner-scoped Connect Durable State and returning the installation to an unowned state. It preserves installed Plugin Bundles, Workspace file contents, and runtime-native state.
_Avoid_: Agent Binding removal, factory reset, account switch

**Connect Client**:
A local application for administering Connect, observing ClawChat conversations, and interacting with Runtime Threads. Messages originating in the Client remain local rather than being published to ClawChat.
_Avoid_: Connect Console, Frontend

**Client Extension**:
A trusted same-origin browser contribution from an installed Plugin Bundle that runs in the Connect Client's Cordis tree and composes UI through versioned typed slots and scoped Client Extension capabilities. Its slot-only and no-DOM-patching limits are architectural contracts, not a browser security sandbox; a graph epoch fences its effects and stale mutations.
_Avoid_: Connect Client, iframe app, sandbox, DOM patch, Router Plugin

**Client Kernel**:
The non-replaceable browser bootstrap that loads the Client Plugin graph, owns browser routing and the Cordis root, provides versioned scoped Client services, and renders registered slots over a built-in fallback presentation. It is not the complete Connect Client presentation, whose declared regions may be supplied by Client Extensions; recovery from a broken Client Extension remains available through the local CLI.
_Avoid_: Core Client UI, Client Extension, Connect Client

**Client Interface**:
The Connect Service HTTP contract tailored to Connect Client views and user intents. It is loopback-bound by default and may be explicitly exposed to a trusted IPv4 LAN. It exposes Connect-owned presentation models and capabilities rather than runtime-native protocols or UI-framework types.
_Avoid_: Runtime API, app-server API, Astryx API

**ClawChat Tool Command**:
An explicit authenticated local CLI request addressed by its canonical `clawchat_*` tool name so a local Agent can request one ClawChat capability from Connect Service.
_Avoid_: Grouped CLI command, Runtime Tool, MCP Tool

**Tool Request**:
A durable local request submitted by the CLI for Connect Service to validate and execute as one ClawChat Tool Command or Agent-managed Liveware operation for a selected Agent Binding. Its terminal state remains as the Tool Call Record.
_Avoid_: Client Interface command, direct CLI API call, Runtime Tool call

**Tool Call Record**:
The retained lifecycle, normalized input, bounded outcome, Binding and optional Turn provenance, and timing of one settled Tool Request. Authentication credentials are never part of the record.
_Avoid_: Runtime Activity, Client Transcript block, ClawChat message history

**Tool Catalog**:
The single authoritative collection of Agent-callable ClawChat tool names, descriptions, schemas, execution policy, and handlers from which CLI discovery and skill references are derived.
_Avoid_: Skill tool table, handwritten CLI registry, generated tool reference

**Connect Agent Skill**:
One of Connect's user-scoped instruction packages that teaches a local Agent to use ClawChat Tool Commands or deploy Agent-Managed Liveware Apps without registering runtime-native tools.
_Avoid_: Runtime Tool, MCP Server, repository skill

**Runtime Skill**:
A named reusable workflow that a coding-agent runtime reports as explicitly user-invocable for one Agent Binding and runtime workspace. Connect carries only its safe summary and Runtime Adapter-owned opaque selection identity; discovery, content, enablement, permissions, and native invocation remain runtime-owned.
_Avoid_: Connect Agent Skill, Connect-discovered Skill, generic slash command

**Runtime Command**:
A named user-invocable command that a coding-agent runtime reports for one Agent Binding and runtime workspace. Connect displays Runtime Commands and Runtime Skills in one slash picker but preserves their distinct Runtime Adapter-owned identities through submission and native invocation.
_Avoid_: ClawChat Tool Command, Connect control command, Runtime Skill

**ClawChat Turn Context**:
Connect-derived Agent-visible metadata attached to one ClawChat-originated turn. It identifies the exact conversation, message, sender, conversation type, and known mentions without treating user-authored text as authoritative metadata.
_Avoid_: Prompt text, process environment, Client Turn context

**ClawChat Addressing Mention**:
The single leading ClawChat Agent Mention used to address a group control command or textual Runtime Interaction response. It is addressing metadata rather than user-authored prompt content and is distinct from display-name text or any other mention in the message.
_Avoid_: Prompt mention, command prefix

**ClawChat Agent Mention**:
A structured group-message mention whose stable user identity matches the activated ClawChat Agent. It makes a message eligible under mention-only Group Intake Policy, joins the conversation's pending Group Message Batch, and causes that entire Batch to submit immediately; visible display-name text is not an Agent Mention.
_Avoid_: Text mention, Addressing Mention, when the mention is not the leading command or interaction address

**Group Intake Policy**:
The rule selected for one Agent Binding in one ClawChat group that governs whether inbound messages are muted, mention-only, or eligible for delayed batching. Muting suppresses Runtime Turns without preventing Connect from receiving the messages; muted messages and pending Batches are not replayed after unmute. A group without an authoritative selected rule defaults to mention-only.
_Avoid_: Group permissions, Runtime policy

**Group Settings Snapshot**:
The complete authoritative read-only view of one Agent Binding's per-conversation Group Intake Policies, persisted with each row scoped by Binding and ClawChat conversation independently of Workspace or installation-wide group identity. A content-free change notification invalidates the affected Binding's current view and requires a refresh; a failed or non-authoritative refresh preserves only a Snapshot that has not been marked stale.
_Avoid_: Notification payload, writable Connect configuration

**Group Message Batch**:
An ordered collection of eligible messages from one ClawChat group submitted to the Agent Binding as a single Runtime Turn. Its activity delay is an inactivity interval, with a maximum wait that is never shorter than the selected delay; its final message is the ClawChat reply anchor without becoming the sole sender or source of the Batch. A Batch is bounded to 64,000 rendered characters and ten attachments and splits before a newly appended message would exceed either limit.
_Avoid_: Offline batch, Runtime queue

**Group Mention Context**:
Up to ten recent group messages supplied as read-only context with an ordinary mention-only Runtime Turn because those messages did not previously enter the Runtime. It excludes the current message or Batch, is not added to delayed Batch Turns or group control commands, and does not itself request a response.
_Avoid_: Group Message Batch, replay backlog

**No-Reply Signal**:
A model-emitted group-response marker whose canonical form is `<clawchat:no-reply/>` and whose recognized compatibility forms carry the same `clawchat:no-reply` meaning. It requests that Connect publish no ordinary textual or Runtime Activity response for the originating group Turn and is never itself user-visible content; explicit media in the terminal response remains deliverable with the marker removed from its caption. Direct-message Turns do not use this protocol.
_Avoid_: Empty response, No replay, Silent message

**ClawChat Output Visibility**:
The effective `minimal`, `normal`, or `full` policy selected for one Agent Binding and conversation that determines which Runtime Activities are eligible for remote delivery. It never removes activities from the Connect Transcript Projection and is applied before any No-Reply Signal veto.
_Avoid_: Runtime logging level, Client Transcript filter

**Client View Continuity**:
The rule that a reconnecting Connect Client restores the complete latest Client view without replaying transient streaming states. Every committed displayable occurrence remains present, and an older view never replaces a newer view.
_Avoid_: Stream Replay, Exactly-Once Streaming

**Client Exposure**:
A public trusted-Plugin capability that publishes the existing Connect Client through a generation-fenced Core-mediated Client fetch facade. It owns external publication resources and launcher integration, not Host or Origin enforcement, Client Interface semantics, Client presentation, Session routing, ordinary ClawChat message transport, raw credentials, gateway configuration, or Plugin administration.
_Avoid_: Connect Client, Client Extension, deployment

**Liveware Exposure**:
The installation-scoped Client Exposure contributed by the official Liveware Plugin. It publishes one private Connect Client through the Core-owned Shared Client Gateway and one Binding Liveware Publication for each activated Agent Binding.
_Avoid_: Shared Liveware App, per-Binding Client

**Binding Liveware Publication**:
The Agent Binding-scoped publication of the installation-wide Connect Client through one private managed Liveware App, one tunnel to the Shared Client Gateway, and one ClawChat Liveware Registration. Its App, URL, tunnel, registration, and management authority are independent of every other Binding's publication.
_Avoid_: Liveware Exposure, shared App, Binding-Scoped Client

**Connect Client Locale**:
The language used for Connect Client interface copy across local, trusted-LAN, and Client Exposure entrypoints. It is one of Simplified Chinese, Traditional Chinese, English, Japanese, Spanish, or Korean and does not translate user-authored or Runtime-authored content.
_Avoid_: Content language, Runtime language, translation mode

**Shared Client Gateway**:
The Core-owned loopback HTTP boundary used by the official Liveware Exposure to reach the installation-wide Client Interface. Core preserves Host and Origin constraints, rejects untrusted owner or Agent Binding scope headers, and gives the Liveware Plugin only its opaque upstream address; other Client Exposure Plugins receive the narrower Core-mediated Client fetch facade.
_Avoid_: Binding-Scoped Client Gateway, Plugin-owned gateway, public reverse proxy

**Agent-Managed Liveware App**:
An additional Liveware App that a local Agent deploys for a user-requested local web service through Connect's credential-safe Liveware command boundary and registers into ClawChat. It is independent of the Liveware Exposure managed for Connect Client.
_Avoid_: Liveware Exposure, ClawChat Connect App

**Liveware Access Policy**:
The Liveware-owned admission rule for every Binding Liveware Publication in the installation-scoped Liveware Exposure. Connect permits only `private`, which admits the Installation Owner through authenticated ClawChat Liveware; `off` means no Liveware Exposure is active, and an ordinary browser request to the App URL remains unauthorized.
_Avoid_: Connect authorization, public browser access, Client Interface authentication

**ClawChat Liveware Registration**:
The ClawChat-owned association from the activated ClawChat Agent to an existing Liveware App. It makes the App discoverable as a launcher tile through the App's `liveware_id` and URL; it is separate from creating the App or binding its tunnel in the Liveware Control Plane.
_Avoid_: Liveware App creation, tunnel registration

**Client Transcript**:
The complete ordered view of displayable turns and runtime activity available to Connect for one Session. It is materialized from the Connect Transcript Projection and includes ClawChat-originated turns and Client-local turns that are not published to ClawChat. It excludes secrets and runtime-private reasoning that was not emitted for display.
_Avoid_: ClawChat History, when Client-local turns are included

**Connect Transcript Projection**:
The Connect-owned normalized event record held in Connect Durable State for Client rendering, search, reconnect recovery, event provenance, and output visibility. Connect appends live Runtime Adapter events and reconciles available history from the Runtime Transcript. It is not Agent memory and does not replace or recreate Runtime Thread context.
_Avoid_: Runtime Transcript, Agent Memory, Message Backup

**Workspace**:
A Binding-scoped code environment that a Session uses with one exact Agent Binding and Runtime Plugin capability. A Workspace is either the Binding Default Workspace or a runtime-reported workspace; Workspaces under different Bindings remain distinct even when they share one local root.
_Avoid_: Project, directory, cwd, repository

**Workspace Catalog**:
The workspace selection available to one Agent Binding: its one Binding Default Workspace plus the workspaces reported by its Runtime Adapter, together with the Adapter's `complete`, `partial`, or `unavailable` catalog status. A runtime-reported workspace matching the Default Workspace's canonical local root is associated with that one entry rather than displayed separately.
_Avoid_: Project Catalog, Runtime Thread Catalog

**Runtime Workspace Identity**:
A stable runtime-neutral identity reported by a Runtime Adapter to associate a runtime-native workspace and its Runtime Threads with one Binding-scoped Workspace. It may include a local root, but it is scoped to the exact Agent Binding and Runtime Plugin capability and is never the user-facing selector.
_Avoid_: Working Directory, Workspace Ref, Project

**Binding Default Workspace**:
The Connect-created local Workspace dedicated to one Agent Binding and used as that Binding's runtime working directory when a Session has no explicit workspace selection. Exactly one exists per Binding and appears once in its Workspace Catalog.
_Avoid_: Non-Project workspace, Runtime Workspace Identity, Project

**Workspace Ref**:
A stable Connect-owned handle that identifies one Workspace within its Agent Binding. Names, local paths, and runtime-native workspace identities are never used as the user-facing selector.
_Avoid_: Workspace name, local path, Runtime Workspace Identity, Project ID

**Session**:
A continuous Connect conversation using one Agent Binding and exactly one Workspace. A Session owns conversation continuity, not Workspace identity.
_Avoid_: Workspace, Runtime Thread

**Session Continuity**:
The rules that preserve a conversation's selected Session or pending Session Intent, keep Session Ref identity stable as Runtime Threads are created or adopted, and prevent one Runtime Thread from belonging to multiple Sessions for an Agent Binding.
_Avoid_: Session persistence, when referring to the domain rules rather than their storage

**Session Intent**:
The pending Workspace, mode, model, reasoning effort, and optional name selected for the next Session. It is not a Session and is consumed when the first ordinary message creates that Session.
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


**Runtime Thread**:
The external agent runtime's resumable conversation associated with a Session. Its identity is owned by the runtime and referenced by Connect.
_Avoid_: Session, Workspace

**WorkBuddy Distribution**:
The mainland China WorkBuddy desktop product. It bundles its own product-configured CodeBuddy Runtime and remains isolated from the separately versioned WorkBuddy AI Distribution.
_Avoid_: WorkBuddy AI Distribution, CodeBuddy Runtime

**WorkBuddy AI Distribution**:
The international WorkBuddy AI desktop product. It bundles its own product-configured CodeBuddy Runtime and remains isolated from the separately versioned WorkBuddy Distribution.
_Avoid_: WorkBuddy Distribution, CodeBuddy Runtime

**WorkBuddy Task**:
A top-level WorkBuddy Desktop conversation or work item that owns product transcript projection, artifacts, connector wiring, UI metadata, and desktop lifecycle in addition to an underlying CodeBuddy Session. Connect represents it as a Runtime Thread identified durably by its stable Task ID; it is neither a standalone CodeBuddy Session nor a WorkBuddy Automation.
_Avoid_: WorkBuddy Session, CodeBuddy Session, WorkBuddy Automation, tool Task

**WorkBuddy Task ACP Endpoint**:
A private desktop-owned ACP service for one active WorkBuddy Task through which a verified client can replay and continue that Task. It is lifecycle-bound and has no supported public discovery contract; it is not a direct CodeBuddy ACP process owned by Connect.
_Avoid_: Public WorkBuddy API, direct CodeBuddy ACP

**WorkBuddy Task Attachment**:
A verified relationship in which one Agent Binding operates an existing WorkBuddy Task through its WorkBuddy Task ACP Endpoint and shares the Task's conversation and visible outputs with WorkBuddy Desktop. Its connection and authorization state are ephemeral and must be rediscovered and reverified after loss or rotation.
_Avoid_: WorkBuddy Task, Runtime Thread mapping, CodeBuddy Session, direct ACP session

**WorkBuddy Automation**:
A WorkBuddy Desktop workflow configured to run from a schedule or another trigger. Its executions and outputs are distinct from an ordinary WorkBuddy Task and from a CodeBuddy Session.
_Avoid_: WorkBuddy Task, CodeBuddy Session

**Indeterminate Prompt Outcome**:
A prompt whose native acceptance or completion cannot be proven from the reloaded authoritative Runtime Transcript after Attachment loss. Connect surfaces the uncertainty and never automatically resubmits or reports the prompt as successful.
_Avoid_: Failed Prompt, Retriable Prompt

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
The Connect Client or ClawChat interaction surface through which a turn is submitted and whose origin-specific policy governs its Connect-owned input, output, failure, and Runtime Interaction routes. A Runtime Interaction remains exclusively on the Turn Surface that originated its turn. The current browser SPA, whether opened locally, on a trusted LAN, or through Liveware Exposure, is one Connect Client Turn Surface rather than separate Web or Liveware origins.
_Avoid_: Web Origin, Transport, Runtime Adapter

**Turn Submission**:
A Turn Surface's attempt to submit one prompt and its attachments as a single Turn. The submission is accepted as a whole or rejected as a whole; a failed submission never creates a partial Turn or retains partial uploaded media.
_Avoid_: Message Upload, when referring only to one attachment transfer; Partial Turn

**Turn Submission Capability**:
The effective prompt and attachment constraints for a Turn Submission. It is the intersection of the Runtime Adapter's native input capabilities and the submitting Turn Surface's delivery constraints; the Connect Client consumes the effective result rather than defining its own limits.
_Avoid_: Client Upload Limit, Runtime Limit, when either describes only one source of the effective constraint

**Turn Target**:
The immutable Session, Agent Binding, Workspace, Runtime Thread association, and Session selections captured when Connect accepts a turn for its Session queue. Later Session Intent, selection, or switch changes do not redirect that accepted turn.
_Avoid_: Current Session, when referring to a turn that has already been accepted

**Runtime Interaction**:
A structured request for an authorized human decision or input emitted while a runtime turn is active. It has Connect-owned identity and settlement state independent of the runtime's native request identity.
_Avoid_: Approval, when structured questions are also included; Control Message

## Invariants

- Connect binds and manages multiple Agent Bindings independently of any coding-agent runtime family.
- Multiple Agent Bindings may select the same exact Runtime Plugin capability.
- Every Agent Binding owns an independent Binding Runtime Instance. Runtime process, provider configuration, cached client state, and shutdown lifecycle are never shared between Agent Bindings, including Bindings that select the same capability.
- Runtime Skill and Runtime Command discovery and cached summaries remain scoped to one Agent Binding and runtime workspace. Connect never derives them by scanning local instruction files, and the active Runtime Adapter remains authoritative when a selected entry is invoked. A manually typed same-name prefix resolves to a Runtime Command before a Runtime Skill, while an explicit picker selection retains its selected kind.
- A Connect installation has at most one Installation Owner. The first successful Agent Binding activation establishes it.
- Every activated Agent Binding has exactly one Binding Owner, and that identity must equal the Installation Owner.
- A later activation whose Binding Owner differs from the Installation Owner is rejected before local state changes. Reactivating a Binding for the same owner refreshes only that Binding's credentials.
- Owner Reset is an explicit local Core operation. It stops new owner-scoped work, retires external Connect resources while credentials remain available, then atomically purges every Agent Binding, owner-scoped Connect Durable State, and owner- and Binding-scoped Plugin Durable State before clearing the Installation Owner.
- A failed external retirement leaves the Installation Owner, credentials, and all scoped state available for retry. Successful Owner Reset preserves installed Plugin Bundles, Plugin installation metadata, installation-scoped Plugin Durable State, Workspace file contents, and runtime-native Threads and Transcripts.
- Removing an Agent Binding retires its external resources before removing its Client Exposure launcher registration, credentials, Connect Durable State, Binding-scoped Plugin Durable State, Workspace records, Client commands/events, and staged Turn Submissions; only then may its ID be reused. Unrelated Bindings, installed Plugin Bundles, installation- and owner-scoped Plugin Durable State, Workspace file contents, and runtime-native state remain intact.
- A Connect installation has one Connect Service; Agent Bindings and Runtime Adapters do not own background services.
- Cordis is Connect's single internal composition and lifecycle mechanism. Mandatory Core modules are mounted in the same root but cannot be removed, disabled, or replaced by an installed Plugin Bundle.
- The Plugin Host exposes a versioned Connect Plugin Context rather than raw Cordis. Installed Plugins are trusted in-process code, may require only declared Host Capabilities, and cannot depend on another user Plugin.
- Managed-resource lifecycle has explicit `absent`, `provisioning`, `active`, `degraded`, `retiring`, and `retired` states. Disable, removal, Binding removal, and Owner Reset durably enter `retiring` before external work; normal reconciliation cannot recreate a retiring resource, and lifecycle operations are serialized and generation-fenced.
- A Plugin Bundle may request Plugin Durable State only through its declared Host Capability. Core scopes every operation by Plugin identity, capability identity, capability-instance identity, Activation Generation, and one declared lifetime of installation, Installation Owner, or Agent Binding; validates versioned JSON; and exposes no SQL, database schema, filesystem path, or other Plugin namespace.
- The initial Plugin interface has no Plugin secret field, secret store, or raw credential Host Capability. Plugin configuration and Plugin Durable State must not contain credentials, tokens, passwords, or authorization values; Core retains Binding credentials and offers only narrow credential-using operation ports. Runtime Plugins use their native Runtime's authentication, and a Plugin that must directly own a vendor API secret is unsupported.
- Core creates and deletes lifetime scopes rather than trusting Plugin-authored keys: installation state survives Owner Reset, owner state is purged after successful Owner Reset, and Binding state is purged after that Binding's external resources retire. Disable preserves every scope after retiring managed resources; Plugin removal deletes every scope only after all managed external resources retire.
- Plugin replacement first imports, registers, validates configuration, and migrates a copied state without externally visible effects. Core then atomically commits the selected Bundle version, configuration, migrated state, and next Activation Generation; the new generation starts afterward, becomes available only after every required capability starts, and remains selected in a visible `error` state if start fails. External side effects are lifecycle-managed but are not claimed to be transactionally atomic, and Core never automatically rolls back to an older generation.
- Managed external-resource identity survives a Plugin update through Plugin Durable State. A stable correlation key and intent are committed before each remote create, authoritative lookup resolves an interrupted result before any retry, and Activation Generation fencing prevents a replaced generation from mutating state or resources.
- Public Plugin Bundles may contribute Runtime Adapter, Client Exposure, and Client Extension capabilities after the same source-independent validation. Agent tools, ClawChat commands and transport, Workspace Catalog, media and artifact storage, credential sources, output rendering, Session behavior, Client Interface, and Core policy are not public provider seams.
- Connect Core owns the persistence contract and migration policy; the mandatory official SQLite Provider owns schema and SQL migration mechanics behind an internal Cordis service. No user Plugin can register a persistence provider or Core database migration.
- Agent Binding IDs are arbitrary; Runtime provider selection comes only from the Binding's exact `runtime.pluginId` and `runtime.capabilityId`.
- The Runtime Adapter Registry starts empty. Installed and active Plugin Bundles contribute Codex, OpenCode, WorkBuddy, or third-party Runtime capabilities; Connect has no built-in released Adapter catalog.
- Connect defines Workspace, Workspace Catalog, Session, and Runtime Thread semantics uniformly across Runtime Plugin capabilities. Each Runtime Adapter translates its native workspace, conversation, session, or thread concepts into that Connect model rather than changing the model for its family.
- Successful activation synchronizes the Agent Binding ID to the connected ClawChat Profile nickname.
- Workspaces are scoped to one Agent Binding and exact Runtime Plugin capability. Two Bindings never share Workspace identity, including when their entries have the same canonical local root.
- Every Agent Binding has exactly one Binding Default Workspace, created by Connect and always present exactly once in that Binding's Workspace Catalog.
- A Runtime Workspace Identity maps to at most one Workspace within its Agent Binding and exact Runtime Plugin capability. Core assigns the Workspace Ref and associates a runtime-reported entry whose canonical local root matches the Binding Default Workspace with that existing Workspace.
- Sessions are scoped by ClawChat conversation and Agent Binding.
- A Session uses exactly one Workspace. After its first accepted Turn or native Runtime Thread adoption, it never changes Agent Binding, Runtime Plugin capability, or Workspace; choosing another Agent or Workspace creates a new Session without transferring Runtime Thread context.
- A Runtime Thread is associated with at most one Session for an Agent Binding. Connect Client and ClawChat operate that same Session rather than creating separate Session copies for one native thread.
- A WorkBuddy Agent Binding has two explicit Runtime Thread targets: a namespaced CodeBuddy Session or a stable WorkBuddy Task ID. Both remain selectable in ClawChat and use the ordinary Workspace model; only the WorkBuddy Task is synchronized with WorkBuddy Desktop.
- A persisted WorkBuddy Task mapping retains only the selected distribution profile, stable WorkBuddy Task ID, and ordinary Session data. A persisted CodeBuddy Session mapping retains only its namespaced native Session ID and ordinary Session data. Process IDs, service endpoints, connections, credentials, tokens, passwords, and authorization values remain runtime-local and ephemeral.
- Every new or recovered WorkBuddy Task Attachment rediscovers and reverifies the Task's profile, process, workspace, and authoritative Runtime Transcript. WorkBuddy UI selection changes do not alter an already adopted stable Task identity.
- WorkBuddy prompts with uncertain native acceptance are never automatically resubmitted. Recovery reconciles the authoritative Runtime Transcript, projects WorkBuddy-native turns committed while disconnected exactly once, and prevents those recovered turns from being republished to ClawChat as new inbound requests.
- ClawChat control commands create or replace a Session Intent; an ordinary message consumes it. Connect Client may explicitly create an empty Session, and adoption of an existing Runtime Thread also creates a Session.
- Turns from ClawChat and Connect Client are strictly ordered per Session; different Sessions may run concurrently even when they belong to one ClawChat conversation.
- Each accepted turn is bound to an immutable Turn Target before entering the Session queue. Later Session selection changes never redirect queued work to another Session, Workspace, Agent Binding, or Runtime Thread.
- A Session model selection overrides its Agent Binding model default, which overrides the Runtime Adapter default. Reasoning effort resolves independently from a strict Session effort, then a valid Agent Binding effort for the effective model, then the model's advertised default. An unavailable persisted Session selection never silently falls back; an invalid Binding effort falls back because it is only a default.
- Changing Workspace selection creates a Session Intent whose eventual Session starts a new Runtime Thread boundary.
- The Connect Client Session Catalog is installation-wide across Agent Bindings, their Binding-scoped Workspace Catalogs, ClawChat conversations, and Sessions for the Installation Owner. Local, trusted-LAN, and private Client Exposure entrypoints present the same scope.
- Client Interface binds to loopback by default; unauthenticated IPv4 LAN exposure requires an explicit wildcard Host configuration and is not an internet-facing mode. Plugin administration remains reachable only from a socket peer verified as loopback, including the private loopback Shared Client Gateway, and never trusts forwarded peer headers.
- Core owns each Workspace Catalog and aggregates its Binding Default Workspace with entries reported by that Binding's Runtime Adapter. Runtime Plugins provide source identities and completeness; they do not allocate Workspace Refs, replace Catalog semantics, or merge entries across Bindings.
- A `complete` Runtime Adapter snapshot may make an omitted runtime-reported Workspace unavailable for new selection while preserving its identity for existing Sessions. A `partial` or `unavailable` snapshot never erases an earlier association.
- ClawChat `/workspace` controls and Connect Client use the same Workspace Catalog candidates for the selected Agent Binding. The Binding Default Workspace remains selectable even when runtime discovery is unavailable.
- User-facing Workspace selection uses Workspace Ref rather than label, local path, or Runtime Workspace Identity. A Workspace chosen for another Agent must resolve independently inside that target Agent Binding's Catalog.
- Runtime Thread discovery uses only that Agent Binding's Runtime Adapter and remains scoped to the Workspace from the Session Intent or current Session; an external Runtime Thread is adopted only through an explicit switch.
- A Runtime Thread and its Runtime Transcript remain authoritative for Agent context and native resume; Connect does not replace them with its own thread or rebuild context by replaying the Client Transcript.
- A Subagent Thread remains part of its parent Runtime Thread's Session tree. Connect does not list it as a standalone Session and projects its available transcript at the parent runtime activity that spawned it.
- Runtime Adapters translate native child threads, delegated runs, and nested tasks into a runtime-neutral Runtime Activity hierarchy. Session association remains on the root Runtime Thread, while the Connect Client owns whether nested Activity is displayed collapsed or expanded.
- Connect persists a Connect Transcript Projection through the Core persistence service. It records every displayable normalized event observed live and reconciles history exposed by the Runtime Adapter without treating Connect Durable State as Agent memory.
- The Connect Transcript Projection is authoritative for Connect-owned metadata such as Session mapping, event provenance, and ClawChat visibility; the Runtime Transcript is authoritative for native Agent context and runtime history.
- When a Runtime Adapter cannot backfill all displayable historical events, Connect preserves the events it observed and reports transcript completeness rather than presenting the projection as complete.
- Runtime Adapter history reads return runtime-neutral entries plus `complete`, `partial`, or `live-only` completeness. Entry provenance distinguishes ordinary runtime history from an Adapter-owned fallback without exposing native storage formats.
- A Runtime Adapter owns identity correlation between live and recovered observations of the same Runtime Activity. It supplies one stable runtime-neutral identity or an explicit alias and reports correlation limitations; the Connect Transcript Projection does not infer identity from matching display content.
- Runtime Adapters expose Runtime Activities as complete current-state upserts. Native start, delta, completion, and fallback records remain inside the Adapter implementation; the Connect Transcript Projection does not reconstruct Activity state from runtime-native deltas.
- Runtime Adapters provide a stable Runtime Thread-local position for each Runtime Activity across live and recovered observations. The Connect Transcript Projection maps that runtime-neutral order into Client Transcript sequence and treats an Adapter-declared ordering limitation as partial completeness instead of guessing from arrival time.
- Runtime Activity kinds are runtime-neutral and closed over Connect's shared display semantics. An Adapter maps an unsupported native kind to a sanitized `unknown` Activity; adapter-specific kinds and raw native payloads never cross the Runtime Adapter seam.
- The Codex Runtime Adapter uses app-server as its primary history interface and may supplement omitted displayable tool calls from the matching pinned-version rollout JSONL. Raw rollout records and private reasoning never cross the Runtime Adapter seam.
- ClawChat Output Visibility is resolved from a Binding-scoped chat override, then the Agent Binding default, then the installation default. It filters remote delivery only and never discards an event from the Connect Transcript Projection. For a group Turn, a terminal No-Reply Signal vetoes every ordinary textual or Runtime Activity output that survived that filter without removing projected Runtime Activities or making another output kind visible. Required control output is delivered immediately and remains visible even if the group Turn later ends with a No-Reply Signal; explicit media in the terminal response remains deliverable after the marker is removed from its caption. Direct-message delivery is unchanged.
- Every displayable Runtime Activity is committed to the Connect Transcript Projection before Turn Surface delivery is attempted. A Turn Surface delivery failure does not remove or hide Activity already projected for the Client Transcript.
- Session names are display and selection labels; Session Refs are stable unambiguous selectors, while internal Session and Runtime Thread IDs remain hidden.
- Session lifecycle commands resolve a Session Ref to its native Runtime Thread and are delegated through that Agent Binding's Runtime Adapter.
- Runtime Adapters report which native Runtime Thread lifecycle operations they support. Connect exposes only those operations and never simulates a missing native archive, restore, or permanent delete by changing local Session state alone.
- An Archived Session remains readable in Connect Client but cannot accept a new turn until its Runtime Thread is restored.
- Permanent deletion succeeds at the runtime before Connect removes the Session mapping and Connect Transcript Projection. Connect does not independently cascade deletion to Subagent Threads.
- A Session without an explicit runtime-reported Workspace uses its Binding Default Workspace and never inherits `process.cwd()`.
- Connect control commands are restricted to the Binding Owner of the Agent Binding that received them.
- Direct messages are addressed to the Agent Binding without a mention. Group messages enter Runtime Turn routing according to the effective Group Intake Policy: muted messages create no Runtime Turn, mention-only mode requires a ClawChat Agent Mention, and other eligible messages enter a Group Message Batch. A ClawChat Agent Mention joins and immediately submits the whole pending Batch in original message order; only a ClawChat Addressing Mention expresses control-command or textual Runtime Interaction response intent and is excluded from effective prompt content.
- Enabling mute discards any pending Group Message Batch for that conversation. Disabling mute applies only to subsequently received group messages and never replays messages received while muted.
- Connect consumes Group Settings Snapshots as read-only state and never writes a default policy back to ClawChat. Snapshot persistence is scoped by Agent Binding and conversation and remains independent of Workspace. A settings-change notification marks the affected Binding's Snapshot stale and triggers a bounded group-only refresh gate; direct messages never wait on it, and a timeout uses a non-stale trusted Snapshot or the mention-only default.
- An authoritative Group Settings Snapshot replaces the complete persisted set for only its Agent Binding; an absent conversation or authoritative empty set removes prior rows, while a non-authoritative fetch never clears them. A stale persisted Snapshot is not used for routing until an authoritative refresh replaces it.
- A refreshed Group Intake Policy takes effect without restarting Connect and immediately reconciles an existing Batch: mute discards it, mention-only discards one without an Agent Mention, a changed delay recomputes its idle and maximum deadlines from original message times, and zero delay submits it immediately. Relaxing a policy affects only new messages and never resurrects discarded input.
- Group Intake Policy is resolved again when a Group Message Batch is ready to submit so a newly muted or mention-only group cannot dispatch a stale pending Batch.
- An ordinary mention-only group Turn carries Group Mention Context for understanding prior discussion. Delayed Batch Turns and group control commands never receive that additional history, and context messages never become separate actionable inputs.
- A recognized group control command never becomes Group Message Batch content. A command that changes the Session or its subsequent runtime choices first submits an existing Batch and then executes in conversation order; inspection, output-visibility, and cancellation commands execute immediately without changing the pending Batch.
- A Group Message Batch reply and its Runtime Interactions quote the Batch's final source message. Every constituent message retains its own stable identity, sender, structured mentions, order, and attachments in the Runtime Turn context.
- Group Message Batch capacity is enforced between messages rather than by truncating content: Connect submits the current Batch before an appended message would cross 64,000 rendered characters or ten attachments, then starts another Batch with that intact message. An individually invalid message fails visibly and is never silently dropped.
- An unsubmitted Group Message Batch remains recoverable from its constituent durable inbound messages across Connect restart. Recovery preserves original ordering and timing deadlines, re-evaluates current Group Intake Policy and capacity, and marks each constituent handled only after the Runtime accepts the reconstructed Batch.
- A zero-second Group Intake Policy is real-time delivery: each eligible message becomes its own Runtime Turn immediately and is ordered only by the existing Session Queue, never merged into a same-tick micro-batch.
- Every runtime turn records its Turn Origin, and every Runtime Interaction inherits that origin.
- A Codex Agent Binding without an explicit approval policy normalizes to `on-request`, allowing Connect to surface Runtime Interactions while still requiring a human decision before an escalation is granted.
- A Runtime Interaction is visible and answerable only through its originating Turn Surface and, for ClawChat, its originating direct or group conversation; it never falls back or duplicates into another response route.
- Any participant in an originating group may submit a Runtime Interaction response in the current release, including a Session-scoped approval; restricting group response authority is a deferred release concern rather than a domain invariant.
- Runtime Interaction settlement distinguishes an atomic local claim from confirmed native resolution. The first authorized valid response claims the Interaction; it becomes resolved only after the Runtime Adapter confirms delivery to the native request. Failed delivery ends as failed or expired and never silently reopens the claim.
- Connect Client connection state does not own Runtime Interaction lifetime. A pending Client-originated interaction survives Client disconnect and never falls back to ClawChat.
- Runtime Interaction settlement state belongs to the active runtime process and does not resume after the Connect process, Runtime Adapter connection, or native request ends. Connect persists its presentation and final result, marks a leftover pending presentation expired after restart, and never treats that record as a resumable native request.
- Client Interface queries are shaped for Connect Client views, and its commands express user intent. Connect Client does not decode runtime-native payloads or reconstruct Connect state from runtime protocols.
- The Client Kernel owns browser routing, bootstrap, browser Cordis root, scoped Client services, and a built-in fallback presentation. A Client Extension contributes only to declared versioned typed slots and never registers browser or server routes, patches the DOM, or replaces the Kernel; because it is trusted same-origin code, these are architectural contracts rather than a security boundary.
- Client Extensions share the Kernel-provided React and Astryx singletons. One server-selected Plugin graph hash defines a browser graph epoch; a graph change fully disposes the old graph and loads the new graph, or forces a full-page reload when clean replacement cannot be proven. Styles, subscriptions, timers, child slots, and typed Client service mutations are epoch-bound, and Core rejects a mutation from a stale epoch.
- A Client Exposure is an optional public trusted-Plugin capability that publishes the existing installation-wide Connect Client through a generation-fenced Core-mediated fetch facade without owning Host or Origin enforcement, gateway configuration, raw credentials, Client Interface semantics, Client presentation, Session routing, ordinary ClawChat message transport, or Plugin administration. Local Client access remains available when every Exposure is absent or erroneous.
- Core owns one Shared Client Gateway for the installation. The official Liveware Exposure acquires its opaque loopback endpoint; other Client Exposure Plugins use the narrower Core-mediated fetch facade. Core starts the Gateway for the first active lease and stops it after the final lease releases it.
- The official Liveware Plugin owns one installation-scoped Liveware Exposure with one Binding Liveware Publication per activated Agent Binding; it never owns the Shared Client Gateway. Public Liveware access is unsupported.
- `private` automatically reconciles one Binding Liveware Publication for every current and newly activated Agent Binding unless that publication has durably entered `retiring`. `off`, Binding removal, Plugin disable or removal, and Owner Reset enter `retiring`; normal `private` reconciliation cannot reverse that intent. The Liveware Exposure holds its gateway endpoint while at least one publication exists or is being reconciled and releases it after the final publication reaches `retired`.
- Each Binding Liveware Publication has its own private managed Liveware App, URL, tunnel, and ClawChat Liveware Registration. No App, URL, tunnel, registration, or management credential is shared across Agent Bindings.
- Adding an Agent Binding creates only that Binding's publication over the existing Shared Client Gateway. Removing a Binding retires only its publication; removing the final Binding releases the Liveware Exposure's gateway endpoint without affecting another Client Exposure.
- A Binding Liveware Publication launcher initializes Connect Client selection to its Agent Binding. That hint does not scope authorization, hide other Bindings, or determine Session identity; the Installation Owner may switch to any available Binding inside the installation-wide Client.
- A Binding Liveware Publication failure affects only that publication. Its Agent Binding, Runtime, ordinary ClawChat message transport, local Client access, Shared Client Gateway, and every other Binding's publication remain available.
- Before a remote create, reconciliation persists the desired transition, a stable publication correlation key, and its Activation Generation. After success it persists the exact remote identity and completed lifecycle transition before advancing through private App provisioning, tunnel binding, and ClawChat registration.
- A restart resumes the persisted transition. Reconciliation may repeat only a transition authoritatively confirmed missing; an unavailable, timed-out, malformed, or otherwise indeterminate result first performs authoritative lookup by the stable correlation key, adopts exactly one matching owned resource, reports multiple matches as degraded cleanup work, and performs no new create or destructive follow-up while the effect is unresolved.
- Agent Binding removal succeeds only after its Binding Liveware Publication is authoritatively retired. A failed retirement reports failure, leaves the publication `retiring`, preserves the Binding, credential, exact cleanup progress, Runtime, and ordinary message availability, schedules no background deletion or reprovisioning, and resumes only on another explicit removal request.
- Binding Liveware Publication retirement removes that Binding's ClawChat Liveware Registration and then deletes its managed Liveware App. Authoritatively successful App deletion retires the App's tunnel; a separate tunnel-unbind operation is not part of the publication contract.
- Core owns and enforces Shared Client Gateway Host, Origin, and spoofed-scope-header rules. Every public Exposure receives only the generation-fenced Core-mediated Client fetch facade. The integrity-pinned official Liveware implementation additionally receives internal publication services and an opaque loopback Gateway upstream; it cannot configure gateway security or use the launcher hint as an authorization boundary.
- The official Liveware Plugin owns App provisioning, tunnel binding, ClawChat Liveware Registration, companion-process coordination, and acquisition and release of its gateway endpoint. A launcher-visible publication requires both the Binding's Liveware Control Plane App and its ClawChat registration.
- Each Agent Binding's activated ClawChat Agent token administers only that Binding's Liveware App, tunnel, and ClawChat registration. Owner Reset retires every Binding Liveware Publication with its own credential before removing any credential; ClawChat and Liveware own the separate user-token and WebView-ticket flow used when the Installation Owner opens an App.
- A Binding Liveware Publication is entered only through authenticated ClawChat Liveware. An ordinary browser request to its App URL is not a supported Client entrypoint and an HTTP 401 does not test whether its tunnel reaches the Shared Client Gateway.
- Agent-Managed Liveware Apps never reuse, modify, or retire the Connect-managed Liveware Exposure.
- Every successfully bound Agent-Managed Liveware App is registered into ClawChat; Connect Agent Skills do not expose a tunnel-only workflow.
- A local Agent operates the Liveware executable supplied by the official Liveware Plugin only through Connect's credential-safe command boundary; Connect does not reveal or persist an activated ClawChat access token for Agent use.
- The Agent-facing Liveware command boundary accepts only explicit app inspection, creation, access-policy, deletion, and loopback tunnel operations. It rejects authentication, agent-process, unknown, shell-composed, reserved-name, and Connect-managed App mutations.
- Every ClawChat-originated runtime turn carries a ClawChat Turn Context derived from its normalized ClawChat envelope. A Client-originated turn never claims a current ClawChat message context.
- A ClawChat Tool Command that targets a conversation, message, sender, or mention uses an explicit identifier from ClawChat Turn Context or another authoritative result; it never infers an identifier from a display name or user-authored text.
- The CLI is only the local entrypoint for an Agent-callable ClawChat or Liveware operation. Every actual invocation persists a Tool Request in Connect's owner-only local state; Connect Service claims and executes it with the selected Agent Binding's active authenticated transports or the official Liveware capability and persists the result for the waiting CLI.
- A settled Tool Request is retained as one Tool Call Record rather than deleted after the CLI receives its result.
- Tool Call Records retain secret-scrubbed normalized arguments and bounded JSON outcomes with explicit truncation metadata, together with request, Binding, optional Session and Turn, state, attempt, and timing provenance. They never retain activation credentials, authorization headers, Liveware tokens, uploaded file contents, or internal authentication responses.
- Settled Tool Call Records are retained for at most 90 days and at most 10,000 records per Agent Binding; cleanup removes the oldest settled records when either limit is exceeded. Pending, running, and indeterminate records are never removed automatically.
- Tool Call Records have no Agent-facing or user-facing history, show, or prune interface and are never exposed through Client Interface. Connect uses them only for request settlement, internal audit, diagnostics, and automatic retention cleanup.
- A Tool Request is attempted at most once after claim. Any transport error, operation error, timeout, process interruption, or indeterminate outcome becomes terminal and is never retried automatically, regardless of whether the operation is read-only or mutating.
- Reusing a request ID returns its existing Tool Call Record and never starts another attempt. A deliberate retry is a new explicit Tool Request with a new request ID.
- Ordinary ClawChat Tool Requests expire after 30 seconds; file-transfer and Agent-managed Liveware requests expire after 120 seconds. An unclaimed expired request never executes. A claimed timeout settles as failed only when no external effect occurred, otherwise as indeterminate.
- Tool Requests are not part of Client Interface, trusted-LAN access, or any Client Exposure. The CLI never falls back to direct ClawChat access or opens a second ClawChat WebSocket.
- Connect does not register ClawChat runtime tools or inject a bundled MCP server into Runtime Threads. A local Agent instead invokes explicit ClawChat Tool Commands under guidance from an installed skill.
- Connect distributes separate `clawchat-core` and `clawchat-liveware` Connect Agent Skills and installs them by default in the current user's Agent skill directory so they apply across repositories.
- Both Connect Agent Skills allow implicit invocation. `clawchat-core` matches explicit ClawChat social, profile, message, moment, and attachment intents; `clawchat-liveware` matches explicit Liveware or ClawChat App publication intents and never substitutes itself for an unrelated generic Web deployment workflow.
- Connect installation and update atomically replace the installed `clawchat-core` and `clawchat-liveware` directories with the release copies. Installed Connect Agent Skills are managed artifacts rather than user customization surfaces, so local edits are not preserved.
- Connect Agent Skills are required release artifacts. Installation and update validate and preflight all managed targets before replacement; a missing, invalid, or unwritable skill fails the whole operation rather than reporting a partial success with mismatched CLI and skill contracts.
- Every user-facing Connect installation and update channel carries, installs, and validates the same Connect Agent Skills. A package-manager path that skips its installation lifecycle is incomplete and must fail a runtime preflight until the bundled local repair command installs them.
- Installed Connect Agent Skills must match the running Connect release manifest and checksums exactly. Doctor, Connect Service, and Agent Binding startup reject a mismatch; the offline `clawchat-connect skills install` command repairs it by atomically replacing both skills from the installed release.
- ClawChat Tool Commands are addressed only by canonical tool name; Connect does not define grouped CLI command families for them.
- The Agent-facing command is `clawchat-connect tool call <tool-name> --input-json <json-or-stdin>`, with optional explicit request and Agent Binding identifiers. Binding selection resolves explicit CLI input, then the Binding Runtime Instance context, then the configured default.
- Every accepted Tool Command prints one JSON Tool Call Record envelope to stdout. Failed, expired, and indeterminate outcomes also use a non-zero exit status; pre-submission CLI errors use stderr.
- ClawChat Tool Commands do not add a generic confirmation parameter beyond their canonical schemas. Connect Agent Skills require explicit user intent and authoritative target identifiers for mutating operations, while Connect Service enforces structural, Binding, and reserved-resource constraints.
- ClawChat Tool Commands do not add Turn-correlation CLI parameters. After a successful mention or message reaction in a group Turn, the Connect Agent Skill may instruct the Agent to emit a No-Reply Signal so that Turn does not publish a duplicate ordinary response; direct-message Turns keep their existing delivery behavior.
- Tool Catalog is the sole definition of the first release's 24 ClawChat Tool Commands. CLI validation and routing, static discovery, and generated skill references consume it directly; CI rejects a generated-reference diff.
- ClawChat Profile updates are explicit authenticated CLI operations.
