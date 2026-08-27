<div align="center">
  <p><strong>English</strong> | <a href="./README_zh.md">中文</a></p>
  <h1>ClawChat Connect</h1>
  <p><strong>Run local coding-agent Runtimes from ClawChat, with independently managed Web Apps when you choose them.</strong></p>
</div>

ClawChat Connect is a local Core service and Plugin host. Core owns Agent Bindings, ClawChat transport, Workspace and Connect Session records, Runtime dispatch, Plugin lifecycle, and command-line administration. Runtime Plugins own their native runtime protocols. Managed Web App Plugins own complete Web products. The optional Liveware Plugin exposes a selected App to its Binding; Core does not ship or serve an unconditional browser application.

## Product model

| Product | Owner | Boundary |
| --- | --- | --- |
| Connect Core | `clawchat-connect` | Agent Bindings, ClawChat transport, Workspace/Session records, Plugin authority, CLI recovery. |
| Runtime Plugin | The exact installed Plugin capability | Runtime process/protocol, native login, models, tools, approvals, and native Thread storage. |
| Managed Web App | Its Provider Plugin | Web server, browser assets/protocol, authentication, Web Sessions, Interactions, reconnect behavior, and presentation. |
| Web App Exposure | Official `clawling.exposure.liveware` Plugin | One private Binding publication of an opaque leased loopback App upstream. |

These are independent products. A Runtime can remain healthy while its selected App is unavailable, and an App can be healthy while a Binding Runtime is stopped. Connect never represents those health domains as one status.

There is no cross-product Session continuity promise. A ClawChat Connect Session, `dsh web` Session, `opencode web` Session, and optional Connect Client Session may refer to the same repository and still have independent authentication, history, Interaction state, and reconnect behavior. Connect does not copy conversation or tool context between them.

## Managed Web App selection

Selection is deterministic and exact:

1. If the Binding's exact Runtime capability declares a native Managed Web App, select it.
2. Otherwise, select an installed compatible Managed Web App that explicitly names that exact `pluginId` and `capabilityId`.
3. Otherwise, the Binding has no App.

Temporary unavailability never changes the selection and never triggers a compatibility proxy, fallback page, or hidden Client endpoint.

Official mappings:

| Runtime capability | Selected App |
| --- | --- |
| `clawling.runtime.deepseek-harness/deepseek-harness` | Native DSH Web (`dsh web`). |
| `clawling.runtime.opencode/opencode` | Native OpenCode Web (`opencode web`). |
| Codex and both WorkBuddy capabilities | Optional `clawling.web.connect-client/connect-client`, only when that complete Plugin is explicitly installed. |

A CLI-only installation is valid. Runtime setup and Agent Binding activation never install the optional Connect Client Plugin implicitly. Liveware publishes nothing for a Binding with no selected App.

## Requirements

Current beta archives support macOS on Apple silicon. You need a ClawChat account, an Agent invite code, and at least one supported runtime already installed and authenticated. Connect does not install, upgrade, authenticate, or reconfigure Codex, OpenCode, WorkBuddy, or DeepSeek Harness.

## Quick start

### Install Core

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

The installer verifies the release archive against `checksums.txt`, installs Core, official Plugin Bundles, skills, and notices, and removes obsolete root `liveware` and `clawchat-connect-client` payloads. An archive may include or omit the optional Connect Client Plugin and remains valid. Browser assets, when present, exist only inside that integrity-covered Plugin Bundle.

The current beta pointer is `release-channel/latest-beta.txt`. Pin a release with:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh -s -- v0.1.0-beta.8
```

### Initialize and install a Runtime Plugin

```bash
clawchat-connect init

# choose one or more exact Runtime Plugins
clawchat-connect plugin setup --non-interactive --select clawling.runtime.codex
clawchat-connect agent add work --plugin clawling.runtime.codex --capability codex
clawchat-connect activate work YOUR_INVITE_CODE

clawchat-connect service install
clawchat-connect service status
clawchat-connect doctor
```

Equivalent Runtime selections include `clawling.runtime.opencode/opencode`, `clawling.runtime.deepseek-harness/deepseek-harness`, and the supported WorkBuddy capabilities. Runtime configuration belongs to the exact capability's schema:

```bash
clawchat-connect agent add work \
  --plugin clawling.runtime.opencode \
  --capability opencode \
  --runtime-config-json '{"serverUrl":"http://127.0.0.1:4096"}'
```

`plugin setup` works through the running Plugin Manager when available. With the service stopped, the CLI can install a selected release-bundled Plugin directly. This headless path is the recovery and administration boundary; no Web App is required.

### Optional compatible Connect Client

Install it in a separate, explicit operation only if Codex or WorkBuddy browser administration is wanted:

```bash
clawchat-connect plugin setup --non-interactive --select clawling.web.connect-client
```

The Connect Client Bundle contains its complete server entry, complete browser graph, and a canonical integrity manifest covering every auxiliary browser asset. It is removable independently of Core and Runtime Plugins. Client Extensions target an exact Managed Web App with `managedWebApp.pluginId` plus `managedWebApp.capabilityId`; they are App-scoped, never installation-global.

### Optional private Liveware exposure

```bash
clawchat-connect plugin setup --non-interactive --select clawling.exposure.liveware
```

Liveware is Web App Exposure, not a Client and not a Runtime. For each eligible activated Binding it publishes the already selected Managed Web App. Each Binding owns an independent private ClawChat App, tunnel, registration, and retirement state.

A Provider returns only an exact loopback HTTP upstream. Core validates it, associates it with the committed Plugin Activation Generation, and grants a lease to Liveware. Provider-owned native scope determines the Managed Web App Instance key, so several Bindings may lease one Instance. Releasing the final lease stops it. A stale generation cannot acquire, renew, or publish an Instance. The selected Provider never receives ClawChat credentials or a forwarded Liveware principal.

## Workspaces and Sessions

```bash
clawchat-connect workspace add work /absolute/path/to/project
clawchat-connect workspace list work
```

Core Sessions remain fixed to one Agent Binding, exact Runtime capability, and Workspace. Runtime-native Thread IDs remain private to the Runtime Adapter. In ClawChat, use `/new`, `/workspace`, `/sessions`, `/switch`, `/model`, `/mode`, `/cancel`, and `/status` as supported by the exact Runtime.

Opening a native or compatible Web App does not resume the ClawChat Connect Session. Continue work in that product according to its own Session and authentication model.

## Operations and recovery

```bash
clawchat-connect service status
clawchat-connect doctor
clawchat-connect plugin list
clawchat-connect agent list
clawchat-connect workspace list work
```

Operate in this order:

1. Check Core service and ClawChat Binding health.
2. Check the exact Runtime capability and its native dependency.
3. Check Managed Web App selection and Instance health.
4. Check the Binding's Liveware Publication separately.

An App failure does not stop Runtime turns. A Runtime failure does not authorize App reselection. A Publication failure does not change either one. If the Web App is unavailable, use the CLI to inspect, install, enable, disable, or replace Plugins and to repair Bindings; Core exposes no secret fallback Web administration endpoint.

## Security boundary

- Plugin installation is trusted in-process code execution. Install only reviewed Bundles and verify provenance.
- Official release archives are SHA-256 checked before extraction. Official Plugin entry artifacts and auxiliary assets are release-pinned with SHA-256 SRI.
- Managed Web App upstreams must be exact loopback HTTP origins. User-supplied endpoints and LAN/native upstreams are rejected.
- Liveware receives only an opaque upstream lease. Core keeps Plugin authority, Activation Generation fencing, Binding credentials, and managed-resource retirement.
- Managed Web Apps own their authentication. Core does not inject ClawChat identity, cookies, credentials, or Session state into them.
- Private Liveware publication remains owner-only, but the exposed App retains its own security model.
- CLI administration remains available with no App installed and is the recovery surface for broken Web products.

See [Installation guide](./install.md), [Architecture](./docs/architecture.md), [Runtime Adapter contract](./docs/runtime-adapters.md), and [Plugin authoring](./docs/plugin-authoring.md).

## Plugin author contract

A complete Managed Web App capability declares:

- type `managed-web-app` and the current capability interface version;
- either `nativeRuntimeCapabilityIds` for same-Plugin native ownership or exact `compatibleRuntimes` references;
- an App-owned Provider that produces a stable native-scope Instance key;
- an exact loopback upstream plus readiness, health, release, and final-lease shutdown behavior;
- complete server and browser assets inside its Bundle, with all auxiliary assets integrity-covered;
- App-scoped Client Extensions, if supported, fenced by the selected App graph and Activation Generation.

Do not proxy another product, reuse a Binding Runtime merely to reduce process count, claim Session continuity, accept an unmanaged endpoint, or expose a partial browser payload.

## Development and release

```bash
bun install
bun run dev
bun run check
bun run build
```

`bun run build` emits Core under `dist/src` and official Bundles under `dist/official-plugins`; it does not publish `dist/client` as a root package payload. Official DSH and OpenCode Bundles include their native Managed Web App contributions. The optional Connect Client Bundle includes its complete browser graph. Release archives copy the Bundle directory as-is, so a qualified archive with or without the optional Client remains valid.

Version tags matching `v*-beta.*` run [the beta release workflow](.github/workflows/release-beta.yml). The workflow publishes the archive, installer support files, checksums, release notes, and the `release-channel/latest-beta.txt` pointer. Local installed-product qualification is optional and does not block tagging.

## License

[MIT](./LICENSE)
