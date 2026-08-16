---
status: accepted
---

# Compose Client Extensions through typed slots

The non-replaceable Client Kernel owns browser routing, authentication/bootstrap, the browser Cordis root, typed Client services, slot rendering, and a built-in fallback presentation. Installed Client Extensions share the Host's React and Astryx singletons and may add to or explicitly replace declared presentation slots with lifecycle-bound contributions, but they cannot register browser or server routes, depend on TanStack Router/Query internals, patch the DOM, or replace the Kernel. This follows DeepSeek Harness's slot-composition model while preserving Connect's existing Core-owned route tree; a real independent-page use case is required before adding a Host-owned extension route.
