---
status: accepted
---

# Broker Agent-managed Liveware commands through Connect

Agents may deploy additional Liveware Apps with Connect's bundled Liveware executable, but they invoke it through a Connect command boundary rather than logging in to Liveware directly. Connect resolves the bundled executable, obtains a short-lived Liveware control token from the selected Agent Binding's stored activation, and passes that token only through the child environment; it never exposes the ClawChat access token or asks Liveware to persist it from a process argument.

These Agent-Managed Liveware Apps remain separate from the Connect-managed Liveware Exposure. Agent workflows must not reuse, modify, or retire the `ClawChat Connect` App that publishes Connect Client.

The Agent-facing boundary is an allowlist rather than arbitrary Liveware CLI passthrough. It accepts structured app list, inspect, create, access-policy, delete, and loopback tunnel bind or unbind operations; it rejects login, agent-process control, unknown commands, shell composition, the reserved `ClawChat Connect` name, and any mutation targeting the Connect-managed App id. Tunnel targets are restricted to a validated `http://127.0.0.1:<port>` endpoint.

The installed workflow does not offer a tunnel-only mode. A local web service need not be ClawChat-specific, but once the Agent uses this workflow it must register every successfully bound App into ClawChat through `clawchat_register_app` so the result appears as an App tile.
