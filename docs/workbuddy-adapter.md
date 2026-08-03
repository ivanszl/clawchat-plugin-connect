# WorkBuddy Runtime Adapter

The WorkBuddy Runtime Adapter has two explicit Runtime Thread targets backed by the selected Tencent WorkBuddy distribution:

- a **WorkBuddy Task Attachment** adopts an existing desktop Task through its pinned private Task ACP interface and stays synchronized with WorkBuddy Desktop;
- a **CodeBuddy Session** starts or loads the distribution's embedded CodeBuddy CLI over stdio ACP. It is owned by Connect and does not appear in WorkBuddy Desktop.

The two targets share an Agent Binding and Project catalog, but never silently fall back to one another.

## Supported distributions

| Binding profile | Desktop application | Embedded runtime | Protocol |
| --- | --- | --- | --- |
| `workbuddy-ai` | WorkBuddy AI `5.2.7` (`/Applications/WorkBuddy AI.app`) | CodeBuddy `2.106.4` | ACP v1 |
| `workbuddy-cn` | WorkBuddy `5.3.8` (`/Applications/WorkBuddy.app`) | CodeBuddy `2.115.0` | ACP v1 |

Connect rejects every other application, embedded CodeBuddy, or ACP version. Both applications may be installed at once; the selected profile fixes the bundle, data directory, process tree, and Task catalog used by that Agent Binding.

## Operator requirements

- macOS must have the selected exact distribution installed. Its embedded CodeBuddy CLI and ACP v1 tuple must match the pinned profile.
- `/new [name]` creates a Connect-owned CodeBuddy Session on the next real message. The response explicitly warns that this Session will not appear in WorkBuddy Desktop.
- To use desktop history and synchronization, create or select a WorkBuddy Task, open it, and complete one native turn if it has no active private endpoint yet. WorkBuddy Desktop must be running while Connect attaches to that Task.
- Add the Binding with an explicit profile:

  ```bash
  clawchat-connect agent add desktop --kind workbuddy --profile workbuddy-ai
  # or
  clawchat-connect agent add mainland --kind workbuddy --profile workbuddy-cn
  ```

- Discover and adopt an existing Task from Connect Client or the ordinary Session catalog before submitting a desktop-synchronized turn.

ClawChat `/sessions` lists both target kinds in the current Project (and all materialized WorkBuddy targets in the Non-Project workspace). `/switch <session-ref>` can select either kind. Selecting a Project remains independent of target kind; `/new` inherits the selected Project.

`clawchat-connect status --agent <binding-id>` reports the selected profile, exact supported tuple, and the latest operator diagnostic. Configuration accepts only `kind`, `profile`, `displayName`, and `outputVisibility` for a WorkBuddy Binding. Endpoints, ports, process identifiers, connection identifiers, tokens, passwords, authorization values, product configuration, executable overrides, and version overrides are desktop-owned and rejected.

## Security and ownership boundary

Every attachment reacquires ephemeral connection data and verifies all of the following before Task content is exchanged:

- the endpoint uses plain HTTP on `127.0.0.1`, `::1`, or `localhost` only;
- the selected application has the exact pinned bundle and versions;
- the listener and established TCP connection belong to the selected application sidecar process tree;
- the endpoint, loaded Task, native transcript identity, Task identifier, and canonical workspace agree;
- replay reaches the pinned start and end boundaries.

ACP connection identifiers, Session tokens, product authorization, and injected product configuration stay in memory for one attachment. Diagnostic messages and details are bounded and redact credentials, authorization headers, product configuration, protocol payloads, and native transcript content. For a WorkBuddy Task, Connect persists the stable Task identifier. For a direct CodeBuddy Session, Connect persists a namespaced native Session identifier. It never persists an endpoint, port, ACP credential, or raw private payload.

Closing a Session, Agent Binding, or Connect Service closes only Connect-owned HTTP/SSE sockets, requests, timers, interactions, and caches. It is idempotent and never quits, kills, restarts, upgrades, signs into, or changes WorkBuddy Desktop or a Task process.

Archive, restore, and permanent delete are unsupported. Session close releases the attachment; Session invalidation removes only Connect's local mapping. Neither operation mutates the native Task.

## Recovery behavior

Connect rediscovers and fully re-verifies the same Task after application restart, process replacement, or endpoint rotation. It reconciles authoritative native history before continuing. A prompt is never automatically resubmitted after a transport failure:

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
| `incompatible-version` | The application, embedded CodeBuddy, sidecar, or pinned product tuple is unsupported. |
| `discovery-failed` | WorkBuddy-owned deterministic Task state could not be inspected. |
| `task-not-found` | The selected profile's authoritative catalog has no matching Task. |
| `workspace-identity-mismatch` | Task workspace or native transcript workspace identity disagrees. |
| `endpoint-unavailable` | The Task has no active private endpoint. Open it and run one native turn. |
| `non-loopback-endpoint` | Discovery returned a non-loopback or otherwise unsafe endpoint. |
| `endpoint-stale` | The endpoint stopped listening during verification. |
| `recycled-endpoint` | The port or established connection changed owners. |
| `wrong-owning-process` | Application, sidecar, endpoint listener, or connected socket ownership is invalid. |
| `task-identity-mismatch` | Endpoint, replay, native transcript, or requested Task identifiers disagree. |
| `task-replay-incomplete` | Replay did not reach its required terminal boundary or fingerprint. |
| `authentication-failed` | Reacquired attachment authorization was rejected. |
| `protocol-incompatible` | ACP initialization negotiated a protocol other than the pinned ACP v1. |
| `endpoint-verification-failed` | A bounded framing, transport, or identity verification step failed. |
| `task-busy` | WorkBuddy UI already owns an active native Task turn. Wait until it is idle. |
| `prompt-not-committed` | Recovery proved the disconnected prompt never entered native history. |
| `prompt-failed` | Recovery found a terminal native failure for the prompt. |
| `prompt-outcome-indeterminate` | Recovery cannot prove whether the prompt or its effects completed. Do not retry automatically. |

## Installed release verification

Before creating a release tag, qualify both exact distributions on one designated Mac:

```bash
bun run check:release:workbuddy
```

Run this command locally as a pre-release qualification on the designated Mac. It exercises discovery, adoption/replay, context/model/native-persistence/UI synchronization, Runtime Interaction/cancellation, application restart, endpoint rotation, and recovery for both profiles, then runs the repository's non-browser quality gate. WorkBuddy remains unqualified if either installed suite or `bun run check:core` fails. It does not install Chromium or use the standalone Connect Client as a substitute for WorkBuddy or ClawChat Liveware verification. Browser checks for the loopback Connect Client remain in the ordinary repository `bun run check` gate; real Liveware verification must open the registered App inside ClawChat.

Use dedicated test Tasks only. For each `WORKBUDDY_AI_TEST_` and `WORKBUDDY_CN_TEST_` prefix, set:

- `DEDICATED_TASK=1`, after confirming the configured Task is reserved for release verification;
- `TASK_ID`, `TASK_WORKSPACE`;
- `USER_MARKER`, `ASSISTANT_MARKER` for a unique UI-seeded turn;
- `PRIOR_USER_MARKER`, `PRIOR_ASSISTANT_MARKER` for context continuation;
- `UI_TASK_TITLE`, `UI_RESTORE_TASK_TITLE` so UI verification restores the prior application view even on failure;
- `UI_BACKGROUND_TASK_TITLE` for a second dedicated Task used to prove the Attachment remains bound while the application displays another Task;
- `UI_ORIGINATED_USER_MARKER`, `UI_ORIGINATED_ASSISTANT_MARKER` for the native UI turn performed while Connect holds the Attachment;
- `INTERACTION_PROMPT`, a safe prompt known to request one approval in that dedicated Task;
- `CANCELLATION_PROMPT`, a harmless long-running prompt that can be cancelled safely.

Optional `TURN_MARKER` and `RECOVERY_MARKER` values make a release run reproducible; otherwise the suite generates unique markers. The scripts use temporary Connect databases and delete them. Native prompt markers intentionally remain in the dedicated WorkBuddy test Tasks as release evidence; the JSON result discloses them. Clean up only those dedicated Tasks through WorkBuddy after recording the result. Never point the suite at an unrelated Task.

The preflight requires both exact applications to be running simultaneously and resolves each configured Task only through its selected profile. The UI step switches to the dedicated Task, verifies the synchronized marker, and restores `UI_RESTORE_TASK_TITLE`. The concurrency/restart step asks the operator to complete one marked native UI turn while Connect holds the Attachment, switches the application to `UI_BACKGROUND_TASK_TITLE`, then deliberately asks the operator to restart only the selected distribution. It verifies projection-only reconciliation, continued use of the original Task, and stable Task identity across rotated application, sidecar, endpoint, and credential state.

The tag-triggered GitHub release workflow intentionally does not run installed WorkBuddy, ClawChat, or Liveware UI qualification. It runs only deterministic code checks and packaging on clean GitHub-hosted runners; no WorkBuddy Task metadata or credentials belong in GitHub Actions. Record the local qualification result before creating the release tag.
