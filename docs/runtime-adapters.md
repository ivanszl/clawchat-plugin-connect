# Runtime Adapters

Connect owns one Runtime Adapter instance per Agent Binding. Every instance is created by one installed and active
Runtime Plugin capability identified by exact `pluginId` and `capabilityId`. A Binding persists that reference and the
capability's validated `runtimeConfig`; Runtime family is provider manifest metadata and is not Binding state.

The Registry starts empty. Plugin Bundles activate before service surfaces, and each Bundle may publish several
capabilities—including multiple capabilities with the same family—without collision. A missing, disabled, incompatible,
or erroneous exact provider leaves only its dependent Bindings unavailable; Plugin administration remains usable without
any Runtime Plugin installed.

Dependent Sessions remain catalog-visible when their exact provider is inactive. Their status is `offline`, turn submission and native lifecycle actions are unavailable, and transcript/state inspection does not instantiate an Adapter. Re-enabling the exact provider restores the Binding without rewriting its persisted capability identity or Runtime Thread IDs.

A Runtime Plugin may only connect to a user-installed executable. Installation, authentication, provider subscriptions,
plugins, MCP configuration, and native agent configuration remain owned by that runtime.

## Normative Runtime Adapter standard

Every released and future Runtime Plugin capability must satisfy the same Runtime Adapter Interface and the numbered
requirements below. Uniformity means identical Connect semantics and failure behavior, not that every native runtime
must implement every optional feature. A capability that the native runtime cannot provide must report it as unsupported;
an Adapter must not simulate support by mutating private storage, rebuilding native context from the Connect Transcript
Projection, or silently substituting another behavior. An Adapter-side Bridge or sidecar may translate capabilities
already supplied by the selected native composition, but must not inject unrelated native feature modules or services
to manufacture a missing optional capability. Process-scoped transport wiring is permitted only for the Adapter's own
communication seam and does not change this rule.

Each Runtime Plugin specification and release review must include a capability profile covering every requirement ID.
The shared Runtime Adapter conformance suite is the executable enforcement target for this list. A numbered requirement
that the suite does not yet cover is a conformance gap, not permission for Adapters to diverge. Adapter-specific tests
add native transport and compatibility coverage but may not replace or weaken the shared checks.

| ID | Area | Uniform requirement | Capability handling and verification |
| --- | --- | --- | --- |
| `RA-01` | Ownership | One Agent Binding owns one isolated Binding Runtime Instance. The runtime executable, authentication, subscriptions, native configuration, and native plugins remain user-owned. | The Adapter closes only resources it created. Shared conformance verifies exactly-once close and pending-operation settlement. |
| `RA-02` | Compatibility | The Adapter identifies the native executable and the private Adapter protocol it operates, then fails activation with actionable diagnostics when that declared contract is incompatible. | Official capabilities publish a tested compatibility contract—version-pinned or capability-negotiated—and run against a real installation before release. |
| `RA-03` | Native discovery | Discovery reports every discoverable top-level native Runtime Thread in the selected runtime ownership scope, regardless of whether Connect, a native TUI, Web UI, or another native client created it. Provenance must never be used to hide an otherwise eligible top-level thread. | Child or subagent threads are excluded from the top-level Session Catalog and projected beneath their parent when supported. Discovery reports complete, partial, or unavailable truthfully; it never converts failure into an authoritative empty result. |
| `RA-04` | Visibility and adoption | A discovered top-level Runtime Thread keeps a stable identity and remains visible when it cannot currently be adopted. Adoption verifies Workspace compatibility and the runtime's declared native readiness semantics before Connect creates the Session mapping. | Missing Workspace, incompatible state, corruption, archive state, or a native conflict produces an explicit unavailable/conflict reason instead of silent omission or fallback. Connect does not invent a private owner, lease, busy probe, or exclusion policy when the runtime deliberately owns concurrency behavior. |
| `RA-05` | Workspace | Every Connect Session uses exactly one immutable Binding-scoped Workspace. Runtime-reported local roots are canonicalized and mapped by Core; the Adapter never allocates Workspace Refs or silently substitutes `process.cwd()` or the Binding Default Workspace for a conflicting native root. | Discovery and start/resume tests cover canonical aliases, missing roots, different Bindings with equal local roots, and immutable Session targets. |
| `RA-06` | Session execution | The Adapter creates or adopts one native Runtime Thread for a Connect Session, preserves native identity on resume, and keeps native history authoritative for model context. The Session target is independent of every native TUI, desktop application, IDE extension, window, and current client selection. | A runtime that cannot create native threads may be adoption-only, but its profile must say so. It still must support safe prompt submission for an adopted thread to qualify as an interactive Runtime Adapter. |
| `RA-07` | Turn control | Connect serializes turns per Session. The Adapter exposes native cancellation when available and never reports cancellation before the native operation reaches a known terminal boundary. | Missing cancellation is reported as unsupported and must be visible in the capability profile. Unexpected exits fail active work without automatically replaying prompts. |
| `RA-08` | Input reconciliation | Accepted input has an Adapter-owned native receipt or an authoritative reconciliation strategy. An indeterminate outcome is never retried automatically. | The profile states whether reconciliation is complete, partial, or unavailable. Shared conformance verifies authoritative reconciliation whenever it is claimed. |
| `RA-09` | Activity and history | Native live events, recovered history, and fallbacks cross the seam only as Runtime Activity with stable identity, ordering, aliases, and honest completeness/limitation metadata. The Runtime Transcript remains authoritative; the Connect Transcript Projection is a materialized view. | Shared conformance verifies repeated identical content, live/history convergence, replay, out-of-order delivery, current-state replacement, and safe unknown activity. |
| `RA-10` | Runtime Interactions | Native approvals and structured questions, when present, map to Runtime Interactions with first-valid-response, native confirmation, timeout, cancellation, and shutdown settlement. | A runtime without a native interaction capability reports none. An Adapter must not auto-approve merely to satisfy the interface. Connect denies a ClawChat approval left unanswered for 30 minutes, so an Adapter must map a `deny` response to the native decline and continue the Turn. The approval deadline lives in the ClawChat Runtime Interaction router, like the existing question deadline, rather than in the settlement kernel. |
| `RA-11` | Catalogs and options | Models, provider identities, reasoning, agents/presets, Runtime Skills, Runtime Commands, and other options remain runtime-reported and runtime-owned. Persisted unavailable selections fail visibly rather than silently choosing replacements. | Each catalog is independently capability-negotiated; unsupported differs from supported-empty, and cache/refresh scope is Binding plus Workspace or Runtime Thread as declared. |
| `RA-12` | Turn Submission | The Adapter reports its real prompt and attachment capability. Connect submits only the effective intersection with Turn Surface and safety constraints, preserving structured media where supported. | Unsupported media is rejected before acceptance. Any remote preparation must have real prepare/commit/rollback or lease behavior. |
| `RA-13` | Native lifecycle | Archive, restore, and permanent delete are exposed only when the native runtime supplies safe operations with stable semantics. Local mapping changes occur only after native success. | Unsupported operations remain disabled. Shared conformance verifies idempotency and normalizes native failures to `not-found`, `conflict`, or `unsupported`. |
| `RA-14` | Recovery and concurrency | Restart, reconnect, external native-client changes, and process failure reconcile against authoritative native state. Opening, closing, or changing the selection in a native client must not detach, suspend, or reroute a Connect Session; a transport loss is handled as recovery of the same immutable target. An Adapter declares `recoverMissing` only when a persisted mapped Runtime Thread can be safely reattached while current discovery temporarily omits it. Connect never drives one native Runtime Thread concurrently from two Connect Sessions under the same Binding, while concurrency with other Bindings or native clients follows the runtime's declared native policy. | The capability profile states discovery, transcript, receipt, missing-thread recovery, and native concurrency limitations. Recovery tests cover stale mappings, external changes, native-client selection changes, interrupted turns, process shutdown, and the runtime's observable cross-process behavior. |
| `RA-15` | Release evidence | A capability is released only after passing the shared conformance suite and Adapter-specific tests against every supported platform class and declared native compatibility contract. | The spec, compatibility contract, operator diagnostics, and this document's official capability matrix are updated in the same release change. Deferred or unverified features remain explicitly listed. |

### Capability profile template

Every new Runtime Plugin spec must maintain this table while it is designed, implemented, and qualified:

| Requirement | Support | Native mechanism | Known limitations | Evidence |
| --- | --- | --- | --- | --- |
| `RA-01` … `RA-15` | `supported`, `partial`, `unsupported`, or `not-applicable` | Private Adapter implementation mechanism | User-visible or recovery limitation | Conformance, integration test, prototype, or compatibility result |

`partial` is not release shorthand for an unspecified implementation. Its limitation and safe fallback must be explicit,
and the Runtime Adapter Interface must be able to report that limitation without leaking native protocol types.

### Required surface checklist

Every capability profile must also enumerate these independently negotiated surfaces. This list is maintained here so a
future Agent Runtime is checked against the same product contract rather than inheriting whichever subset an earlier
Adapter happened to implement.

| Surface | Required declaration |
| --- | --- |
| Native thread topology | create, persisted resume/adoption, top-level discovery, child/subagent lineage, stable identity |
| Ownership and recovery | native concurrency policy, any owner/busy signal the runtime supplies, restart, reconnect, unknown input outcome |
| Input lifecycle | queue/follow-up, steer, edit/remove queued input, admission identity, durability barrier, terminal settlement |
| Turn control | cancel support, native terminal reason, pending-inbox behavior, unexpected-exit behavior |
| Activity | live events, cold history, stable ordering/identity, live/history convergence, completeness |
| Runtime Interactions | approvals, structured questions, response confirmation, timeout/cancel/shutdown settlement, restart behavior |
| Catalogs | providers, models, reasoning, agents/presets, permission presets, Skills, Commands, cache scope, invalidation |
| Turn Submission | text and every media kind separately, model-dependent constraints, prepare/commit/rollback behavior |
| Output delivery | text, images, local produced-file presentation, portable files/artifacts, download authority, cleanup and retry behavior |
| Native lifecycle | rename/fork when modeled, archive, restore, permanent delete, idempotency and normalized failures |
| Compatibility | executable resolution, Adapter protocol, capability handshake, and Profile/composition diagnostics; native version checks only when that capability declares a version contract |

Each row is `supported`, `partial`, `unsupported`, or `not-applicable`; `supported-empty` is distinct from
`unsupported`. A capability handshake reports actual selected-composition support, while the release profile records the
maximum tested support. No Bridge may turn an absent row into supported by adding an unrelated native feature service.

### Thread discovery result contract

The next Runtime Adapter Interface revision replaces authoritative arrays with one coherent discovery result:

```ts
type RuntimeThreadDiscoveryStatus = "complete" | "partial" | "unavailable";
type RuntimeThreadUnavailableReason =
  | "workspace-missing"
  | "workspace-unusable"
  | "runtime-incompatible"
  | "native-state-corrupt"
  | "external-ownership-unverifiable"
  | "externally-busy"
  | "already-adopted"
  | "archived";

interface RuntimeThreadCandidate extends RuntimeThreadSummary {
  adoption:
    | { status: "available" }
    | { status: "unavailable"; reason: RuntimeThreadUnavailableReason; detail?: string };
}

interface RuntimeThreadDiscoverySnapshot {
  status: RuntimeThreadDiscoveryStatus;
  threads: readonly RuntimeThreadCandidate[];
  limitations: readonly string[];
}
```

`discoverAllThreads` and `discoverArchivedThreads` must return this snapshot shape in the migration; per-Workspace
discovery is a projection of the same observation, not another source of truth. Existing official Adapters and the Plugin
SDK migrate in the same change. Core preserves previously known entries for `partial`/`unavailable`, displays every
returned candidate, and calls readiness verification again at adoption time.

### Current standard-enforcement gaps

- The shared conformance suite covers discovery snapshots, capability truthfulness, Activity identity and convergence,
  lifecycle normalization/idempotency, exactly-once close, pending-operation settlement, and claimed input reconciliation.
  It must continue expanding explicit Turn Submission, Runtime Interaction, external-change, and compatibility cases.
- Codex, OpenCode, and WorkBuddy pass the current shared suite, but their specifications do not yet contain complete
  `RA-01` through `RA-15` profiles. Completing that retrospective audit remains required; native limitations found by
  the audit remain visible rather than being normalized away.

## Official capabilities

| Plugin capability | Family | Process interface | Session options | Discover/resume | Cancel | Delete | Archive/restore | Standard profile |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `clawling.runtime.codex/codex` | Codex | `codex app-server` | sandbox, model, reasoning | yes | yes | yes | yes | retrospective audit required |
| `clawling.runtime.opencode/opencode` | OpenCode | `opencode serve` | agent, provider-qualified model, variant | yes | yes | yes | disabled | retrospective audit required |
| `clawling.runtime.workbuddy/workbuddy-ai` | WorkBuddy | ACP / CodeBuddy stdio | capability-owned | yes | yes | no | no | retrospective audit required |
| `clawling.runtime.workbuddy/workbuddy-cn` | WorkBuddy | ACP / CodeBuddy stdio | capability-owned | yes | yes | no | no | retrospective audit required |
| `clawling.runtime.deepseek-harness/deepseek-harness` | DeepSeek Harness | one native `dsh` or package-launched `@deepseek-ai/dsh` process plus paired inherited-pipe Bridge per Binding | model/reasoning, Agent Preset, Permission Preset, Commands, Skills | yes | yes | no | archive only when the Profile supplies Workspace Registry | [complete profile](../.scratch/deepseek-harness-integration/spec.md#runtime-adapter-capability-profile) |

Runtime executable compatibility is declared by each official Plugin Bundle. DeepSeek Harness deliberately applies no
DSH version or internal component-graph allowlist: successful native boot, the paired Bridge protocol, and independently
reported native capabilities define its active surface. Its Binding Runtime and independent Web Provider prefer an explicit
or installed `dsh` and otherwise execute `@deepseek-ai/dsh` through the first available supported package launcher:
`bunx`, then `npx`, then `pnpm dlx`. The Web Provider appends only the official `web` arguments. The selected launcher
owns package resolution and its user cache. Connect does not automatically install or upgrade any other runtime executable.

## Deferred native capability verification

Keep these items separate from the official capability matrix until each has a stable native API and behavioral
coverage:

- OpenCode archive and restore.
- OpenCode native Session rename.
- OpenCode provider authentication and subscription inspection (expected to remain runtime-owned).
- OpenCode plugin and MCP management (expected to remain runtime-owned).
- OpenCode assistant-generated outbound media beyond Connect's existing safe image rules.
- Runtime-specific compaction controls and context metrics.
- Attaching to an already-running runtime Server or TUI (currently intentionally unsupported).
