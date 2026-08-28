# Install ClawChat Connect

This runbook is for a human operator or coding Agent installing, updating, or recovering ClawChat Connect.

## Non-negotiable boundaries

- Core, Runtime Plugins, Managed Web Apps, and Liveware Web App Exposure are independent products.
- Never install or reconfigure a coding Runtime on the user's behalf. Reuse its existing native authentication and configuration.
- Never install `clawling.web.connect-client` merely because a Runtime Plugin is installed. It is optional and must be selected explicitly.
- Never claim continuity between a ClawChat Connect Session and a DSH Web, OpenCode Web, or Connect Client Session.
- Never expose an unmanaged URL. Managed Web App Providers return exact loopback HTTP upstreams; Liveware receives only a generation-fenced lease.
- Never print, log, save, or commit an Agent invite code.
- Preserve an existing Connect configuration unless the operator explicitly requests Owner Reset.

## 1. Inspect the machine

```bash
uname -s
uname -m
command -v clawchat-connect || true
clawchat-connect service status || true
clawchat-connect doctor || true
```

Current beta archives support `darwin-arm64`. If Connect is already configured, inspect rather than replace it:

```bash
clawchat-connect plugin list
clawchat-connect agent list
```

A CLI-only installation is valid. Missing Managed Web App or Liveware publication is not a Core or Runtime failure.

## 2. Install or update Core

Install the current beta channel:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
```

Pin a version when required:

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh -s -- v0.1.0-beta.9
```

The installer resolves `release-channel/latest-beta.txt`, downloads the archive and `checksums.txt`, verifies SHA-256 before extraction, and then stages a transactional replacement. It installs:

- `clawchat-connect` Core;
- release-bundled official Plugin Bundles;
- managed Agent skills;
- changelog and license notices.

It removes obsolete root `liveware` and `clawchat-connect-client` payloads. Browser assets are valid only inside a complete integrity-covered Managed Web App Plugin Bundle. A release may include or omit the optional Client Plugin.

For a source checkout:

```bash
bun install
bun run build
bun link
```

The npm payload contains `dist/src` and `dist/official-plugins`, not an unconditional `dist/client` tree.

## 3. Initialize without an App

```bash
clawchat-connect init
```

`init` creates a Plugin-free configuration. It does not select a Runtime or install a Client.

Install only the requested Runtime Plugin, then bind its exact capability:

DeepSeek Harness does not require a global DSH installation. Its official Web Provider and Binding Runtime use an explicitly configured or installed `dsh` when available and otherwise launch `@deepseek-ai/dsh` through the first available supported package launcher: `bunx`, then `npx`, then `pnpm dlx`. The selected launcher may populate its user cache on first use.

```bash
# Codex
clawchat-connect plugin setup --non-interactive --select clawling.runtime.codex
clawchat-connect agent add work --plugin clawling.runtime.codex --capability codex

# OpenCode
clawchat-connect plugin setup --non-interactive --select clawling.runtime.opencode
clawchat-connect agent add work --plugin clawling.runtime.opencode --capability opencode

# DeepSeek Harness
clawchat-connect plugin setup --non-interactive --select clawling.runtime.deepseek-harness
clawchat-connect agent add work --plugin clawling.runtime.deepseek-harness --capability deepseek-harness
```

Runtime-specific configuration must pass the selected capability schema. Do not copy configuration between capabilities by family name.

With the service stopped, the CLI reads the release-bundled official registry and can install an explicitly selected local Bundle. This is the supported headless recovery path; do not start a hidden Client endpoint.

## 4. Activate and start

Ask for an invite code only when activation is needed, pass it directly to the command, and discard it immediately:

```bash
clawchat-connect activate work INVITE_CODE
clawchat-connect service install
clawchat-connect service status
clawchat-connect doctor
```

One installation has one Installation Owner. Every later Binding must resolve to that Owner. Each Binding retains independent credentials, Workspace Catalog, Connect Sessions, Runtime instance, and Liveware Publication state.

## 5. Optional Managed Web App

Selection is native-first, then exact compatible:

- DeepSeek Harness selects its Plugin-owned `dsh web` App.
- OpenCode selects its Plugin-owned `opencode web` App.
- Codex and WorkBuddy have no native App in their official Runtime Plugins; they may select the optional Connect Client only when it is explicitly installed and names their exact Runtime capability.
- Any other Binding may legitimately have no App.

Temporary failure never changes the selected App.

Install the optional compatible Client separately:

```bash
clawchat-connect plugin setup --non-interactive --select clawling.web.connect-client
```

That Bundle is one complete product: server entry, browser protocol and assets, authentication behavior, Connect-owned Web Sessions and Interactions, and App-scoped Client Extension graph. It is not Core UI and does not inherit a Runtime's native Sessions.

## 6. Optional Liveware Web App Exposure

```bash
clawchat-connect plugin setup --non-interactive --select clawling.exposure.liveware
```

Liveware publishes the already selected App; it does not choose a different App and does not create one when no App is eligible. Each activated Binding owns an independent private ClawChat App, tunnel, registration, and durable retirement lifecycle.

The Managed Web App Provider owns its native-scope Instance key. Several Bindings may lease one Instance. Core validates the exact loopback upstream and Activation Generation before granting a lease; releasing the final lease stops the Instance. Stale generations are fenced from publication. No Provider receives Binding credentials or forwarded ClawChat identity.

## 7. Verify separate health domains

```bash
clawchat-connect service status
clawchat-connect doctor
clawchat-connect plugin list
clawchat-connect agent list
clawchat-connect workspace list work
```

Report these independently:

1. Core service and ClawChat Binding;
2. exact Runtime capability and native dependency;
3. selected Managed Web App and Instance;
4. Binding Liveware Publication.

Do not report the installation as failed merely because it is intentionally headless. Do not report Runtime health from App health or vice versa. Do not promise that opening an App resumes the active ClawChat Session.

## 8. Recovery

If a Web App is broken or absent, keep using CLI administration:

```bash
clawchat-connect plugin list
clawchat-connect service status
clawchat-connect doctor
```

Use explicit Plugin operations to install, enable, disable, update, or remove the affected product. App failure must not stop Runtime turns; Runtime failure must not trigger App reselection; Publication failure must not change either selection or Runtime state.

`plugin update` preserves the installed source identity. If a release-bundled official Plugin was originally locked to a local path that no longer exists, replace it from the installed official registry so the release-pinned Core grant and transactional retirement lifecycle remain intact:

```bash
clawchat-connect plugin setup --non-interactive --select clawling.runtime.codex,clawling.exposure.liveware
```

For a deliberate non-official source cutover, use the explicit atomic replacement command while the Service is running:

```bash
clawchat-connect plugin replace PLUGIN_ID SOURCE
```

Before changing ownership or deleting credentials, retire managed Liveware resources through the supported Core lifecycle. Do not manually delete remote Apps or tunnels and then assume local retirement state is complete.

## 9. Security review

Before enabling an App or exposure, confirm:

- the Plugin Bundle is trusted in-process code and came from the intended source;
- official entry and auxiliary asset SRI checks pass;
- the Provider returns an exact `http://127.0.0.1:<port>` upstream;
- no user-controlled or LAN upstream is accepted;
- Client Extensions target the exact selected Managed Web App, not a global Client;
- native App authentication, cookies, Sessions, and Interactions remain owned by that App;
- the operator understands that private Liveware owner access does not merge product security models.

Finish by stating exactly which Runtime Plugins, Managed Web App Plugins, and Exposure Plugins were installed, whether the installation is intentionally headless, and the result of each independent health domain.
