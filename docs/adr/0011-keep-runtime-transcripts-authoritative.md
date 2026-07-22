# Keep Runtime Transcripts authoritative

The external Runtime Thread and its native Runtime Transcript remain authoritative for Agent context and resume. Connect will not replace them with a Connect-owned thread or attempt to recreate native context by replaying messages.

Connect Service will persist a Connect Transcript Projection in SQLite for Client rendering, search, reconnect recovery, provenance, and visibility. It records every displayable normalized event received live from a Runtime Adapter—including messages, emitted reasoning summaries, commands, tool activity, file changes, plans, progress, errors, and usage—and reconciles historical events exposed by the Adapter. Runtime history remains authoritative for Agent-emitted content, while the projection remains authoritative for Connect-owned Session mapping, message origin, and ClawChat visibility.

ClawChat `outputVisibility` affects only remote delivery and never removes events from the projection. Connect Client may collapse detail but does not discard it. Secrets, hidden reasoning, and raw runtime storage remain outside the Client Interface. When an Adapter cannot backfill all displayable history, Connect preserves observed events and exposes transcript completeness rather than claiming an exact reconstruction.

A runtime-owned child thread is part of its parent thread's Session tree rather than a standalone Connect Session. When the Runtime Adapter exposes an explicit parent activity and readable child transcript, Connect projects one runtime-neutral subagent block at that activity, recursively nests the child transcript inside it, and leaves the block collapsed by default. Native parent and child thread identifiers remain behind the Runtime Adapter seam.
