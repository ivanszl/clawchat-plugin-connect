---
status: superseded by ADR-0065
---

# Limit public Plugins to Runtime, Client Exposure, and Client Extension capabilities

Cordis is Connect's single internal composition and lifecycle mechanism, but it is not the public SDK. Mandatory Core modules remain non-removable, while trusted in-process Plugin Bundles receive a versioned Connect Plugin Context, may depend only on declared Host Capabilities, and may contribute only Runtime Adapter, Client Exposure, and slot-only Client Extension capabilities. Persistence, Workspace Catalog, Session and Turn semantics, ClawChat transport and commands, Agent tools, media and artifact storage, credential sources, output rendering, Client Interface, Client Kernel, and policy remain Core-owned because exposing them would fragment domain authority or grant an unbounded mutable-state surface without a proven provider use case. The initial SDK also has no secret-valued configuration field, Secret Store, or raw-credential capability: Runtime Plugins use native Runtime authentication, and Client Exposures use narrow Core credential-using operations or an already authenticated local tool. Direct vendor-API Plugins that must own tokens remain unsupported until a concrete use case justifies a separate secret design.

ADR-0051 confirms that Client Exposure remains public under this trusted in-process Plugin model and removes Catalog provenance as a capability-admission check.
