# Changelog

All notable changes to ClawChat Connect are documented in this file.

## [0.1.0-alpha.18] - 2026-07-30

### Changed

- Centralized ClawChat Tool Command execution policy and handlers in the generated Tool Catalog.
- Isolated stateful Runtime Adapter instances, cached clients, and shutdown lifecycle per Agent Binding.

### Fixed

- Fixed Linux x64 releases crashing with `Illegal instruction` on CPUs without AVX2 by publishing the baseline Bun target.
- Made POSIX and Windows upgrades preflight managed Skill targets before replacing an existing installation, with transactional rollback on later failure.
- Fixed duplicate Web messages by correlating Codex history through native turn structure instead of display text.
- Fixed group message reactions, deterministic Liveware error classification, managed Liveware App protection, Tool Call Record redaction and size bounds, and terminal CLI envelopes.
- Added independent managed Skill verification at Agent Binding startup and completed CLI, retention, WebSocket mention/reaction, Liveware registration, and Windows installer behavior coverage.

## [0.1.0-alpha.17] - 2026-07-30

### Added

- Added database-backed ClawChat tool calls through the canonical `clawchat-connect tool call <tool-name>` CLI entry point, with durable request records, idempotent request IDs, binding-aware routing, and no automatic retries.
- Added automatically installed `clawchat-core` and `clawchat-liveware` Agent Skills, generated tool references, and integrity-checked force replacement during installation and updates.
- Added Agent-managed Liveware deployment commands with loopback-only upstreams, allowlisted operations, automatic ClawChat app registration, and protection for the Connect-managed app.
- Added authoritative ClawChat turn context and per-binding Runtime process identities in preparation for multiple Agent Bindings per Runtime Adapter.

### Changed

- Routed Agent tool execution through the Connect Service and persistent SQLite request lifecycle while retaining settled request history.
- Added WebSocket reaction delivery alongside the existing message reply path.

### Fixed

- Fixed upgrades from pre-Project databases by adding the missing Runtime Session `project_id` migration without replacing existing local Session state.

## [0.1.0-alpha.16] - 2026-07-29

### Added

- Added `clawchat-connect update` with optional release pinning and automatic native service refresh.

### Changed

- Synchronized Connect Projects with persistent Codex Runtime Workspaces and improved Session navigation continuity.
- Resolved ClawChat sender profile names through the authenticated user API.

### Fixed

- Fixed short Web messages appearing twice after Runtime history reconciliation.
- Fixed Web-uploaded images returning authorization errors or disappearing after a Turn completed.
- Fixed Transcript follow mode stopping after streamed content, tools, or images changed the rendered height.
- Fixed stalled ClawChat reconnects, transcript sequence collisions, and full-page Session navigation reloads.

## [0.1.0-alpha.15] - 2026-07-29

### Added

- Added revision-aware Client View Continuity with atomic snapshot recovery across the active Session Catalog, Session, and Transcript views.
- Added atomic Turn Submission with capability negotiation, Connect-owned attachment staging, stable submission identities, and durable cancellation outcomes.

### Changed

- Unified Client event application across SSE and persisted batch fallback while removing foreground Session and Composer polling writers.
- Exposed the active accepted Turn and effective Turn Submission Capability through the Client Interface.
- Unified ClawChat, Connect Client, and CLI Project choices around root-derived names and Workspace IDs, with active persistent Runtime Workspaces synchronized one-way into Connect Projects.

### Fixed

- Fixed Codex agent-message streaming states being delivered as multiple cumulative ClawChat messages; ClawChat now receives only the latest completed state.
- Fixed cancellation and queue-acceptance races, stale Transcript revisions, recovery gaps, and duplicate Turn Submission retries.

## [0.1.0-alpha.14] - 2026-07-28

### Added

- Added an automation-ready Agent installation runbook covering Connect setup, activation, native service installation, managed Liveware startup, readiness checks, and recovery.

### Changed

- Removed the exact Codex CLI version gate. Connect now accepts any installed Codex version that can initialize the required app-server interface.
- Clarified that the release workflow's Codex version is a reproducible CI test fixture rather than a runtime requirement.

## [0.1.0-alpha.13] - 2026-07-28

### Added

- Added a complete Chinese README and official ClawChat branding to the repository landing page.

### Changed

- Made the macOS, Linux, and Windows installers resolve the latest published GitHub Release at runtime, including prereleases, while preserving explicit version pinning.
- Published version-agnostic installers without rewriting embedded versions during the release workflow.
- Moved repository, installer, badge, homepage, and issue links to `clawling/clawchat-plugin-connect`.

### Fixed

- Fixed the Codex app-server client metadata reporting the obsolete `0.1.0-alpha.6` version.

## [0.1.0-alpha.12] - 2026-07-28

### Added

- Added a released Runtime Adapter catalog and shared conformance suite that gates every released adapter.
- Added stable runtime-neutral Activity positions, aliases, replay ordering, and lifecycle error contracts.

### Changed

- Unified live, historical, and fallback output behind the Runtime Activity seam.
- Shared one long-lived Codex app-server process across catalog and Session work for each Agent Binding.
- Separated Session lifecycle claims, turn scheduling, execution, and Client/ClawChat Turn Surfaces.

### Fixed

- Fixed archive and delete races with active turns, including discovered but unadopted Runtime Threads.
- Fixed aborted Runtime Interactions remaining actionable and duplicate or out-of-order Transcript projection.
- Fixed unsupported, missing, and concurrent lifecycle operations leaking as internal Client errors.

## [0.1.0-alpha.11] - 2026-07-28

### Added

- Added stable ClawChat sender identities and display names to the Client Transcript for group and direct-message attribution.
- Added Codex agent-message delta handling for cumulative streaming output in Connect Client.

### Changed

- Automatically reconciled the active Session with external Runtime Thread updates while keeping revision polling scoped to the foreground view.
- Preserved the reader's scroll position during streaming output and resumed following only after jumping to the latest message.
- Made the global refresh action force Runtime Catalog discovery and immediate active Session synchronization.

### Fixed

- Fixed completed turns remaining stuck in the Liveware working state.
- Fixed Web and ClawChat Turn Origin metadata being overwritten by subsequent Runtime history reconciliation.

## [0.1.0-alpha.10] - 2026-07-27

### Added

- Added pinned-version Codex rollout reconciliation so Connect Client history includes displayable tool calls omitted by app-server.
- Added transcript completeness and event provenance across Runtime Adapter history and fallback reconciliation.

### Fixed

- Fixed Enter confirming Chinese and other IME composition from submitting the composer prematurely.

## [0.1.0-alpha.9] - 2026-07-25

### Added

- Added Web media uploads with attachment selection, removal, validation, ClawChat storage, and Codex Runtime delivery.

### Changed

- Grouped consecutive Runtime tools, commands, and file changes with the official Astryx `ChatToolCalls` presentation.
- Added the matching Changelog section to GitHub Release notes and included `CHANGELOG.md` with release artifacts.

## [0.1.0-alpha.8] - 2026-07-25

### Added

- Added complete Web approval and user-input interactions for Codex Runtime turns.
- Added structured ClawChat image delivery, local media caching, and Web transcript previews.

### Changed

- Improved Runtime event coordination and serialized Codex app-server requests.
- Separated catalog and Runtime app-server processes to prevent discovery work from blocking active turns.

### Fixed

- Fixed Liveware mutation requests being rejected when they use the registered public exposure Origin.
- Fixed ClawChat messages being marked handled before Codex accepted the corresponding Runtime turn.
- Fixed Codex thread resume failures caused by competing app-server requests and repeated Project path probes.

## [0.1.0-alpha.7] - 2026-07-25

### Added

- Added a ClawChat handoff action to continue the current Connect Session in ClawChat.
- Added richer, collapsible transcript rendering for tool calls and file changes.

### Changed

- Refined the Connect Client navigation, Session header, composer controls, responsive layout, and transcript scrolling.
- Improved Project-free Session naming and status presentation while keeping internal Session references out of the primary interface.

### Fixed

- Fixed ClawChat `/switch` handoff for Sessions whose Codex Runtime Thread has not yet been discovered.
- Fixed ordinary ClawChat messages being delayed in the Connect transcript until a manual refresh.
- Fixed queued ClawChat messages not being projected before Runtime execution starts.
- Added periodic transcript synchronization for Liveware WebViews where streaming events are unavailable.
- Fixed long Session names causing horizontal page overflow on narrow screens.

## [0.1.0-alpha.6] - 2026-07-23

- Added bundled Liveware installation and release assets for macOS, Linux, and Windows.
- Added Windows installation, background-service support, and GitHub Actions release builds.
- Refined Connect Client Session, Project, Runtime preference, and responsive navigation behavior.
- Improved ClawChat registration, activation replacement, transcript projection, and media reply handling.
