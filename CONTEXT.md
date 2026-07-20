# ClawChat Connect

ClawChat Connect binds ClawChat conversations to local agent runtimes while keeping conversation, project, and runtime concepts distinct.

## Language

**Agent Binding**:
A named association between Connect and one configured local agent runtime. Multiple Agent Bindings may use the same runtime kind with different configuration.
_Avoid_: Agent, when referring to the configured association rather than the external agent itself

**Runtime Adapter**:
A concrete integration that lets Connect start and operate one kind of coding agent runtime. Codex is the first Runtime Adapter, not the definition of Connect or Agent Binding.
_Avoid_: Agent Binding, Codex, when referring to the adapter role

**Project**:
A named, reusable local code workspace that a Session may use. A Project has a root location, but it is not merely a directory path.
_Avoid_: Directory, cwd, repository

**Session**:
A continuous Connect conversation using one Agent Binding and optionally one Project. A Session owns conversation continuity, not project identity.
_Avoid_: Project, Runtime Thread

**Non-Project Session**:
A Session that is not associated with a Project. It supports ordinary agent conversation without requiring an existing code workspace.
_Avoid_: Directoryless Session

**Runtime Thread**:
The external agent runtime's resumable conversation associated with a Session. Its identity is owned by the runtime and referenced by Connect.
_Avoid_: Session, Project

## Invariants

- Connect binds and manages multiple Agent Bindings independently of any one runtime kind.
- Agent Binding IDs are arbitrary; Runtime Adapter selection comes only from the Binding's explicit `kind`.
- The first release registers only the Codex Runtime Adapter; that is a release scope, not a domain invariant.
- Successful activation synchronizes the Agent Binding ID to the connected ClawChat Profile nickname.
- Projects are global and reusable across Agent Bindings.
- Sessions are scoped by ClawChat conversation and Agent Binding.
- A Session has zero or one Project.
- Changing Project association creates a new Session and a new Runtime Thread boundary.
- A Non-Project Session receives a deterministic isolated workspace and never inherits `process.cwd()`.
- Connect control commands are restricted to the Agent Binding owner.
- Connect does not expose ClawChat tools or inject a bundled MCP server into Runtime Threads.
- ClawChat Profile updates are explicit authenticated CLI operations.
