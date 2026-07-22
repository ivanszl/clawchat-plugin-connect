# Limit each Runtime Adapter kind to one Agent Binding

A Connect installation may configure at most one Agent Binding for each Runtime Adapter kind, so one host can have one Codex Binding, one Claude Binding, one OpenCode Binding, and so on. Supporting multiple ClawChat identities or configuration profiles for the same local runtime kind is outside the model; config loading and CLI mutation must reject duplicate kinds.
