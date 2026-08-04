---
status: accepted
---

# Remove Project additional directories

Projects authorize exactly one canonical root. Connect removes Project-level additional directories from its Client Interface, CLI, persisted Project model, and Runtime Workspace because they exposed extra host paths without a per-directory permission policy: Codex treated them as writable roots, OpenCode as trusted roots, and CodeBuddy received them without Connect-enforced operation controls. Agent Binding-level additional directories remain a local-administrator configuration capability and are not exposed through Liveware. This decision supersedes the Project additional-directory capability recorded in ADR-0008.
