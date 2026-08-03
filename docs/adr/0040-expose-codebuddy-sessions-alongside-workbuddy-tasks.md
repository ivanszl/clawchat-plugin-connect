---
status: accepted
---

# Expose CodeBuddy Sessions alongside WorkBuddy Tasks

A WorkBuddy Agent Binding will expose two explicit Runtime Thread target kinds. `/new` creates a Connect-owned CodeBuddy Session through the selected distribution's embedded `codebuddy --acp` process. Adopting an existing WorkBuddy Task continues to use the verified private WorkBuddy Task ACP Endpoint. Connect persists direct targets as `codebuddy-session:<native-id>` and persists desktop targets as stable WorkBuddy Task IDs, so dispatch never guesses from runtime availability and never falls back between the two paths.

ClawChat labels both kinds in `/sessions` and `/status`. A CodeBuddy Session remains selectable and resumable in ClawChat but is explicitly described as Connect-only and does not appear in WorkBuddy Desktop. A WorkBuddy Task remains selectable and is described as desktop-synchronized. Both kinds use the ordinary Connect Session and Project model; `/new` inherits the current Project, and existing WorkBuddy Tasks and previously created CodeBuddy Sessions remain selectable within that workspace.

Direct CodeBuddy Sessions load through ACP `session/load`. Their native history persists in the distribution's CodeBuddy storage, but current Connect history reconciliation remains live-only because the ACP session surface does not expose the verified WorkBuddy Task replay boundary. WorkBuddy Tasks retain authoritative Task replay, input receipt reconciliation, endpoint verification, and safe recovery behavior.

This decision partially supersedes ADR-0038's prohibition on direct stdio ACP and invisible Session creation for a WorkBuddy Binding. ADR-0038 remains authoritative for WorkBuddy Task Attachment identity, security, synchronization, and recovery. It also reuses the direct ACP evidence from superseded ADR-0037 without reviving ADR-0037's proposed standalone `codebuddy` Adapter kind.
