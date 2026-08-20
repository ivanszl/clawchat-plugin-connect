---
status: superseded by ADR-0063
---

# Reuse a user-owned DeepSeek Harness Home

A DeepSeek Harness Agent Binding may select a DSH Home explicitly and otherwise uses DSH's native default Home, while Connect resolves its canonical identity only for activation and single-active ownership. Connect does not create an isolated Home under its own data directory or reuse the Binding Default Workspace as a Home: doing either would split the user's credentials, Profiles, plugins, and native Sessions from their existing DSH environment and would mix runtime configuration with Agent-visible working files. The independently selected Connect Workspace remains the Session's code environment.

“Single-active ownership” is limited to Connect-owned Bindings. DSH rc.7 exposes no Home-wide or Session-wide cross-process lease honored by Web/TUI, so the local Home claim cannot establish that an external client is idle. Persisted Session adoption and restart-resume therefore remain unsupported on rc.7 even though discovery and archive visibility use the selected Home.
