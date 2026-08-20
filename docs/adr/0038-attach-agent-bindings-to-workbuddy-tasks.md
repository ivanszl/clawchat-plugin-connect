---
status: accepted
---

# Attach Agent Bindings to WorkBuddy Tasks through private ACP

Connect will prioritize reusing existing WorkBuddy Tasks and keeping turns visible in WorkBuddy Desktop. A WorkBuddy-backed Agent Binding therefore forms a WorkBuddy Task Attachment through the desktop-owned Task ACP Endpoint instead of starting an independent embedded CodeBuddy CLI with `--acp`. This deliberately accepts a private, version-sensitive integration boundary because direct stdio ACP cannot join or update a WorkBuddy Task.

The integration supports two separately pinned profiles: WorkBuddy `5.3.8` with embedded CodeBuddy `2.115.0`, and WorkBuddy AI `5.2.7` with embedded CodeBuddy `2.106.4`. Each profile owns its endpoint discovery, handshake, protocol fixtures, product configuration, and installed-application tests. An unrecognized version or unverifiable Task identity fails closed; Connect does not fall back to stdio ACP, the Tencent Agent SDK, another distribution, or a newly created invisible Session.

An Agent Binding persists the stable WorkBuddy Task identifier, not a dynamic loopback port, connection identifier, or session token. Activation requires WorkBuddy Desktop and the selected Task to be available, reacquires current connection data, performs the private HTTP ACP handshake, loads the Task, and verifies transcript replay before accepting turns. Desktop shutdown, Task-process replacement, authentication expiry, or connection loss makes the attachment unavailable until it can be rediscovered and reverified.

This decision is based on local end-to-end tests of both pinned distributions. In each, the Task endpoint replayed existing user and agent messages, continued with the correct context, persisted the new turn to the same native session log, and updated the WorkBuddy UI. The endpoint also remained reachable when the user switched to another Task while the desktop application stayed running.

This supersedes ADR-0037. Direct stdio ACP remains useful evidence about the embedded runtime but is not the product integration boundary for WorkBuddy-backed Agent Bindings.

ADR-0040 later supersedes only the prohibition on direct stdio ACP and Connect-owned Sessions: an explicit CodeBuddy Session target now coexists with this Task Attachment target. This ADR remains authoritative for every desktop-synchronized WorkBuddy Task.

ADR-0064 later supersedes the exact application-version and embedded-runtime allowlists. This ADR remains authoritative for the Task Attachment boundary, distribution isolation, durable Task identity, synchronization, and recovery.
