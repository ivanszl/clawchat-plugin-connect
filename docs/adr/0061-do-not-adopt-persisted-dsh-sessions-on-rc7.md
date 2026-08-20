---
status: superseded by ADR-0063
---

# Do not adopt persisted DSH Sessions on rc.7

Connect discovers and displays every materialized top-level Session in the selected DSH Home, including Sessions created by DSH Web, TUI, Connect, or another native client, but it does not offer a persisted Session from the current npm `latest` installation for adoption or restart-resume. That installation reports root `0.1.0-rc.7` while resolving critical service packages to rc.8. Such an entry remains visible with the runtime-neutral reason `external-ownership-unverifiable`; archived entries remain separately visible and cannot accept turns.

The reviewed persistence contract requires one live writer per Session but supplies no cross-process lease, owner identity, or busy query. Its coordinator rejects duplicate ownership only inside one backend instance. A private Connect lock would not be observed by DSH Web/TUI, process scanning would be heuristic, and attempting resume as a probe already creates the prohibited competing owner. None is a safe native mechanism, so the Adapter reports the capability as unsupported instead of presenting a temporary workaround.

The [real-process concurrency probe](../../.scratch/deepseek-harness-integration/prototype/result-concurrency.md) proved that two processes from that current install can resume the same persisted Session concurrently. New Sessions can execute safely only while they remain owned by the current Binding process; that does not satisfy Connect's required restart recovery. Consequently the DSH Runtime capability stays unreleased until a supported DSH version supplies an enforceable ownership/attach seam, or an official single host process can serve Web/TUI/Connect without competing Session owners.
