---
status: accepted
---

# Replace Client Extension graphs by epoch

The Client Kernel loads the exact browser Plugin graph selected by Core under one graph hash and epoch. Any graph change fully disposes the old graph before loading the new one; if clean replacement cannot be proven, the Kernel forces a full-page reload, and Core rejects typed Client-service mutations carrying a stale epoch. Client Extensions remain trusted same-origin code: typed slots, no direct DOM patching, and no Router or Query access are maintainability contracts, not a browser security sandbox. Epoch replacement is preferred over side-by-side browser versions because an open tab otherwise keeps timers, subscriptions, styles, and service calls from a server-incompatible Bundle generation.
