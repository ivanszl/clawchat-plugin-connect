---
status: accepted
---

# Unify Runtime Activity across live and history

Every Runtime Adapter will translate native live notifications, Runtime Transcript history, and Adapter-owned fallback records into one runtime-neutral Runtime Activity model before they cross the Runtime Adapter seam. A Runtime Activity is a complete current-state upsert with a stable identity, stable Runtime Thread-local position, explicit parent-child hierarchy, shared Connect kind, and sanitized `unknown` fallback; the Adapter owns native delta reconstruction and identity correlation across sources.

The Connect Transcript Projection maps Runtime Activities into Connect-owned blocks, sequence, origin, provenance, and persistence without interpreting native event types, guessing identity from display content, or branching on Runtime Adapter kind. Adapters report completeness, ordering, or correlation limitations rather than hiding them. This concentrates more implementation in each Adapter and may repeat complete Activity state during streaming, but it keeps native protocols and fallback formats behind the seam and gives live rendering, reconnect recovery, and future coding agents one stable interface.

This decision refines ADR-0011, ADR-0012, and ADR-0019 without changing the Runtime Transcript's authority for Agent context or the Connect Transcript Projection's authority for Connect-owned metadata.

## Implementation status

Implemented. Runtime Sessions emit Runtime Activity directly, history and rollout fallback are translated by the
Runtime Adapter, and Connect Transcript Projection accepts only Runtime Activity. Correlation uses Adapter-provided
identity or aliases; display-text matching and the legacy live-output projection path have been removed. Codex maps
native turn/item ordinals consistently across live and history, while Transcript Projection maps those positions into
reserved sequence ranges so reconnect, replay, and out-of-order arrival converge. The runtime-neutral position syntax
is `<turn ordinal>.<item ordinal>` with zero-based decimal ordinals; item `0` is reserved for a turn-level marker and
native turn items begin at `1`.
