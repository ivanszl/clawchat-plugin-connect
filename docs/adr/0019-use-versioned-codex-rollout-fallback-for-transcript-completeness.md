---
status: accepted
---

# Use a versioned Codex rollout fallback for transcript completeness

The Codex Runtime Adapter will continue to use `codex app-server` as its primary operational and transcript interface. When persisted app-server history omits displayable raw tool calls that the Codex TUI recorded, the Adapter may read the matching Codex rollout JSONL and merge only those missing calls into its runtime-neutral transcript snapshot.

This fallback remains private to the Codex Adapter. Connect Runtime, Transcript Projection, Client Interface, and Connect Client consume only `RuntimeTranscriptEntry` values and a `complete`, `partial`, or `live-only` completeness result. Entries identify whether they came from ordinary runtime history or a fallback, but no Codex rollout record shape crosses the Runtime Adapter seam.

The fallback is versioned with the single pinned Codex release. It recognizes an explicit allowlist of persisted tool-call and tool-output record types, pairs them by native call ID, orders them relative to app-server message IDs, and removes fields that are not part of the displayable call. It does not expose raw reasoning records or internal message metadata. Calls already represented by app-server history are not inserted again.

A missing rollout, malformed record, completed call without a persisted output, or unrecognized required shape makes the snapshot `partial`; it never prevents available app-server history from rendering. When a future pinned app-server exposes the same calls through its supported history API, Connect should prefer that API and remove the redundant fallback mapping.

This decision refines ADR-0012 rather than replacing its Runtime Adapter seam: app-server remains the Codex process, lifecycle, discovery, live-event, and primary history interface. Direct rollout access is a read-only, version-specific reconciliation implementation behind that seam.
