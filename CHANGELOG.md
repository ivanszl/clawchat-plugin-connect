# Changelog

All notable changes to ClawChat Connect are documented in this file.

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

