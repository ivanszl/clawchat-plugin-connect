# WorkBuddy Runtime Adapter

The WorkBuddy Runtime Adapter has two explicit Runtime Thread targets backed by the selected Tencent WorkBuddy distribution:

- a **WorkBuddy Task Attachment** adopts an existing desktop-owned Task through its pinned private Task ACP interface and retains that Task's native identity and history independently of the desktop's current selection;
- a **CodeBuddy Session** starts or loads the distribution's embedded CodeBuddy CLI over stdio ACP. It is owned by Connect and does not appear in WorkBuddy Desktop.

The two targets share one Agent Binding and its Workspace Catalog, but never silently fall back to one another.

WorkBuddy Desktop is a native runtime client and private endpoint provider, not the owner or routing target of an Agent Binding or Session. Switching the desktop from Task A to Task B must not detach, suspend, or redirect an existing Task A Attachment. As with two native TUIs operating the same Workspace, sharing a Workspace does not merge their Runtime Threads, and no cross-client live message mirroring is implied.

## Qualified distributions

| Binding profile | Observed desktop application | Observed embedded runtime | Protocol |
| --- | --- | --- | --- |
| `workbuddy-ai` | WorkBuddy AI `5.3.13` (`/Applications/WorkBuddy AI.app`) | CodeBuddy `2.115.0` | ACP v1 |
| `workbuddy-cn` | WorkBuddy `5.3.14` (`/Applications/WorkBuddy.app`) | CodeBuddy `2.115.0` | ACP v1 |

These versions record the installed products used for qualification; they are observations, not an application-version allowlist. Both applications may be installed at once. The selected profile fixes the bundle, data directory, process tree, and Task catalog used by that Agent Binding, while negotiated capabilities and installed qualification determine which behavior Connect may expose.

## Operator requirements

- macOS must have the selected distribution installed at its expected application path. Its embedded CodeBuddy CLI must negotiate ACP v1 and the capabilities required for the selected operation.
- `/new [name]` creates a Connect-owned CodeBuddy Session on the next real message. The response explicitly warns that this Session will not appear in WorkBuddy Desktop.
- To adopt desktop-owned Task history, create or select a WorkBuddy Task, open it, and complete one native turn if it has no active private endpoint yet. This materializes transport for initial adoption only; after adoption, the desktop's selected Task is not Attachment state or routing identity.
- Install `clawling.runtime.workbuddy` from the release-bundled official Plugin registry, then create each Agent Binding against one explicit named capability:

  ```bash
  clawchat-connect plugin setup --non-interactive --select clawling.runtime.workbuddy
  clawchat-connect agent add desktop --plugin clawling.runtime.workbuddy --capability workbuddy-ai
  clawchat-connect agent add mainland --plugin clawling.runtime.workbuddy --capability workbuddy-cn
  ```

  The two capability schemas accept no profile override. Selecting `workbuddy-ai` or `workbuddy-cn` fixes the distribution for that Binding, and each Binding creates an independent Runtime Adapter, ACP client, process, catalog cache, and recovery state.

- Discover and adopt an existing Task from Connect Client or the ordinary Session catalog before submitting a Turn to that Task Attachment.

ClawChat `/sessions` lists both target kinds in the current Workspace. `/switch <session-ref>` can select either kind. Selecting a Workspace remains independent of target kind; `/new` inherits the selected Workspace.

Release-bundled discovery preselects the WorkBuddy Plugin when either supported macOS application is present. Runtime activation validates the selected distribution and fails closed unless Task endpoint initialization negotiates ACP v1 and advertises `agentCapabilities.loadSession === true`. Connect does not call `session/load` when that capability is absent or false. Endpoints, ports, process identifiers, connection identifiers, tokens, passwords, authorization values, product configuration, executable overrides, version overrides, and profile overrides remain desktop-owned and are rejected.

## ClawChat and Liveware availability

A WorkBuddy availability error during initial Runtime preparation does not close the signed-in ClawChat Binding WebSocket or its control commands. Typed retryable failures recover through Core's background preparation retry; typed unsupported failures do not enter that retry loop. If a later retry reports an untyped Core/runtime failure, Core shuts down that Binding rather than exposing a partially prepared Runtime. Other Bindings remain independent.

The shared Liveware Client catalog contains a WorkBuddy discovery failure to the affected Binding. Existing durable Session entries and their stored Transcripts remain open and readable, and Runtime-independent Binding controls remain available. The failed discovery does not make a native Task usable: adoption, prompt submission, cancellation, and unsafe lifecycle actions stay disabled until safe discovery and preparation succeed.

Slash capability discovery returns a scoped empty result rather than an HTTP 500 when WorkBuddy cannot supply suggestions. Its availability distinguishes:

- `unsupported` — the selected Runtime capability or negotiated protocol cannot provide the feature; it is not retried in the background;
- `unavailable` — the capability is supported but its application, endpoint, authentication, or discovery state is temporarily unavailable;
- `conflict` — Task identity, workspace, replay, or other fail-closed state prevents safe use.

These states never authorize adoption or prompt submission. Restore an `unavailable` Runtime and retry the command; update an `unsupported` capability; resolve the exact Task identity or replay problem for a `conflict`.

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

Current installed `workbuddy-ai` qualification observed a complete Task-owned catalog: five text-only models, six modes, three Session options, 40 Runtime Commands, and 32 Runtime Skills. These counts are diagnostics, not an allowlist. It also passed authoritative active-branch reconciliation after a native UI Turn, background Task A execution while WorkBuddy displayed Task B, and automatic same-Task continuation after application restart. Mainland `workbuddy-cn` completion is accepted through the shared Adapter contract and automated profile parity without another installed UI run. Approval remains unsupported for Tasks configured to skip permission checks.

## Recovery behavior

Connect rediscovers and fully re-verifies the same Task after application restart, process replacement, endpoint rotation, or native-client selection change. It reconciles authoritative native history before continuing and checks the retained socket before every Turn. If an exact Task endpoint has stale replay, Connect closes only its own Attachment and uses a separately verified capability-owned host Attachment whose Task ID, Workspace, sidecar ownership and complete replay match current native state; it never kills the exact endpoint or falls back to another Task, Runtime Capability or hidden Session. A prompt is never automatically resubmitted after transmission makes native acceptance uncertain:

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

When a maintainer needs to investigate one installed distribution on a designated Mac, run only that profile's command:

```bash
bun run test:integration:workbuddy-ai
# or
bun run test:integration:workbuddy-cn
```

Each command independently exercises discovery, adoption/replay, context/model/native persistence, native-client selection independence, cancellation, application restart, endpoint rotation, and recovery for its selected profile. Running both desktop applications together is not required. Approval is exercised only when the selected native Task actually asks for permission; a Task configured to skip permission checks is reported as unsupported rather than replaced by a synthesized prompt.

Use a dedicated test Task and set only the chosen profile's `WORKBUDDY_AI_TEST_` or `WORKBUDDY_CN_TEST_` variables:

- `DEDICATED_TASK=1`, after confirming the configured Task is reserved for release verification;
- `TASK_ID`, `TASK_WORKSPACE`;
- `USER_MARKER`, `ASSISTANT_MARKER` for a unique UI-seeded turn;
- `PRIOR_USER_MARKER`, `PRIOR_ASSISTANT_MARKER` for context continuation;
- `UI_TASK_TITLE`, `UI_RESTORE_TASK_TITLE` so native-client selection checks restore the prior application view even on failure;
- `UI_BACKGROUND_TASK_TITLE` for a second dedicated Task used to prove the Attachment remains bound while the application displays another Task;
- `UI_ORIGINATED_USER_MARKER`, `UI_ORIGINATED_ASSISTANT_MARKER` for the native UI turn performed while Connect holds the Attachment;
- `INTERACTION_PROMPT`, a safe permission probe;
- `CANCELLATION_PROMPT`, a harmless long-running prompt that can be cancelled safely.

Optional `TURN_MARKER` and `RECOVERY_MARKER` values make a diagnostic run reproducible; otherwise the suite generates unique markers. The scripts use temporary Connect databases and delete them. Native prompt markers intentionally remain in the dedicated WorkBuddy test Task as diagnostic evidence; the JSON result discloses them. Clean up only that dedicated Task through WorkBuddy after recording the result. Never point a suite at an unrelated Task.

The UI steps select only the chosen profile's dedicated Task, restore `UI_RESTORE_TASK_TITLE`, switch to `UI_BACKGROUND_TASK_TITLE`, and ask the operator to restart only that selected distribution. No other WorkBuddy installation participates in the result.

Hosted GitHub runners cannot perform signed-in WorkBuddy, ClawChat, or Liveware UI checks. These profile-specific diagnostics remain optional local evidence and do not block creating or publishing a release tag.
