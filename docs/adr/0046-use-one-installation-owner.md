---
status: accepted
---

# Use one Installation Owner and an explicit Owner Reset

This supersedes ADR-0034's multi-owner installation model and ADR-0018's remaining public-access and Core-owned publication details. One ClawChat user owns every Agent Binding in a Connect installation because installed Plugins, Plugin administration, aggregated Workspace Catalog views, and the remote Client surface are installation-wide trusted capabilities rather than tenant-isolated resources; a second user requires a separate Connect installation. The first successful Binding activation establishes the Installation Owner, and changing it requires a local Core-owned Owner Reset that retires external resources before purging owner-scoped durable state while preserving installed Plugins, Workspace files, and runtime-native state.

Owner Reset keeps the Installation Owner, credentials, and local owner-scoped state when any required external retirement fails; local purge begins only after all external resources are retired. This preserves enough authority to retry cleanup instead of orphaning remotely reachable resources.

The optional official Liveware Plugin contributes one installation-scoped Client Exposure with a private managed App, tunnel, and Shared Client Gateway. Every activated Binding has its own launcher registration for that App; adding or removing a non-final Binding changes only its registration, while removing the final Binding retires the shared exposure resources. Local Client access and ordinary ClawChat message transport never depend on that Plugin.

ADR-0049 superseded the singleton Liveware App and tunnel topology in the preceding paragraph; ADR-0065 later supersedes its remaining mandatory Connect Client and Shared Client Gateway clauses. This ADR remains authoritative for one Installation Owner, private owner access, explicit Owner Reset, and cleanup before credential removal.
