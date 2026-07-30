---
status: accepted
---

# Own stateful runtime instances per Agent Binding

Runtime Adapter definitions are shared by kind, but every Agent Binding owns an independent stateful adapter instance and runtime process. Binding-specific environment, cached runtime clients, and shutdown lifecycle therefore cannot leak across Bindings of the same kind, and Connect can inject a fixed Binding identity into each runtime process.

The current release still rejects more than one Agent Binding for a Runtime Adapter kind. That restriction remains a temporary product constraint rather than a reason to retain the previous kind-keyed singleton process; a later release may remove the validation after its multi-Binding behavior and migration are specified.
