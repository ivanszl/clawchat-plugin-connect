# Runtime Adapters

Connect owns one runtime instance per Agent Binding. A runtime adapter may only connect to a user-installed
executable; installation, authentication, provider subscriptions, plugins, MCP configuration, and native agent
configuration remain owned by that runtime.

## Released capabilities

| Adapter | Process interface | Session options | Discover/resume | Cancel | Delete | Archive/restore |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | `codex app-server` | sandbox, model, reasoning | yes | yes | yes | yes |
| OpenCode | `opencode serve` | agent, provider-qualified model, variant | yes | yes | yes | disabled |

OpenCode compatibility is deliberately pinned to OpenCode `1.18.10` with `@opencode-ai/sdk` `1.18.10`.
Supporting another version requires updating the compatibility fixtures and installed-runtime integration test;
Connect does not automatically install or upgrade OpenCode.

## Deferred native capability verification

Keep these items separate from the released capability matrix until each has a stable native API and behavioral
coverage:

- OpenCode archive and restore.
- OpenCode native Session rename.
- OpenCode provider authentication and subscription inspection (expected to remain runtime-owned).
- OpenCode plugin and MCP management (expected to remain runtime-owned).
- OpenCode assistant-generated outbound media beyond Connect's existing safe image rules.
- Runtime-specific compaction controls and context metrics.
- Attaching to an already-running runtime Server or TUI (currently intentionally unsupported).

