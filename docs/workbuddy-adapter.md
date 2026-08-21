# WorkBuddy Runtime Adapter

The WorkBuddy Runtime Adapter has two explicit Runtime Thread targets backed by the selected Tencent WorkBuddy distribution:

- a **WorkBuddy Task Attachment** adopts an existing desktop Task through its pinned private Task ACP interface and stays synchronized with WorkBuddy Desktop;
- a **CodeBuddy Session** starts or loads the distribution's embedded CodeBuddy CLI over stdio ACP. It is owned by Connect and does not appear in WorkBuddy Desktop.

The two targets share one Agent Binding and its Workspace Catalog, but never silently fall back to one another.

## Qualified distributions

| Binding profile | Observed desktop application | Observed embedded runtime | Protocol |
| --- | --- | --- | --- |
| `workbuddy-ai` | WorkBuddy AI `5.3.13` (`/Applications/WorkBuddy AI.app`) | CodeBuddy `2.115.0` | ACP v1 |
| `workbuddy-cn` | WorkBuddy `5.3.14` (`/Applications/WorkBuddy.app`) | CodeBuddy `2.115.0` | ACP v1 |

These versions record the installed products used for qualification; they are observations, not an application-version allowlist. Both applications may be installed at once. The selected profile fixes the bundle, data directory, process tree, and Task catalog used by that Agent Binding, while negotiated capabilities and installed qualification determine which behavior Connect may expose.

## Operator requirements

- macOS must have the selected distribution installed at its expected application path. Its embedded CodeBuddy CLI must negotiate ACP v1 and the capabilities required for the selected operation.
- `/new [name]` creates a Connect-owned CodeBuddy Session on the next real message. The response explicitly warns that this Session will not appear in WorkBuddy Desktop.
- To use desktop history and synchronization, create or select a WorkBuddy Task, open it, and complete one native turn if it has no active private endpoint yet. WorkBuddy Desktop must be running while Connect attaches to that Task.
- Install `clawling.runtime.workbuddy` from the release-bundled official Plugin registry, then create each Agent Binding against one explicit named capability:

  ```bash
  clawchat-connect plugin setup --non-interactive --select clawling.runtime.workbuddy
  clawchat-connect agent add desktop --plugin clawling.runtime.workbuddy --capability workbuddy-ai
  clawchat-connect agent add mainland --plugin clawling.runtime.workbuddy --capability workbuddy-cn
  ```

  The two capability schemas accept no profile override. Selecting `workbuddy-ai` or `workbuddy-cn` fixes the distribution for that Binding, and each Binding creates an independent Runtime Adapter, ACP client, process, catalog cache, and recovery state.

- Discover and adopt an existing Task from Connect Client or the ordinary Session catalog before submitting a desktop-synchronized turn.

ClawChat `/sessions` lists both target kinds in the current Workspace. `/switch <session-ref>` can select either kind. Selecting a Workspace remains independent of target kind; `/new` inherits the selected Workspace.

Release-bundled discovery preselects the WorkBuddy Plugin when either supported macOS application is present. Runtime activation validates the selected distribution and fails closed unless Task endpoint initialization negotiates ACP v1 and advertises `agentCapabilities.loadSession === true`. Connect does not call `session/load` when that capability is absent or false. Endpoints, ports, process identifiers, connection identifiers, tokens, passwords, authorization values, product configuration, executable overrides, version overrides, and profile overrides remain desktop-owned and are rejected.

## Security and ownership boundary

Every attachment reacquires ephemeral connection data and verifies all of the following before Task content is exchanged:

- the endpoint uses plain HTTP on `127.0.0.1`, `::1`, or `localhost` only;
- the selected application has the expected bundle identity, with installed versions retained only as qualification observations;
- the listener and established TCP connection belong to the selected application sidecar process tree;
- the endpoint, loaded Task, native transcript identity, Task identifier, and canonical workspace agree;
- replay reaches the pinned start and end boundaries.

ACP connection identifiers, Session tokens, product authorization, and injected product configuration stay in memory for one attachment. Diagnostic messages and details are bounded and redact credentials, authorization headers, product configuration, protocol payloads, and native transcript content. For a WorkBuddy Task, Connect persists the stable Task identifier. For a direct CodeBuddy Session, Connect persists a namespaced native Session identifier. It never persists an endpoint, port, ACP credential, or raw private payload.

Closing a Session, Agent Binding, or Connect Service closes only Connect-owned HTTP/SSE sockets, requests, timers, interactions, and caches. It is idempotent and never quits, kills, restarts, upgrades, signs into, or changes WorkBuddy Desktop or a Task process.

Archive, restore, and permanent delete are unsupported. Session close releases the attachment; Session invalidation removes only Connect's local mapping. Neither operation mutates the native Task.

## Capability and qualification limits

Connect adopts or recovers a Task only from complete `session/load` replay. `session/resume` returns no prior messages, so it is never substituted for replay, replay freshness, or transcript-identity verification.

The currently qualified native Tasks select `bypassPermissions`. They execute without emitting `session/request_permission`, so Connect neither synthesizes an approval nor advertises approval Interaction support for that attachment. This is an honest capability and installed-qualification downgrade, not a new Connect code capability. Native WorkBuddy must provide a non-bypass mode and emit the real request before approval Interaction can be qualified.

Native replay freshness immediately after a WorkBuddy UI write, sidecar health and publication across restart, complete mode/Command/Skill catalogs, and the clean simultaneous two-distribution installed matrix remain WorkBuddy-owned limitations or QA gaps. Connect fails closed rather than accepting replay or catalog subsets.

## Recovery behavior

Connect rediscovers and fully re-verifies the same Task after application restart, process replacement, or endpoint rotation. It reconciles authoritative native history before continuing. Connection refusal or closure from the discovered exact Task socket is `endpoint-stale`; Connect does not fall back to a different endpoint or create a replacement. A prompt is never automatically resubmitted after a transport failure:

- `prompt-not-committed` means native history proves the prompt was not committed;
- `prompt-failed` means native history proves the prompt failed;
- `prompt-outcome-indeterminate` means acceptance or effects cannot be determined safely.

A CodeBuddy Session is recovered only through stdio ACP `session/load` using its namespaced native Session identifier. A WorkBuddy Task is recovered only through Task rediscovery and reattachment. Connect does not reinterpret one identifier as the other, use the Tencent Agent SDK, substitute another distribution, or create a hidden replacement after recovery fails.

## Diagnostics

| Code | Operator meaning |
| --- | --- |
| `application-absent` | The selected desktop application is not installed at its pinned path. |
| `application-stopped` | The selected application is installed but not running. |
| `wrong-distribution` | The detected bundle belongs to the other or an unknown distribution. |
| `incompatible-version` | The sidecar contract, executable layout, or native runtime composition is unsupported; observed application versions are diagnostic only. |
| `discovery-failed` | WorkBuddy-owned deterministic Task state could not be inspected. |
| `task-not-found` | The selected profile's authoritative catalog has no matching Task. |
| `workspace-identity-mismatch` | Task workspace or native transcript workspace identity disagrees. |
| `endpoint-unavailable` | The Task has no active private endpoint. Open it and run one native turn. |
| `non-loopback-endpoint` | Discovery returned a non-loopback or otherwise unsafe endpoint. |
| `endpoint-stale` | The discovered exact Task socket refused the connection or closed; Connect does not fall back or replace it. |
| `recycled-endpoint` | The port or established connection changed owners. |
| `wrong-owning-process` | Application, sidecar, endpoint listener, or connected socket ownership is invalid. |
| `task-identity-mismatch` | Endpoint, replay, native transcript, or requested Task identifiers disagree. |
| `task-replay-incomplete` | Replay did not reach its required terminal boundary or fingerprint. |
| `authentication-failed` | Reacquired attachment authorization was rejected. |
| `protocol-incompatible` | ACP initialization negotiated the wrong protocol or did not advertise required `session/load` capability. |
| `endpoint-verification-failed` | A bounded framing, transport, or identity verification step failed. |
| `task-busy` | WorkBuddy UI already owns an active native Task turn. Wait until it is idle. |
| `prompt-not-committed` | Recovery proved the disconnected prompt never entered native history. |
| `prompt-failed` | Recovery found a terminal native failure for the prompt. |
| `prompt-outcome-indeterminate` | Recovery cannot prove whether the prompt or its effects completed. Do not retry automatically. |

## Optional installed-release diagnostics

When a maintainer needs to investigate or manually exercise both exact distributions on a designated Mac, run:

```bash
bun run check:release:workbuddy
```

This optional diagnostic command exercises discovery, adoption/replay, context/model/native-persistence/UI synchronization, cancellation, application restart, endpoint rotation, and recovery for both profiles, then runs the repository's non-browser quality gate. Approval Interaction is exercised only when the native Task emits a real permission request; `bypassPermissions` is recorded as no approval capability, never replaced by a synthesized approval. The result is useful task evidence, but it does not block creating or publishing a release tag. It does not install Chromium or use the standalone Connect Client as a substitute for WorkBuddy or ClawChat Liveware verification. Browser checks for the loopback Connect Client remain in the ordinary repository `bun run check` gate; any manual Liveware verification must open the registered App inside ClawChat.

Use dedicated test Tasks only. For each `WORKBUDDY_AI_TEST_` and `WORKBUDDY_CN_TEST_` prefix, set:

- `DEDICATED_TASK=1`, after confirming the configured Task is reserved for release verification;
- `TASK_ID`, `TASK_WORKSPACE`;
- `USER_MARKER`, `ASSISTANT_MARKER` for a unique UI-seeded turn;
- `PRIOR_USER_MARKER`, `PRIOR_ASSISTANT_MARKER` for context continuation;
- `UI_TASK_TITLE`, `UI_RESTORE_TASK_TITLE` so UI verification restores the prior application view even on failure;
- `UI_BACKGROUND_TASK_TITLE` for a second dedicated Task used to prove the Attachment remains bound while the application displays another Task;
- `UI_ORIGINATED_USER_MARKER`, `UI_ORIGINATED_ASSISTANT_MARKER` for the native UI turn performed while Connect holds the Attachment;
- `INTERACTION_PROMPT`, a safe permission probe; `bypassPermissions` must produce no approval request and is recorded as a capability downgrade;
- `CANCELLATION_PROMPT`, a harmless long-running prompt that can be cancelled safely.

Optional `TURN_MARKER` and `RECOVERY_MARKER` values make a diagnostic run reproducible; otherwise the suite generates unique markers. The scripts use temporary Connect databases and delete them. Native prompt markers intentionally remain in the dedicated WorkBuddy test Tasks as diagnostic evidence; the JSON result discloses them. Clean up only those dedicated Tasks through WorkBuddy after recording the result. Never point the suite at an unrelated Task.

The preflight requires both configured applications to be running simultaneously and resolves each Task only through its selected profile. The UI step switches to the dedicated Task, verifies the synchronized marker, and restores `UI_RESTORE_TASK_TITLE`. The concurrency/restart step asks the operator to complete one marked native UI turn while Connect holds the Attachment, switches the application to `UI_BACKGROUND_TASK_TITLE`, then deliberately asks the operator to restart only the selected distribution. Those observations contribute evidence; replay freshness, sidecar health, and the simultaneous matrix remain unqualified until every required row passes.

The tag-triggered GitHub release workflow cannot run signed-in WorkBuddy, ClawChat, or Liveware UI qualification on clean hosted runners. Native replay freshness, sidecar health, complete catalogs, and the simultaneous two-distribution matrix therefore remain explicit installed-product QA gaps until separately evidenced on clean Tasks. Release claims must not replace those scenarios with mocks or unauthenticated browser probes.
