# WorkBuddy Runtime Adapter

The WorkBuddy Runtime Adapter attaches Connect to an existing Task owned by one of two exact Tencent WorkBuddy desktop distributions. It uses a pinned private Task ACP interface. This is not a compatibility claim for an official or stable public API.

## Supported distributions

| Binding profile | Desktop application | Embedded runtime | Protocol |
| --- | --- | --- | --- |
| `workbuddy-ai` | WorkBuddy AI `5.2.7` (`/Applications/WorkBuddy AI.app`) | CodeBuddy `2.106.4` | ACP v1 |
| `workbuddy-cn` | WorkBuddy `5.3.8` (`/Applications/WorkBuddy.app`) | CodeBuddy `2.115.0` | ACP v1 |

Connect rejects every other application, embedded CodeBuddy, or ACP version. Both applications may be installed at once; the selected profile fixes the bundle, data directory, process tree, and Task catalog used by that Agent Binding.

## Operator requirements

- macOS must have the selected exact distribution installed and running.
- Create a dedicated Task in the desktop application before using Connect. The first release adopts an existing Task; it never creates an invisible Task or Session.
- Open the Task and complete one native turn if the Task has no active private endpoint yet.
- Add the Binding with an explicit profile:

  ```bash
  clawchat-connect agent add desktop --kind workbuddy --profile workbuddy-ai
  # or
  clawchat-connect agent add mainland --kind workbuddy --profile workbuddy-cn
  ```

- Discover and adopt the existing Task from Connect Client or the ordinary Session catalog before submitting a turn.

`clawchat-connect status --agent <binding-id>` reports the selected profile, exact supported tuple, and the latest operator diagnostic. Configuration accepts only `kind`, `profile`, `displayName`, and `outputVisibility` for a WorkBuddy Binding. Endpoints, ports, process identifiers, connection identifiers, tokens, passwords, authorization values, product configuration, executable overrides, and version overrides are desktop-owned and rejected.

## Security and ownership boundary

Every attachment reacquires ephemeral connection data and verifies all of the following before Task content is exchanged:

- the endpoint uses plain HTTP on `127.0.0.1`, `::1`, or `localhost` only;
- the selected application has the exact pinned bundle and versions;
- the listener and established TCP connection belong to the selected application sidecar process tree;
- the endpoint, loaded Task, native transcript identity, Task identifier, and canonical workspace agree;
- replay reaches the pinned start and end boundaries.

ACP connection identifiers, Session tokens, product authorization, and injected product configuration stay in memory for one attachment. Diagnostic messages and details are bounded and redact credentials, authorization headers, product configuration, protocol payloads, and native transcript content. Connect persists the stable Task identifier and its own sanitized Transcript Projection, never an endpoint, port, ACP credential, or raw private payload.

Closing a Session, Agent Binding, or Connect Service closes only Connect-owned HTTP/SSE sockets, requests, timers, interactions, and caches. It is idempotent and never quits, kills, restarts, upgrades, signs into, or changes WorkBuddy Desktop or a Task process.

Archive, restore, and permanent delete are unsupported. Session close releases the attachment; Session invalidation removes only Connect's local mapping. Neither operation mutates the native Task.

## Recovery behavior

Connect rediscovers and fully re-verifies the same Task after application restart, process replacement, or endpoint rotation. It reconciles authoritative native history before continuing. A prompt is never automatically resubmitted after a transport failure:

- `prompt-not-committed` means native history proves the prompt was not committed;
- `prompt-failed` means native history proves the prompt failed;
- `prompt-outcome-indeterminate` means acceptance or effects cannot be determined safely.

There is no stdio `codebuddy --acp` fallback, Tencent Agent SDK path, alternative distribution substitution, log parsing, or new hidden Session creation in discovery, compatibility, recovery, or error handling.

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

The release gate must run on one Mac with both exact distributions installed:

```bash
bun run check:release:workbuddy
```

The command runs the same discovery, adoption/replay, context/model/native-persistence/UI synchronization, Runtime Interaction/cancellation, application restart, endpoint rotation, and recovery scenarios for both profiles, then runs the complete repository quality gate. WorkBuddy remains ineligible for release if either installed suite or `bun run check` fails.

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

Alpha publication depends on the `workbuddy-installed` job in `.github/workflows/release-alpha.yml`. That job must run on a designated `self-hosted`, `macOS`, `workbuddy-release` runner with the corresponding protected environment secrets; missing confirmation, missing Tasks, an incompatible distribution, or any installed scenario failure blocks publication.
