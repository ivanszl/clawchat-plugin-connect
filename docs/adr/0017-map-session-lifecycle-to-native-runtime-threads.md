---
status: accepted
---

# Map Session lifecycle to native Runtime Threads

Connect Client exposes archive, restore, and permanent-delete commands by Session Ref. Connect Service resolves that Ref to the Runtime Thread owned by the selected Agent Binding and delegates the operation through its Runtime Adapter. The first Codex implementation maps those intents to app-server `thread/archive`, `thread/unarchive`, and `thread/delete`; runtime-native IDs and protocol methods remain behind the adapter boundary.

Archived Sessions remain discoverable in a separate collapsed Session Catalog group. Their Client Transcript stays readable, but their available actions exclude sending and cancellation until restoration. Archiving the current Session leaves a Session Intent with the same Project, name, and mode so a later ClawChat message starts from an explicit new-session boundary instead of silently resuming an archived Runtime Thread.

Permanent deletion is ordered native-first. Only after the Runtime Adapter confirms deletion does Connect remove the Session Ref, managed Session record, and SQLite Transcript Projection. A failed native deletion therefore preserves the local mapping and transcript for retry and diagnosis. Connect does not separately enumerate or cascade deletion to Subagent Threads; any native lifecycle behavior remains the runtime's responsibility.
