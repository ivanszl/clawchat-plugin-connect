---
status: superseded by ADR-0063
---

# Select an existing DeepSeek Harness Profile per Binding

Every DeepSeek Harness Agent Binding selects one existing named Profile from its selected DSH Home, while Connect supplies only its lifecycle-bound Integration Bridge overlay and the independent Session Workspace. Connect does not create a reserved Profile or force `web` or `headless`, because the Profile is the user's DSH-owned composition of bundles, plugins, providers, tools, Skills, MCP servers, subagents, and policy; choosing it explicitly preserves that ecosystem without making Connect responsible for installing or mutating it.
