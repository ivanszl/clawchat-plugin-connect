---
status: superseded by ADR-0038
---

# Integrate WorkBuddy distributions through embedded CodeBuddy ACP

The CodeBuddy Runtime Adapter will locate the embedded CodeBuddy CLI in an exactly supported user-installed WorkBuddy distribution, start it with `--acp`, and speak ACP through a private Connect-owned client. It will not depend on `@tencent-ai/agent-sdk`, because that package bundles another CodeBuddy CLI and would make Connect distribute and implicitly select a runtime installation while adding another vendor compatibility layer. It will not attach to a WorkBuddy Task ACP Endpoint or reuse the desktop product's private connector proxy, dynamic ports, passwords, or bearer tokens; the Adapter owns a local child process and needs no HTTP listener.

The initial release exposes two explicit installation profiles behind the shared Adapter:

- `workbuddy-cn` locates `WorkBuddy.app` (`com.workbuddy.workbuddy`), uses its `.workbuddy` product configuration, and initially pins WorkBuddy `5.3.8`, embedded CodeBuddy `2.115.0`, and ACP v1.
- `workbuddy-ai` locates `WorkBuddy AI.app` (`com.workbuddy.workbuddy-ai`), uses its separate `.workbuddy-ai` product configuration, and initially pins WorkBuddy AI `5.2.7`, embedded CodeBuddy `2.106.4`, and ACP v1.

Connect pins an exact `(distribution, app version, embedded CLI version, ACP client protocol version)` tuple for each profile. A different installed tuple fails activation with a profile-specific diagnostic. Each upgrade is a coordinated change to that profile's pins, protocol fixtures, CodeBuddy-specific event and interaction mapping, Adapter implementation, and installed-distribution integration suite. Connect performs no compatibility-range handling, cross-profile fallback, SDK fallback, or automatic WorkBuddy or CodeBuddy installation or upgrade.

ACP transport details, CodeBuddy extensions, native Session identifiers, native event payloads, distribution paths, and product configuration directories remain private to the CodeBuddy Runtime Adapter. The released Runtime Adapter kind is `codebuddy`, with an explicit WorkBuddy distribution profile; it is not a generic ACP runtime. Another ACP-capable agent must prove and own its semantics behind a separate Adapter without changing Connect Runtime callers.

Starting ACP does not require a model argument. After `session/new`, the Adapter uses the returned current model unless the Agent Binding stores an optional model override. It applies an override through the pinned CodeBuddy `session/set_model` extension rather than restarting the process or requiring `--model`; the profile integration suite covers that private extension for each exact version tuple.

The Adapter exposes the product-configured CodeBuddy Agent bundled by the selected WorkBuddy distribution, but the WorkBuddy Desktop UI is not its integration boundary. Through the chosen direct stdio boundary, Connect does not promise access to existing WorkBuddy Tasks, product history, desktop-managed connectors, or UI state, and it treats Connect-owned CodeBuddy Sessions and tool-level Tasks as distinct from WorkBuddy Tasks.

## Tested boundary

The accepted decision distinguishes two ACP surfaces that share protocol vocabulary but not ownership or semantics:

- A standalone embedded CLI started with `--acp` can create and resume Connect-owned CodeBuddy Sessions across fresh processes. Loading a WorkBuddy-created Task UUID may return success, but it does not replay the Task transcript into that client, and prompts do not join or update the desktop Task. A successful `session/load` response is therefore not evidence that a WorkBuddy Task was adopted.
- Each tested WorkBuddy Task had a desktop-owned loopback HTTP ACP endpoint. After its connection handshake, `session/load` replayed the existing user and agent messages; `session/prompt` used that context, persisted the new turn to the same native session log, and updated the open WorkBuddy UI. The endpoint remained reachable after switching to another Task while the desktop application stayed running.

This behavior was reproduced locally on both pinned profiles: WorkBuddy `5.3.8` with CodeBuddy `2.115.0`, and WorkBuddy AI `5.2.7` with CodeBuddy `2.106.4`. It proves that same-Task execution is technically possible through the private Task endpoint, not that the endpoint is a supported integration API.

The initial Adapter still chooses direct stdio ACP because the Task endpoint is allocated and configured by WorkBuddy Desktop, is tied to the desktop and Task process lifecycle, and has no documented stable discovery, authentication, ownership, or compatibility contract for Connect. Supporting existing WorkBuddy Tasks later would require a separate desktop-task integration profile with explicit endpoint discovery, lifecycle recovery, connection arbitration, product-policy mapping, transcript tests, and vendor support; it must not be smuggled into the direct `codebuddy` Adapter as an incidental resume path.
