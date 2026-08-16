---
status: accepted
---

# Own stateful runtime instances per Agent Binding

Runtime Adapter providers are shared by exact Plugin capability, but every Agent Binding owns an independent stateful adapter instance and runtime process. Binding-specific Runtime configuration, cached runtime clients, and shutdown lifecycle therefore cannot leak across Bindings that select the same capability. Provider-specific configuration remains inside the Binding's `runtimeConfig`; host-owned Binding identity does not travel through runtime environment configuration.

Agent Bindings that select the same exact Runtime Plugin capability continue to own independent Runtime instances.
