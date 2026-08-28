---
status: accepted
---

# Publish independent managed Web apps through Liveware

Connect will no longer own one mandatory installation-wide Connect Client or route every Binding Liveware Publication through a Shared Client Gateway. Any installed trusted Plugin may contribute a complete Managed Web App: the Provider owns its Web server, browser protocol, authentication, Sessions, Interactions, presentation, and reconnect behavior, while Connect only supervises the Provider lifecycle, leases its opaque loopback upstream, and gives that upstream to the official Liveware Exposure for publication.

An exact Runtime capability uses its Plugin-provided native Managed Web App when one exists. Without one, it may use an installed Connect Client only when that Client explicitly supports the exact capability; otherwise the Binding has no Web App or Liveware Publication. A selected App never changes because it is temporarily unavailable, and independently owned Apps make no promise to continue a ClawChat or Connect Session.

The official mappings are:

- DeepSeek Harness uses the official `dsh web` product, independently from its Connect Binding Runtime process and Sessions.
- OpenCode uses the official `opencode web` product, independently from the Connect Adapter's execution server and Sessions.
- Codex and the two WorkBuddy capabilities may use the optional official Connect Client App when that Plugin is installed and declares support for them.

Managed Web App Instances are keyed by their Provider-owned native scope and may be leased by several Bindings. Each Binding still owns an independent private Liveware App, tunnel, and ClawChat Liveware Registration; releasing the final lease stops the Instance. App failure does not stop the Binding Runtime, change the selected App, or cause Connect to insert a compatibility proxy or fallback page; Liveware owns unavailable-upstream presentation.

The complete Connect Client becomes an optional removable Plugin-owned Managed Web App with its own full Web server and Client Extension graph. Core retains CLI administration and recovery, Plugin and Activation Generation authority, opaque loopback-upstream validation, managed-resource retirement, and Binding Liveware Publication lifecycle, but it owns no mandatory browser application or Web product semantics.

## Considered Options

- One unified Connect Client was rejected because Connect would have to reproduce and continuously track DSH Web, OpenCode Web, and future Runtime-native product capabilities.
- Embedding or proxying native Web products was rejected because it preserves their Session, authentication, and Interaction state machines while making the result appear falsely unified.
- Reusing a Binding Runtime backend for its native Web was rejected because fewer processes would couple otherwise independent Web and ClawChat behavior.
- User-supplied unmanaged endpoints were rejected because Connect could not align startup, shutdown, dynamic ports, Publication retirement, or Service recovery.

## Supersession

This ADR supersedes ADR-0003's Core-served mandatory SPA, ADR-0045's non-replaceable Core Client Kernel, ADR-0048's closed public capability set, ADR-0049's Shared Client Gateway upstream topology, and ADR-0053's Core-owned installation-wide Client Extension graph. It supersedes only the Connect Client and Shared Client Gateway clauses of ADR-0046; ADR-0046 remains authoritative for one Installation Owner, private owner access, Owner Reset, and cleanup before credential removal. ADR-0002 continues to govern the optional Connect Client itself: that App speaks only its Connect-owned Client Interface and never a native Runtime protocol.