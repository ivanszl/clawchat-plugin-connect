---
status: superseded by ADR-0030
---

# Execute ClawChat Tool Commands in Connect Service

The `clawchat-connect` CLI is only a local entrypoint for Agent-callable ClawChat Tool Commands. It sends the canonical tool name and input to a local-only authenticated Tool Command Gateway; Connect Service validates the request, selects the Agent Binding, executes it with that Binding Runtime Instance's active HTTP or WebSocket transport, and returns the result.

The CLI never reads activation credentials or falls back to direct ClawChat access when the Service is unavailable. The Gateway is separate from Client Interface and is not reachable through trusted-LAN mode or Liveware Exposure, preventing browser and remote Client access from inheriting Agent tool capabilities.
