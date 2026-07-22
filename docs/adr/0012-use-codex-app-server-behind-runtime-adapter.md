---
status: accepted
---

# Use Codex app-server behind the Runtime Adapter seam

The Codex Runtime Adapter will use `codex app-server` over a Connect-owned stdio transport because app-server exposes native thread discovery, persisted transcript reads, rich streaming events, approvals, interruption, and steering that the Codex SDK does not. This is an implementation decision for the Codex Adapter rather than a system-wide runtime protocol: Connect orchestration, SQLite projection, the Client Interface, ClawChat delivery, and Connect Client depend only on Connect-owned runtime interfaces and event types.

Codex app-server process management, JSON-RPC methods, generated schemas, the selected protocol version, native identifiers, and native payload types remain private to the Codex Adapter implementation. The Adapter translates native capabilities and events into versioned Connect concepts; an optional opaque native envelope may be retained for reconciliation and diagnostics, but no caller may require or interpret it for normal behavior. Other Runtime Adapters may use ACP or another transport without changing callers at the Runtime Adapter seam.

Connect Service manages at most one long-lived app-server child process for the Codex Agent Binding and shares it across every Session and Runtime Thread. Starting a Connect Runtime Session creates a lightweight thread handle rather than another process; whether the shared process starts eagerly or on first use remains private to the Adapter. Connect Service closes it during shutdown through the Runtime Adapter lifecycle interface.

If app-server exits unexpectedly, active turns fail with an explicit interrupted result and are never replayed automatically, because retrying an accepted prompt could duplicate work. The Adapter may restart and reinitialize app-server for later operations, then resume native Runtime Threads by their durable runtime-owned IDs. Process-wide request routing, notification demultiplexing, backpressure, and restart state remain internal to the Codex Adapter.

Connect may execute turns for different Sessions concurrently up to `maxConcurrentTurns`, while turns for one Session are strictly ordered and never overlap. Because one Runtime Thread belongs to at most one Session within an Agent Binding, the scheduler uses the Connect-owned Session ID rather than a native thread ID or ClawChat conversation ID. Client-originated and ClawChat-originated turns therefore share the same per-Session queue. Storage must enforce the one-to-one mapping across the Agent Binding, not merely within one ClawChat conversation.

Connect supports exactly one pinned Codex/app-server version and its generated protocol schema at a time. The Codex Adapter performs no protocol negotiation, compatibility-range handling, legacy method branches, or fallback to the SDK; a different installed Codex version fails activation with an exact-version diagnostic. A Codex upgrade is a coordinated change to the pinned executable version, generated types, protocol fixtures, Adapter implementation, and installed-Codex integration suite rather than an expansion of the supported version matrix.

Tests above the seam use a fake Runtime Adapter rather than a fake app-server. The Codex Adapter itself is tested only against fixtures for the selected protocol and the matching installed Codex version. The existing Runtime Adapter interface must gain an Adapter-level lifecycle close operation before the shared process replaces the current per-Session SDK client.
