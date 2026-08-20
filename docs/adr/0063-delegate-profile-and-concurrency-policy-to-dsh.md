---
status: accepted
---

# Delegate Profile and concurrency policy to DeepSeek Harness

The official DeepSeek Harness Runtime Plugin preserves the user's selected Home and native composition while delegating Profile defaulting, Home sharing, Session concurrency, optional-service availability, sandboxing, approval, and occupied question-provider behavior to DSH. Connect may pass an explicit existing Profile, but otherwise omits the argument; it performs no DSH version or internal component-graph check, creates no Home or Session claim/lease/owner probe, allows usable persisted Sessions to resume through native DSH APIs, and lets each absent optional service disable only its own operation. This accepts DSH's native cross-process behavior in exchange for integrating the full user-owned plugin ecosystem without Connect imposing a narrower private policy.

This supersedes ADR-0055's required explicit Profile selection, ADR-0056's Connect-local Home claim, ADR-0059's activation-wide Workspace Registry requirement, ADR-0061's persisted-Session adoption gate, and ADR-0062's requirement that Connect own the sole question-provider slot. The paired inherited-pipe Bridge remains process-scoped: it lets existing native approval handlers decide first, registers Connect question routing only when the provider slot is free, and never mutates the Profile to manufacture capabilities.
