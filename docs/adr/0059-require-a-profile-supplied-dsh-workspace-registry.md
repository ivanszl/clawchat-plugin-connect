---
status: superseded by ADR-0063
---

# Require a Profile-supplied DSH Workspace Registry

A DeepSeek Harness Agent Binding accepts only a selected Profile whose own bundle/patch composition supplies DSH's Workspace Registry and its required storage services. Archive membership is Home-global and separate from the append-only Session log; without the registry, Connect can discover a persisted Session but cannot authoritatively determine whether DSH Web archived it. Treating that Session as active would permit unsafe adoption, while reading private storage or adding Web feature services through the Bridge would violate the Runtime Adapter standard.

The Connect-owned Bridge therefore observes `workspaceRegistry` through DSH's runtime dependency mechanism during activation. It does not infer compatibility from a Profile name or file layout and does not add the service. Absence fails activation with the actionable reason `workspace-registry-missing`; presence allows activation and makes native one-way archive available. DSH rc.7 restore/unarchive and permanent Session deletion remain unsupported.

The [published-runtime prototype](../../.scratch/deepseek-harness-integration/prototype/result-profile-requirement.md) verifies both branches against `@deepseek-ai/dsh@0.1.0-rc.7`: a Bridge-only overlay adds no Workspace feature row and rejects a base-only Profile, while a Profile whose own patch supplies the official Workspace/storage services completes the Bridge handshake and disposes cleanly.
