---
status: accepted
---

# Replace Projects with Binding-scoped Workspaces

Connect removes the installation-global Project and Non-Project Session model in a clean cutover. Every Agent Binding has one Connect-created Binding Default Workspace, its Runtime Adapter may report additional stable Runtime Workspace Identities with catalog completeness, and Core owns the Binding-scoped Workspace Catalog, assigns Workspace Refs, associates the Default root, and validates Session targets; equal local roots in different Bindings never share Workspace identity. Every Session uses exactly one Workspace, an omitted runtime source may become unavailable for new selection without breaking existing Session identity, and Binding removal or Owner Reset deletes Connect records but not Workspace files or runtime-native state. This supersedes the Project-specific clauses of ADR-0008, ADR-0009, ADR-0014, ADR-0016, ADR-0017, and ADR-0040, and fully supersedes ADR-0041 and ADR-0042.
