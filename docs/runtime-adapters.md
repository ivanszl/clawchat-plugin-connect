# Runtime Adapters

Connect owns one Runtime Adapter instance per Agent Binding. Every instance is created by one installed and active
Runtime Plugin capability identified by exact `pluginId` and `capabilityId`. A Binding persists that reference and the
capability's validated `runtimeConfig`; Runtime family is provider manifest metadata and is not Binding state.

The Registry starts empty. Plugin Bundles activate before service surfaces, and each Bundle may publish several
capabilities—including multiple capabilities with the same family—without collision. A missing, disabled, incompatible,
or erroneous exact provider leaves only its dependent Bindings unavailable; Plugin administration remains usable without
any Runtime Plugin installed.

Dependent Sessions remain catalog-visible when their exact provider is inactive. Their status is `offline`, turn submission and native lifecycle actions are unavailable, and transcript/state inspection does not instantiate an Adapter. Re-enabling the exact provider restores the Binding without rewriting its persisted capability identity or Runtime Thread IDs.

A Runtime Plugin may only connect to a user-installed executable. Installation, authentication, provider subscriptions,
plugins, MCP configuration, and native agent configuration remain owned by that runtime.

## Official capabilities

| Plugin capability | Family | Process interface | Session options | Discover/resume | Cancel | Delete | Archive/restore |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `clawling.runtime.codex/codex` | Codex | `codex app-server` | sandbox, model, reasoning | yes | yes | yes | yes |
| `clawling.runtime.opencode/opencode` | OpenCode | `opencode serve` | agent, provider-qualified model, variant | yes | yes | yes | disabled |
| `clawling.runtime.workbuddy/workbuddy-ai` | WorkBuddy | ACP / CodeBuddy stdio | capability-owned | yes | yes | no | no |
| `clawling.runtime.workbuddy/workbuddy-cn` | WorkBuddy | ACP / CodeBuddy stdio | capability-owned | yes | yes | no | no |

Runtime executable compatibility is declared and checked by each official Plugin Bundle. Connect does not automatically
install or upgrade those executables.

## Deferred native capability verification

Keep these items separate from the official capability matrix until each has a stable native API and behavioral
coverage:

- OpenCode archive and restore.
- OpenCode native Session rename.
- OpenCode provider authentication and subscription inspection (expected to remain runtime-owned).
- OpenCode plugin and MCP management (expected to remain runtime-owned).
- OpenCode assistant-generated outbound media beyond Connect's existing safe image rules.
- Runtime-specific compaction controls and context metrics.
- Attaching to an already-running runtime Server or TUI (currently intentionally unsupported).
