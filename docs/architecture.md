# ClawChat Connect Architecture

## System boundary

ClawChat Connect is a Core service and trusted Plugin host, not a unified Web product:

```text
ClawChat
  │ Protocol v2
  ▼
Connect Core
  ├─ Installation Owner / Agent Bindings / credentials
  ├─ Workspace Catalogs / Connect Sessions / Runtime dispatch
  ├─ Plugin install, lock, Activation Generation, Durable State
  ├─ CLI administration and recovery
  └─ Managed Web App selection and opaque upstream leasing
       │
       ├─ Runtime Plugin native Managed Web App
       ├─ compatible Managed Web App Plugin
       └─ no App (valid)
            │ optional opaque lease
            ▼
       Liveware Web App Exposure
```

Core owns no mandatory browser application, Shared Client Gateway, hidden fallback endpoint, Web authentication scheme, or installation-wide Client Extension graph.

## Independent products and health domains

Four domains must remain independent:

1. **Core and Binding health**: service lifecycle, ClawChat connection, credentials, persistence, command routing.
2. **Runtime health**: the exact Runtime Plugin capability, its Binding-scoped process/protocol, and native dependency.
3. **Managed Web App health**: a Provider-owned Web server, browser protocol/assets, authentication, Sessions, Interactions, and reconnect behavior.
4. **Publication health**: a Binding-owned Liveware App, tunnel, registration, and retirement lifecycle.

Failure in one domain does not rewrite another domain. App failure does not stop Runtime turns or cause App reselection. Runtime failure does not stop an independently keyed App. Publication failure changes neither the App selection nor Runtime. A no-App Binding is healthy when its other domains are healthy.

Products do not promise Session continuity. Connect Sessions and Runtime Threads support the ClawChat path. DSH Web, OpenCode Web, and the optional Connect Client each retain their own Session and Interaction state. Sharing a Workspace path is not transfer of conversation, tool state, authentication, or reconnect state.

## Core domain model

```text
Installation Owner
  └─ Agent Binding
      ├─ exact Runtime Ref: pluginId + capabilityId
      ├─ Binding credentials
      ├─ Binding-scoped Workspace Catalog
      ├─ Connect Sessions → private Runtime Thread IDs
      └─ optional Binding Liveware Publication

Installed Plugin
  └─ selected version + validated configuration + Activation Generation
      ├─ Runtime capability
      ├─ Managed Web App capability
      ├─ Exposure capability
      └─ App-scoped Client Extension capability
```

An Agent Binding never selects a Runtime by family alone. The exact Plugin and capability own configuration validation and Provider construction. A Connect Session remains fixed to one Binding, exact Runtime capability, and Workspace. Runtime family is presentation metadata, not provider identity.

## Managed Web App selection

For an exact Runtime capability, Core computes one stable selection:

1. choose a same-Plugin Managed Web App whose `nativeRuntimeCapabilityIds` contains the Runtime capability ID;
2. otherwise choose an installed Managed Web App whose `compatibleRuntimes` contains the exact Runtime `pluginId` and `capabilityId`;
3. otherwise select no App.

A native contribution always wins over a compatibility contribution. Selection changes only when the installed/active Plugin graph or validated configuration changes. Readiness and transient health never affect selection, so Core cannot silently switch products while a user is working.

Official native Providers:

- the DeepSeek Harness Runtime Bundle contributes a DSH Web Provider that owns a separate official `dsh web` product, using the configured or installed `dsh` when available and otherwise launching `@deepseek-ai/dsh web` through the first available supported package launcher (`bunx`, `npx`, or `pnpm dlx`);
- the OpenCode Runtime Bundle contributes an OpenCode Web Provider that owns a separate `opencode web` process.

Those Web processes are independent of the Binding Runtime processes used for ClawChat execution. They retain upstream authentication, Sessions, Interactions, and presentation.

The optional `clawling.web.connect-client/connect-client` capability is a complete compatible Managed Web App for exact Codex and WorkBuddy capabilities. It is neither a Core module nor implicitly installed with those Runtimes.

## Managed Web App Provider contract

A Provider is activated as trusted Plugin code through the public Plugin SDK. For an eligible Runtime scope it must:

- derive a stable **Instance key** from Provider-owned native scope, not from a transient port and not necessarily from a Binding;
- start or adopt the complete App product independently of the Binding Runtime;
- return one exact `http://127.0.0.1:<port>` upstream;
- expose readiness and health without translating App semantics into Runtime health;
- reference-count leases and stop the Instance after the final release;
- fence all acquisition and release work to the committed Plugin Activation Generation.

Several Bindings may lease one Provider Instance when they resolve to the same native scope. Every Binding still receives an independent Publication. Core validates loopback origin syntax and lease generation but treats the upstream as opaque: it does not proxy product APIs, inject credentials, reinterpret cookies, or forward a ClawChat principal.

An unavailable Provider returns failure through App health. Core does not insert a compatibility proxy or fallback page. Liveware owns unavailable-upstream presentation for a Publication whose selected App cannot currently serve.

## Liveware as Web App Exposure

The official Liveware Plugin contributes an `exposure` capability. It consumes the Binding's selected App lease and manages one independent private Publication per eligible activated Binding:

```text
Binding
  └─ Publication correlation key
      ├─ private ClawChat App
      ├─ Liveware tunnel → opaque loopback upstream
      ├─ ClawChat Liveware registration
      └─ durable reconcile / retirement state
```

Creation recovery uses authoritative correlation before retry. Retirement intent is durable and blocks reprovisioning until cleanup completes. Removing a Binding retires only that Binding's Publication. Owner Reset retires managed resources before credentials are removed.

Liveware never chooses an App and never publishes a user-supplied endpoint. With no selected App, there is no Publication. Removing Liveware leaves Core, Runtime operation, and any locally managed App lifecycle valid.

## Plugin activation and generation fencing

One Cordis root owns mandatory Core modules and installed Plugin lifecycles. Plugin replacement has one prepare/commit/start boundary:

1. validate the Bundle, manifest, exact configuration schemas, dependency graph, and copied Durable State migration;
2. commit selected version, configuration, Durable State revision, lock entry, and next Activation Generation atomically;
3. revoke old-generation dispatch before disposal;
4. allow only the committed generation to register Providers, acquire App Instances, mutate Durable State, or publish remote resources.

A precommit failure preserves the old generation. A postcommit start failure leaves the committed generation visible as erroneous rather than restoring revoked authority. Instance leases, host facades, and App-scoped extension mutations carry the generation; stale generations are rejected.

Plugin installation is trusted in-process code execution, not an OS sandbox. Catalog provenance assists discovery but is not authorization.

## Runtime seam

```text
Agent Binding
  → exact pluginId/capabilityId
  → RuntimeAdapterRegistry
  → one Binding-scoped Runtime Adapter
  → private native Runtime protocol
```

Core surfaces only runtime-neutral prompts, Activities, catalogs, lifecycle claims, and Interactions. Codex app-server, OpenCode server, WorkBuddy desktop, and DSH bridge details remain private to their official Plugin contributions. Native login, providers, plugins, MCP configuration, models, tools, approval behavior, and Thread storage remain upstream-owned.

Runtime lifecycle and Web App lifecycle deliberately do not share a process merely to reduce resource count. Reusing the Binding Runtime for a Web product would couple independent health, authentication, and Session state machines.

## Connect Sessions and Workspaces

Every Binding owns a Workspace Catalog. Workspace Refs are Core-owned and Binding-scoped even when two entries resolve to the same filesystem path. Runtime Plugins may report discovery snapshots but cannot allocate Refs or merge catalogs.

A Session Intent becomes a Connect Session on the first ordinary ClawChat turn. Each Session keeps one stable Ref, exact Binding, exact Runtime capability, Workspace, and optional private Runtime Thread ID. Runtime Thread discovery and resume occur behind the Runtime Adapter seam.

Continuing from another product creates that product's own Session. Core never claims that opening DSH Web, OpenCode Web, or Connect Client resumes a Connect Session. Cross-product continuation, if a product independently offers it, is governed only by that product's native contract.

## Optional Connect Client Plugin

The optional Connect Client is packaged as one complete official Plugin Bundle:

```text
clawling.web.connect-client
  ├─ Managed Web App server entry
  ├─ complete browser asset graph
  ├─ canonical client-assets.json integrity manifest
  ├─ Connect-owned Web API and authentication boundary
  └─ App-scoped Client Extension graph
```

Core/npm/release roots do not contain `dist/client` or `clawchat-connect-client`. The Bundle can be present or omitted without invalidating Core packaging or installation. Runtime setup never selects it as a side effect.

Client Extensions declare the exact target `managedWebApp.pluginId` and `managedWebApp.capabilityId`. Their graph, styles, services, and epoch belong to that selected App only. No installation-wide Client Kernel or extension graph exists. An extension for one App cannot affect a native DSH or OpenCode App.

## Headless administration and recovery

CLI administration is mandatory Core behavior and remains available with no Managed Web App:

```text
service status/logs/restart
plugin list/setup/install/enable/disable/remove
agent list/add/remove
workspace list/add/remove
doctor
```

When the service is stopped, CLI Plugin setup can use release-bundled official Bundles. This path repairs broken App or Exposure Plugins without starting a browser surface. Core must never create a secret fallback Web endpoint for recovery.

## Security model

### Integrity and packaging

- Release archives are checked against SHA-256 `checksums.txt` before extraction.
- Official Plugin entry artifacts use release-pinned SHA-256 SRI.
- Auxiliary binaries use release-pinned SRI.
- Complete browser graphs carry a canonical integrity manifest; the manifest itself is release-pinned and every listed asset is verified.
- DSH/OpenCode native contributions and optional Connect Client assets travel inside their owning Bundles.
- Root Core package/archive payloads contain no unconditional browser tree.

### Network and identity

- Managed Web App upstreams are exact loopback HTTP origins; arbitrary URLs, forwarded-host authority, and unmanaged LAN upstreams are rejected.
- Core grants an opaque lease, not raw Binding credentials or a forwarded Liveware principal.
- Managed Web Apps own authentication, cookies, CSRF policy, Web Sessions, and Interactions.
- A private owner-only Liveware App restricts publication access but does not merge App and ClawChat authentication models.
- Activation Generation fencing prevents replaced Plugin code from renewing leases, changing extension graphs, or publishing resources.

### Operational isolation

- App, Runtime, Core, and Publication diagnostics are reported separately.
- Failure never authorizes native-to-compatible failover.
- Removing an App does not remove Runtime state or Connect Sessions.
- Removing a Publication does not terminate an independently leased App until its final lease is released.
- Managed-resource retirement precedes Binding credential removal or Owner Reset.

## Release assembly

Bun builds Core entrypoints under `dist/src`. `scripts/build-official-plugins.ts` discovers official descriptors and builds target-specific self-contained Bundles under `dist/official-plugins`. Directory assets are copied recursively, a canonical path-to-SRI manifest is generated, and release registry checks pin that manifest plus every described asset.

Archive scripts require the platform's Core Runtime/Exposure Bundles, copy `official-plugins` as a unit, and treat `clawling.web.connect-client` as optional. Installers verify the archive checksum, replace official Bundles transactionally, and clean obsolete root Client/Liveware payloads. They copy Bundles but do not activate the Client with Runtime setup.

Generated `dist/` and release artifacts remain outside Git history. Hard-coded official SRI values are updated from a clean all-target build integrity report before release qualification.
