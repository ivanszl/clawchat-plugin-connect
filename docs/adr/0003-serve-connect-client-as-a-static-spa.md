---
status: superseded by ADR-0065
---

# Serve Connect Client as a static SPA

Connect Service will serve the production React SPA and its local Client Interface from the existing service process, with no TanStack Start server runtime. The Client may use Astryx and client-side TanStack libraries such as Router and Query; development may use a Vite server that proxies the Client Interface, while production retains one service and one runtime-owning backend.
