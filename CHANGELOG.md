# Changelog

All notable changes to ClawChat Connect are documented in this file.

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
