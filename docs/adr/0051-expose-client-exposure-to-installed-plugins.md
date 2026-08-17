---
status: accepted
---

# Expose Client Exposure to installed Plugins

Client Exposure is a public Connect Plugin capability. Plugin installation already authorizes trusted in-process code execution, so official-Catalog provenance is not a meaningful security boundary and MUST NOT decide which Bundles may declare an Exposure. Local, npm, GitHub, and official Bundles pass the same manifest, target, integrity, schema, lifecycle, and Activation Generation checks. The Host exposes only the generation-fenced Client Exposure provider contract and Core-mediated Client fetch facade; it does not expose raw credentials, mutable Core state, gateway configuration, forwarded-principal authority, or Plugin administration APIs. Host, Origin, and spoofed scope-header enforcement remain Core-owned. The official Liveware Plugin additionally uses internal publication operations for its managed private Apps, but those operations do not restrict installation or activation of other Client Exposure Plugins.
