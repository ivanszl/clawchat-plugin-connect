---
status: accepted
---

# Own stateful runtime instances per Agent Binding

Runtime Adapter definitions are shared by kind, but every Agent Binding owns an independent stateful adapter instance and runtime process. Binding-specific environment, cached runtime clients, and shutdown lifecycle therefore cannot leak across Bindings of the same kind, and Connect can inject a fixed Binding identity into each runtime process.

ADR-0034 removes the former one-Binding-per-kind product constraint. Same-kind Agent Bindings continue to own independent Runtime instances.
