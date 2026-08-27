<div align="center">
  <p><a href="./README.md">English</a> | <strong>中文</strong></p>
  <h1>ClawChat Connect</h1>
  <p><strong>从 ClawChat 使用本机编码 Agent Runtime，并按需使用彼此独立的托管 Web App。</strong></p>
</div>

ClawChat Connect 是本机 Core 服务和 Plugin Host。Core 负责 Agent Binding、ClawChat 传输、Workspace 与 Connect Session 记录、Runtime 分派、Plugin 生命周期和命令行管理。Runtime Plugin 负责各自的原生 Runtime 协议；Managed Web App Plugin 负责完整的 Web 产品；可选 Liveware Plugin 把已选 App 暴露给对应 Binding。Core 不再无条件携带或提供浏览器应用。

## 产品模型

| 产品 | 所有者 | 边界 |
| --- | --- | --- |
| Connect Core | `clawchat-connect` | Agent Binding、ClawChat 传输、Workspace/Session 记录、Plugin 权限和 CLI 恢复。 |
| Runtime Plugin | 已安装的精确 Plugin capability | Runtime 进程/协议、原生登录、模型、工具、审批与原生 Thread 存储。 |
| Managed Web App | 其 Provider Plugin | Web 服务器、浏览器资产/协议、认证、Web Session、Interaction、重连和界面。 |
| Web App Exposure | 官方 `clawling.exposure.liveware` Plugin | 将不透明的、已租用的回环 App upstream 私密发布给一个 Binding。 |

这些是彼此独立的产品。Runtime 健康时，其已选 App 可能不可用；Binding Runtime 停止时，App 也可能健康。Connect 不会把这些健康域合并成一个状态。

产品之间不承诺 Session 连续性。ClawChat Connect Session、`dsh web` Session、`opencode web` Session 和可选 Connect Client Session 即使指向同一仓库，也拥有独立的认证、历史、Interaction 状态和重连行为。Connect 不会在它们之间复制对话或工具上下文。

## Managed Web App 选择

选择规则是确定且精确的：

1. 若 Binding 的精确 Runtime capability 声明原生 Managed Web App，则选择它。
2. 否则，只能选择已安装且明确列出该精确 `pluginId` 与 `capabilityId` 的兼容 Managed Web App。
3. 否则，该 Binding 没有 App。

暂时不可用不会改变选择，也不会触发兼容代理、回退页面或隐藏的 Client endpoint。

官方映射：

| Runtime capability | 已选 App |
| --- | --- |
| `clawling.runtime.deepseek-harness/deepseek-harness` | 原生 DSH Web（`dsh web`）。 |
| `clawling.runtime.opencode/opencode` | 原生 OpenCode Web（`opencode web`）。 |
| Codex 与两个 WorkBuddy capability | 仅在完整 Plugin 被显式安装后，使用可选 `clawling.web.connect-client/connect-client`。 |

纯 CLI 安装完全有效。安装 Runtime 或激活 Agent Binding 绝不会隐式安装可选 Connect Client Plugin。没有已选 App 的 Binding 不会被 Liveware 发布。

## 要求

当前 beta 归档支持 Apple 芯片 Mac。你需要 ClawChat 账号、Agent 邀请码，以及至少一个已在本机安装并认证的受支持 Runtime。Connect 不会安装、升级、认证或重配置 Codex、OpenCode、WorkBuddy 或 DeepSeek Harness。

## 快速开始

### 安装 Core

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

安装器先用 `checksums.txt` 校验发布归档，再安装 Core、官方 Plugin Bundle、skills 与许可说明，并清理旧的根级 `liveware` 和 `clawchat-connect-client` 载荷。归档可包含或省略可选 Connect Client Plugin，两种情况都有效。浏览器资产若存在，只能位于完整性覆盖的 Plugin Bundle 内。

当前 beta 指针为 `release-channel/latest-beta.txt`。固定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh -s -- v0.1.0-beta.8
```

### 初始化并安装 Runtime Plugin

```bash
clawchat-connect init

clawchat-connect plugin setup --non-interactive --select clawling.runtime.codex
clawchat-connect agent add work --plugin clawling.runtime.codex --capability codex
clawchat-connect activate work YOUR_INVITE_CODE

clawchat-connect service install
clawchat-connect service status
clawchat-connect doctor
```

也可选择 `clawling.runtime.opencode/opencode`、`clawling.runtime.deepseek-harness/deepseek-harness` 和受支持的 WorkBuddy capability。Runtime 配置必须符合精确 capability 的 schema：

```bash
clawchat-connect agent add work \
  --plugin clawling.runtime.opencode \
  --capability opencode \
  --runtime-config-json '{"serverUrl":"http://127.0.0.1:4096"}'
```

服务运行时，`plugin setup` 通过 Plugin Manager 工作；服务停止时，CLI 可直接安装发布归档中显式选择的 Plugin。这个无界面路径是管理与恢复边界，不需要任何 Web App。

### 可选兼容 Connect Client

只有在 Codex 或 WorkBuddy 需要浏览器管理时，才单独显式安装：

```bash
clawchat-connect plugin setup --non-interactive --select clawling.web.connect-client
```

Connect Client Bundle 包含完整服务器入口、完整浏览器资产图，以及覆盖每个辅助浏览器资产的规范完整性清单。它可以独立于 Core 和 Runtime Plugin 删除。Client Extension 必须用 `managedWebApp.pluginId` 与 `managedWebApp.capabilityId` 指向一个精确 Managed Web App；它们是 App 作用域，而不是安装级全局扩展。

### 可选私密 Liveware 暴露

```bash
clawchat-connect plugin setup --non-interactive --select clawling.exposure.liveware
```

Liveware 是 Web App Exposure，不是 Client，也不是 Runtime。它为每个符合条件且已激活的 Binding 发布已经选定的 Managed Web App。每个 Binding 拥有独立的私密 ClawChat App、tunnel、registration 和 retirement 状态。

Provider 只返回精确的 HTTP 回环 upstream。Core 校验它，将其绑定到已提交的 Plugin Activation Generation，再把 lease 交给 Liveware。Provider 所有的原生 scope 决定 Managed Web App Instance key，因此多个 Binding 可以租用同一 Instance；最后一个 lease 释放后 Instance 停止。过期 generation 不能获取、续租或发布 Instance。Provider 不会得到 ClawChat 凭据或转发的 Liveware principal。

## Workspace 与 Session

```bash
clawchat-connect workspace add work /absolute/path/to/project
clawchat-connect workspace list work
```

Core Session 始终固定到一个 Agent Binding、精确 Runtime capability 和 Workspace。Runtime 原生 Thread ID 只属于 Runtime Adapter。在 ClawChat 中，可按精确 Runtime 支持情况使用 `/new`、`/workspace`、`/sessions`、`/switch`、`/model`、`/mode`、`/cancel` 和 `/status`。

打开原生或兼容 Web App 不会续接 ClawChat Connect Session。请按该产品自己的 Session 与认证模型继续工作。

## 运维与恢复

```bash
clawchat-connect service status
clawchat-connect doctor
clawchat-connect plugin list
clawchat-connect agent list
clawchat-connect workspace list work
```

按以下顺序检查：

1. Core 服务与 ClawChat Binding 健康状态；
2. 精确 Runtime capability 及其原生依赖；
3. Managed Web App 选择与 Instance 健康状态；
4. Binding 的 Liveware Publication 状态。

App 故障不会停止 Runtime turn；Runtime 故障不允许重新选择 App；Publication 故障也不会改变前两者。Web App 不可用时，使用 CLI 检查、安装、启用、停用或替换 Plugin，并修复 Binding；Core 不提供秘密的回退 Web 管理 endpoint。

## 安全边界

- 安装 Plugin 等同于信任进程内代码执行；只安装经过审查且来源可信的 Bundle。
- 官方发布归档在解压前进行 SHA-256 校验；官方 Plugin 入口和辅助资产由发布固定的 SHA-256 SRI 覆盖。
- Managed Web App upstream 必须是精确 HTTP 回环 origin；拒绝用户自定义 endpoint、LAN 或原生非回环 upstream。
- Liveware 只得到不透明 upstream lease。Core 保留 Plugin 权限、Activation Generation fencing、Binding 凭据和托管资源 retirement。
- Managed Web App 负责自己的认证。Core 不会向其注入 ClawChat 身份、cookie、凭据或 Session 状态。
- 私密 Liveware Publication 仍只对 Owner 开放，但被暴露 App 保持自己的安全模型。
- 未安装 App 时 CLI 管理仍完整可用，也是 Web 产品故障时的恢复界面。

另见[安装指南](./install.md)、[架构](./docs/architecture.md)、[Runtime Adapter 合约](./docs/runtime-adapters.md)和[Plugin 创作](./docs/plugin-authoring.md)。

## Plugin 作者合约

一个完整 Managed Web App capability 必须声明：

- 类型 `managed-web-app` 和当前 capability interface version；
- 同 Plugin 原生所有权使用 `nativeRuntimeCapabilityIds`，兼容 App 使用精确 `compatibleRuntimes` 引用；
- App 所有的 Provider，产生稳定的原生 scope Instance key；
- 精确回环 upstream，以及 readiness、health、release 和最后 lease 关闭行为；
- Bundle 内完整的服务器和浏览器资产，并对所有辅助资产提供完整性覆盖；
- 若支持 Client Extension，则它们必须限定到已选 App 图，并受 Activation Generation fencing。

不要代理其他产品，不要仅为减少进程数而复用 Binding Runtime，不要声称 Session 连续性，不要接受无人管理的 endpoint，也不要暴露不完整浏览器载荷。

## 开发与发布

```bash
bun install
bun run dev
bun run check
bun run build
```

`bun run build` 将 Core 输出到 `dist/src`，将官方 Bundle 输出到 `dist/official-plugins`；不会把 `dist/client` 发布为根包载荷。官方 DSH 与 OpenCode Bundle 包含各自原生 Managed Web App contribution。可选 Connect Client Bundle 包含完整浏览器资产图。发布归档原样复制 Bundle 目录，所以包含或省略可选 Client 的合格归档都有效。

匹配 `v*-beta.*` 的版本 tag 会运行 [beta 发布 workflow](.github/workflows/release-beta.yml)，发布归档、安装支持文件、checksums、release notes 和 `release-channel/latest-beta.txt` 指针。本机已安装产品的资格检查是可选的，不阻塞 tag。

## 许可

[MIT](./LICENSE)
