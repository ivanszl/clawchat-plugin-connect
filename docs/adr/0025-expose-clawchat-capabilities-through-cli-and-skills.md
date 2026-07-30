---
status: accepted
---

# Expose ClawChat capabilities through CLI commands and installed skills

Connect exposes Agent-callable ClawChat capabilities as authenticated CLI commands addressed by canonical `clawchat_*` tool name. An installed skill teaches the local Agent when and how to invoke those commands; Connect does not register runtime-native tools, inject an MCP server, or define grouped CLI command families for the same capabilities. This keeps Runtime Adapter integration independent of tool-registration protocols while preserving one stable tool vocabulary across Connect and Hermes Agent.

The canonical invocation is `clawchat-connect tool call <tool-name> --input-json <json-or-stdin>`, with optional explicit request and Agent Binding identifiers. Binding selection prefers explicit CLI input, then the Binding Runtime Instance context, then the configured default. Each accepted invocation writes exactly one JSON Tool Call Record envelope to stdout; failed, expired, and indeterminate outcomes also return a non-zero exit status, while errors that prevent submission are written to stderr. Static `tool list` and `tool describe` operations read the bundled catalog without creating Tool Requests.

Canonical tool schemas do not gain a generic confirmation flag that an Agent could set mechanically. The installed skills require explicit user intent for mutations and resolve ambiguous targets through authoritative list or search results before calling by exact id. Connect Service validates schema, Binding, and reserved-resource boundaries without attempting to infer natural-language authorization.

The CLI also does not add Session or Turn correlation parameters solely to suppress follow-up output. After a successful mention or message reaction, the skill tells the Agent not to emit a duplicate ordinary reply; Connect Service does not maintain a separate Turn-level suppression protocol for Tool Requests.
