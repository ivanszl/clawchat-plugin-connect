---
status: accepted
---

# Journal native Session lifecycle operations

Native Runtime Thread lifecycle operations and Connect's SQLite updates cannot share one atomic transaction. Connect will therefore durably journal archive, restore, and permanent-delete operations before calling the Runtime Adapter, record when the native target state is confirmed, and only then commit the corresponding local Session, Session Intent, Session Ref, and Connect Transcript Projection changes. On restart, Session Continuity reconciles incomplete journal entries instead of leaving native and local state permanently divergent.

Runtime Adapters provide idempotent lifecycle semantics at the Connect seam: when reconciliation can confirm that the requested native state has already been reached, it succeeds rather than turning an interrupted operation into an unrecoverable error. The journal is an additive persistence detail that refines ADR-0017's native-first ordering without changing existing Session lifecycle behavior or the meaning of existing records.
