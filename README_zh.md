<div align="center">
  <p><a href="./README.md">English</a> | <strong>中文</strong></p>
  <h1>ClawChat Connect</h1>
  <p><strong>把运行在你电脑上的编程 Agent 接入任意 ClawChat 对话。</strong></p>
  <p>
    <a href="https://clawling.com/u/usr_01KPSPM0D3FFERFTYPY0PF8J2J"><img src="./docs/assets/clawchat.svg" alt="ClawChat" width="24" /></a><br />
    作者：<a href="https://clawling.com/u/usr_01KPSPM0D3FFERFTYPY0PF8J2J">在 ClawChat 上联系</a>
  </p>
  <p>
    <a href="https://github.com/XMethues/clawchat-plugin-connect/releases"><img alt="GitHub 版本" src="https://img.shields.io/github/v/release/XMethues/clawchat-plugin-connect?include_prereleases&style=flat-square"></a>
    <a href="./LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-4c8bf5?style=flat-square"></a>
    <img alt="支持 macOS、Linux 和 Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-59636e?style=flat-square">
    <img alt="运行时：Codex、OpenCode 与 WorkBuddy" src="https://img.shields.io/badge/runtimes-Codex%20%7C%20OpenCode%20%7C%20WorkBuddy-f97316?style=flat-square">
  </p>
  <p>
    <a href="#功能">功能</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#在代码仓库中工作">项目</a> ·
    <a href="#connect-client">Connect Client</a> ·
    <a href="#配置">配置</a> ·
    <a href="#开发">开发</a>
  </p>
</div>

---

ClawChat Connect 是连接 ClawChat 与本地编程 Agent 运行时的桥梁。Agent、凭据、项目文件和运行时历史都保留在你的电脑上；你可以从 ClawChat 或浏览器中的 Connect Client 继续同一个持久 Session。

## 功能

| 领域 | Connect 提供的能力 |
| --- | --- |
| Runtime Adapter | 连接用户自行安装的 Codex CLI 或 OpenCode，不接管运行时登录、模型供应商、插件和 MCP 配置。 |
| 持久工作 | 通过稳定的 Connect Session 恢复原生 Runtime Thread，并复用本地 Project。 |
| 跨入口对话 | ClawChat 与 Connect Client 的消息进入同一个 Session 队列；不同 Session 可并发运行。 |
| 运行时控制 | 动态发现模型与选项，将审批和问题送回发起任务的入口，并支持取消任务。 |
| Skill 发现 | 在 Connect Client 的 slash picker 中展示运行时支持的 Skill，并把显式选择保留在本次任务中。 |
| 丰富输入输出 | 接收 ClawChat 图片、音频、文件和视频引用，并按安全规则返回本地图片结果。 |
| 多 Agent Binding | 每个 Binding 独立保存凭据、Session、Runtime 实例、默认设置、输出可见性和 Liveware 访问。 |
| 本地优先访问 | 默认使用本机 Client，也可显式开放可信局域网或使用 Binding-scoped Liveware Exposure。 |
| Agent 可调用的 ClawChat 操作 | 另行内置工具和托管 Agent Skill，用于资料、社交、消息、动态和 Liveware 工作流。 |

### 在 ClawChat 中使用 Connect

- **从对话发起任务：** 私聊中直接发送普通消息；群聊中通过结构化 mention 指定 Agent。
- **控制当前 Session：** 使用 slash 命令创建、列出和切换 Session，选择本地 Project，查看状态，设置运行时模型与 mode，取消当前任务并控制输出可见性。
- **延续持久运行时工作：** 每个 ClawChat 对话和 Agent Binding 保留独立的当前 Session，原生 Runtime Thread 可继续恢复。
- **原地处理运行时交互：** 审批和 Agent 问题会返回到发起任务的私聊或群聊。
- **收发丰富上下文：** ClawChat 图片、音频、文件和视频保持结构化；符合安全规则的本地图片结果会上传到回复中。
- **不离开 ClawChat 使用 Connect Client：** 每个已激活 Binding 都可通过 private 或 public Liveware App 打开 Binding-scoped Client。

ClawChat 入口负责对话范围内的工作；Project 注册、Service 管理和其他本机级配置仍在终端或 Connect Client 中完成。

### Runtime 支持

| Runtime | Connect 管理的进程 | Session 选项 | 原生 Runtime Thread 生命周期 |
| --- | --- | --- | --- |
| Codex | `codex app-server` | 模型、推理强度、sandbox mode | 发现、恢复、取消、归档、还原、删除 |
| OpenCode | `opencode serve` | agent、带 provider 的模型、variant | 发现、恢复、取消、删除 |
| WorkBuddy | Desktop 自有 Task ACP endpoint | Task 自有模型、mode、配置、Command、Skill | 发现、采用、恢复、取消 |

OpenCode 兼容性固定为 `1.18.10`。WorkBuddy 仅支持 [WorkBuddy Runtime Adapter](./docs/workbuddy-adapter.md) 中列出的两个精确 Desktop tuple。Connect 不会安装或升级任一运行时；通用能力边界见 [Runtime Adapters](./docs/runtime-adapters.md)。

> [!IMPORTANT]
> ClawChat Connect 仍处于 Beta 阶段，尚未稳定。启用可信局域网或公开 Liveware 访问前，请先阅读[本地数据与安全](#本地数据与安全)。

## 环境要求

安装前需要：

1. ClawChat 账号和 Agent 邀请码；
2. 已在同一台电脑上安装并登录至少一种受支持的编程 Agent 运行时；
3. arm64 或 x64 架构的 macOS、Linux 或 Windows 10/11。

检查准备使用的运行时：

```bash
codex --version
# 或
opencode --version
```

Connect 使用运行时现有的登录状态、配置、模型供应商、插件、MCP Server 与原生 Session 存储。Codex 需要提供 Connect 所需的 app-server 接口；OpenCode 必须为 `1.18.10`。Connect 不会安装、登录或重新配置它们。

## 快速开始

### 使用 Agent 安装

复制以下提示词并发送给你的编程 Agent：

```text
在这台电脑上安装 ClawChat Connect 当前 beta 通道版本。开始操作前，先阅读并严格执行 https://github.com/XMethues/clawchat-plugin-connect/blob/main/install.md。若已存在配置，应复用现有配置，不要覆盖；安装并启动系统原生的 Connect Service 及其托管的 Liveware，然后验证 doctor、后台服务状态、Runtime 连接和 Liveware Exposure。仅在需要激活时向我索取 Agent 邀请码，并且不得打印、保存或提交邀请码。持续处理直到 install.md 中的所有成功条件均通过，最后报告安装版本和完整运行状态。
```

### 1. 安装 Connect

macOS 或 Linux 的独立安装包不需要 Bun 或 Node.js：

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
```

独立发行包包含对应平台的 Liveware companion，并会与 `clawchat-connect` 一起安装。安装器会在运行时通过 `release-channel/latest-beta.txt` 解析当前 beta 通道版本；只有需要固定版本时才应显式传入版本号。

默认安装目录为 `~/.local/bin`。如果该目录不在 `PATH` 中：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

安装指定版本或自定义目录：

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | \
  CLAWCHAT_CONNECT_INSTALL_DIR="$HOME/bin" sh -s -- v0.1.0-beta.2
```

Windows PowerShell 用户应先下载安装脚本并检查其内容：

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.ps1 `
  -OutFile install.ps1

powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Windows 安装器会校验发行包的 SHA-256，安装 `clawchat-connect.exe`、`liveware.exe` 和 Client 资源，并把安装目录加入当前用户的持久 `PATH`。

开发者也可以安装 Bun 包：

```bash
bun add --global @clawling/clawchat-plugin-connect
```

将已有安装更新到当前 beta 通道版本：

```bash
clawchat-connect update
```

使用 `clawchat-connect update --version v0.1.0-beta.2` 可安装指定版本。更新命令会保留现有配置并刷新系统原生的 Connect Service；明确指定时，历史版本仍可安装。

### 2. 创建 Agent Binding

`work` 是本地名称，可替换为任意简短名称。请选择与已安装编程 Agent 匹配的 Runtime Adapter：

```bash
# Codex
clawchat-connect init --agent work --kind codex

# OpenCode 1.18.10
clawchat-connect init --agent work --kind opencode
```

如果系统服务的 `PATH` 中找不到运行时，可传入绝对路径：

```bash
clawchat-connect init --agent work --kind codex --runtime-path /absolute/path/to/codex
```

`init` 用于创建新配置。已有安装请使用 `agent add` 更新 Binding：

```bash
clawchat-connect agent add work --kind codex --runtime-path /absolute/path/to/codex
```

Codex Binding 仍支持 `--codex-path` 兼容别名。

### 3. 激活 Binding

使用 ClawChat 提供的邀请码：

```bash
clawchat-connect activate work YOUR_INVITE_CODE
```

Connect 只保存激活后返回的凭据，不会保存邀请码，并把 ClawChat Profile 昵称更新为 Binding ID（本例为 `work`）。

一个 Connect 安装可以激活多个 ClawChat 账号，也可以混用 Runtime Adapter：

```bash
clawchat-connect agent add personal --kind codex
clawchat-connect activate personal PERSONAL_ACCOUNT_INVITE_CODE

clawchat-connect agent add work --kind opencode
clawchat-connect activate work WORK_ACCOUNT_INVITE_CODE
clawchat-connect service restart
```

每个 Binding 独立拥有凭据、Session、Runtime 实例和 Liveware Exposure；Project 属于整个安装，可按需共享。Service 会为每个已激活 Binding 创建或接管一个名为 `ClawChat Connect · <binding-id>` 的 Liveware App。默认访问策略为 `private`，仅该 Binding Owner 可打开。

### 4. 安装后台服务

```bash
clawchat-connect service install
clawchat-connect service status
```

服务会立即启动，并在以后登录系统时自动运行。macOS 使用 LaunchAgent，Linux 使用 systemd user service，Windows 使用当前用户的任务计划程序；均不要求管理员/root 权限。

### 5. 发送消息

在 ClawChat 中打开已激活 Agent 的对话并发送普通消息：

```text
解释这个仓库的作用，并建议第一项改进。
```

如果尚未选择 Project，Connect 会在 `~/.clawchat-connect/workspaces/` 下创建隔离工作区，并自动启动持久 Runtime Session。

## 在代码仓库中工作

Project 路径属于本机管理信息，请通过终端或 Connect Client 注册，不要在 ClawChat 消息中注册：

```bash
clawchat-connect project add /absolute/path/to/clawchat-plugin-connect
clawchat-connect project list
```

Connect Client 可以浏览 Connect Service 主机上的目录、新建文件夹并注册 Project。新建 Session 对话框也支持暂存同一操作，只有确认创建 Session 时才会创建文件夹、Project 和 Session。随后在 ClawChat 中选择 Project 和 Session 选项：

目录选择器会向所有能打开 Client 的用户展示主机目录名称和结构，但不会展示文件内容；这也包括 public Liveware Exposure 或可信局域网所允许的用户。

```text
/project connect
/new 审查认证逻辑
/mode workspace-write
/model
/model MODEL_ID high
审查认证实现并报告安全问题。
```

`/project`、`/new`、`/mode` 和 `/model` 会准备一个 Session Intent。下一条普通消息会以原子方式创建 Session 并启动原生 Runtime Thread。直接发送 `/model` 会列出 Runtime Adapter 提供的模型和推理选项；OpenCode agent、variant 等专属选项也可在 Connect Client 中设置。

本地 Project 命令：

| 命令 | 用途 |
| --- | --- |
| `clawchat-connect project add <absolute-path>` | 以根目录名称注册 Project。 |
| `clawchat-connect project list` | 列出 Project 及其本地路径。 |
| `clawchat-connect project remove <workspace-id>` | 移除未使用的 Project 定义；不会删除文件或 Runtime Thread。 |

## Session 与聊天命令

Connect 会为每个 ClawChat 对话和 Agent Binding 保留一个当前 Session。Session 具有稳定的 8 位 Ref；启动后会关联一个可恢复的原生 Runtime Thread。

以下命令需要作为独立 ClawChat 消息发送。私聊直接使用表中形式；群聊需要在命令前放置 Agent 的结构化 mention 并保留一个空格，例如 `@Agent /help`。群聊中未使用该寻址 mention 的 slash 内容不会被识别为控制命令，可以作为普通 Agent 输入处理。

| 命令 | 用途 |
| --- | --- |
| `/help` | 显示命令摘要。 |
| `/status` | 显示当前或待创建 Session、有效选项、连接和任务状态。 |
| `/new [name]` | 为下一条普通消息准备新 Session。 |
| `/sessions` | 列出所选工作区的 Session 和可用 Runtime Thread。 |
| `/switch <name-or-ref>` | 恢复 Session 或接管可用 Runtime Thread。 |
| `/project [workspace-id\|none]` | 查看同步后的 Project、按 Workspace ID 选择，或使用隔离的 Non-Project 工作区。 |
| `/model [model-id [reasoning-option]\|default]` | 查看或设置 Session 模型及其第二级选项；`default` 恢复继承。 |
| `/mode [mode\|default]` | 查看或设置 Runtime Adapter 提供的 mode；Codex 支持 `read-only`、`workspace-write`、`danger-full-access`。 |
| `/cancel` | 尽可能中断当前运行时任务。 |
| `/clawchat-output <mode>` | 将 ClawChat 输出设为 `minimal`、`normal` 或 `full`。 |

`/help` 对所有参与者开放；其他控制命令仅限该 Agent Binding 的 Owner。已移除的 `/list`、`/current`、`/clawchat-status` 和 `/project add|list|use|current|clear|remove` 会返回 `/help` 提示，不会转发给编程 Agent。

输出可见性按 Binding 隔离。有效模型按“Session 覆盖值 → Agent Binding 默认值 → Runtime Adapter 默认值”解析；第二级选项对应 Codex reasoning effort 或 OpenCode variant。不可用的已保存选项会明确报错，不会静默替换。

Runtime 审批和问题只会出现在发起该 Turn 的私聊或群聊中。私聊使用 `/approve`、`/approve session`、`/deny`、`/N` 或 `/answer <文本>`；群聊在这些精确小写、单行形式前加 `@Agent `。当前阶段，原群聊中的任何参与者都可以回答 Interaction，包括 Session 级审批；Connect 控制命令仍然仅限 Connect Owner。

## Connect Client

服务默认在 `http://127.0.0.1:47823/` 提供浏览器 Client：

```bash
clawchat-connect web
```

只打印地址而不打开浏览器：

```bash
clawchat-connect web --no-open
```

Connect Client 可以：

- 创建和切换 Session、选择 Project、查看原生 Runtime transcript；
- 设置 Runtime Adapter 提供的 model、mode、agent、effort 或 variant；
- 在 composer 的 slash picker 中发现 Runtime command 与 Skill；
- 添加受支持的附件、发送后续任务，并把排队中的任务撤回 composer 编辑；
- 在 Runtime Adapter 支持时归档、还原或永久删除 Session。

由浏览器发起的消息只保留在 Connect 本地，不会发布到 ClawChat。

同一 Session 中，浏览器与 ClawChat 消息会严格排序；不同 Session 可以并发运行，最大并发数由 `maxConcurrentTurns` 控制。

### 通过 Liveware 在 ClawChat 中访问

每个已激活 Binding 都会在自己的 ClawChat 账号中展示独立的 `ClawChat Connect` 入口。本机回环 Client 可以管理全部 Binding；通过 Liveware 打开的 Client 只能读取和修改该 Exposure 所属 Binding 的数据。选择访问策略后重启服务：

```bash
# 仅 Connect Owner（默认）
clawchat-connect config set livewareAccessPolicy private

# 任何能打开此 Liveware App 的已认证 ClawChat 用户
clawchat-connect config set livewareAccessPolicy public

# 注销并停用 Liveware Exposure
clawchat-connect config set livewareAccessPolicy off

clawchat-connect service restart
```

删除某个 Binding、它的 Liveware App 与本地历史时，需要显式确认：

```bash
clawchat-connect agent remove work --yes
```

共享 Project 和其他 Binding 不会被删除。

### 可信局域网访问

要让可信私有网络中的其他设备访问：

```bash
clawchat-connect config set clientHost 0.0.0.0
clawchat-connect service restart
```

然后打开 `http://<电脑局域网-IP>:47823/`。

> [!WARNING]
> 局域网模式没有身份验证或 TLS。任何能访问该端口的人都可以枚举主机目录名称与结构、读取 Session、管理 Project 路径与运行时偏好，并提交本地编程 Agent 任务。绝对不要暴露到互联网。

恢复仅本机访问：

```bash
clawchat-connect config set clientHost 127.0.0.1
clawchat-connect service restart
```

## 媒体支持

ClawChat 传入的媒体会保留结构化信息：

- 图片、音频、文件和视频会连同 MIME 类型及安全文件名下载到 Connect 管理的缓存；
- Runtime Adapter 会把受支持的媒体作为原生输入提交，模型或 provider 拒绝时明确报错，不会静默转换；
- 单个下载上限为 100 MiB；
- 缓存上限为 512 MiB，文件连续 15 天未访问后过期。

运行时返回本地 Markdown 图片时，只有位于 Project 工作区或 Connect 媒体缓存内，且扩展名与文件签名确认为 PNG、JPEG、GIF 或 WebP，Connect 才会上传到 ClawChat。其他本地路径只作为文本返回。

## 配置

默认配置文件为 `~/.clawchat-connect/config.json`：

```bash
clawchat-connect config get
clawchat-connect config get agents.work.sandboxMode
```

常用 Codex 设置：

```bash
clawchat-connect config set livewareAccessPolicy private
clawchat-connect config set agents.work.model YOUR_MODEL_ID
clawchat-connect config set agents.work.sandboxMode workspace-write
clawchat-connect config set agents.work.modelReasoningEffort high
clawchat-connect config set agents.work.approvalPolicy on-request
clawchat-connect config set agents.work.webSearchMode live
clawchat-connect config set agents.work.networkAccessEnabled true
clawchat-connect service restart
```

Codex Binding 设置：

| 设置 | 可选值 |
| --- | --- |
| `sandboxMode` | `read-only`、`workspace-write`、`danger-full-access` |
| `modelReasoningEffort` | `minimal`、`low`、`medium`、`high`、`xhigh` |
| `approvalPolicy` | `never`、`on-request`（默认）、`untrusted` |
| `webSearchMode` | `disabled`、`cached`、`live` |
| `networkAccessEnabled` | `true`、`false` |

全局设置：

| 设置 | 可选值 |
| --- | --- |
| `livewareAccessPolicy` | `private`（默认）、`public`、`off` |
| `clientHost` | `127.0.0.1`、`0.0.0.0` |
| `clientPort` | `1024`–`65535` |

每个 Binding 还支持 `displayName` 和 `executablePathOverride`。OpenCode 的 agent、带 provider 的模型与 variant 默认值保存在 Binding 的 `sessionOptions` 中；Connect Client 会从运行中的 OpenCode 动态发现并校验可用值。`sessionOptions`、`env` 与 `additionalDirectories` 需直接编辑 JSON。

修改运行时或端点配置后需要重启服务。完整 JSON 示例与自托管 ClawChat 配置见[英文文档](./README.md#configuration)。

## 服务与诊断

| 命令 | 用途 |
| --- | --- |
| `clawchat-connect status [--agent <id>]` | 显示激活、运行时和 Liveware Exposure 状态。 |
| `clawchat-connect doctor` | 检查基本配置和内置 Liveware。 |
| `clawchat-connect tool list` | 列出 24 个可供 Agent 调用的 ClawChat tool name。 |
| `clawchat-connect tool describe <name>` | 显示工具的生成输入 Schema。 |
| `clawchat-connect tool call <name> --input-json <json-or->` | 向运行中的 Service 提交一次至多执行一次的工具请求。 |
| `clawchat-connect liveware app ...` | 通过 Service 管理额外的 Agent Liveware App。 |
| `clawchat-connect liveware tunnel ...` | 绑定或解绑本地回环服务并同步 ClawChat 注册。 |
| `clawchat-connect skills install` | 强制修复内置的两份用户级 Agent skill。 |
| `clawchat-connect agent list` | 列出 Agent Binding。 |
| `clawchat-connect agent remove <id> --yes` | 删除一个 Binding、其 Liveware Exposure 和 Binding-scoped 本地数据。 |
| `clawchat-connect service start` | 启动服务。 |
| `clawchat-connect service stop` | 停止服务但不卸载。 |
| `clawchat-connect service restart` | 配置变更后重启服务。 |
| `clawchat-connect service status` | 显示原生服务状态。 |
| `clawchat-connect service logs --lines 250 --follow` | 持续查看服务日志。 |

遇到问题时先运行：

```bash
clawchat-connect doctor
clawchat-connect status
clawchat-connect service status
clawchat-connect service logs --lines 250
```

常见原因：

- **运行时无法启动：** 运行 `codex --version` 或 `opencode --version`，确认已登录并检查初始化错误。需要使用其他可执行文件时，通过 `agents.<id>.executablePathOverride` 指定。
- **运行时在终端正常，但 Connect 无法启动：** 重新安装服务以捕获当前 `PATH`。
- **OpenCode 版本不匹配：** 安装受支持的 OpenCode `1.18.10`；Connect 会拒绝未经验证的版本。
- **修改配置后未生效：** 重启服务。
- **浏览器 Client 无法打开：** 确认服务正在运行，再用 `clawchat-connect web --no-open` 获取地址。
- **ClawChat 中没有 `ClawChat Connect`：** 检查 `status`，重启服务并查看 Liveware 日志。

## 本地数据与安全

| 数据 | 默认位置 |
| --- | --- |
| 配置 | `~/.clawchat-connect/config.json` |
| SQLite 状态与凭据 | `~/.clawchat-connect/state.sqlite` |
| macOS 服务日志 | `~/.clawchat-connect/logs/` |
| Non-Project 隔离工作区 | `~/.clawchat-connect/workspaces/` |
| 媒体缓存 | `~/.clawchat-connect/media-cache/` |
| 原生 Runtime Thread | 由运行时管理，例如 Codex 使用 `~/.codex/sessions/` |

Windows 上，Connect 数据位于 `%USERPROFILE%\.clawchat-connect\`，独立二进制和许可证声明默认位于 `%LOCALAPPDATA%\ClawChatConnect\`。

邀请码不会被持久化。Connect 不会把自身的 ClawChat 工具暴露给编程 Agent 运行时、运行 MCP Server 或注入 MCP 配置；运行时中已有的 MCP Server 仍由该运行时管理。

安全问题报告和局域网/媒体安全说明请参阅 [SECURITY.md](./SECURITY.md)，协议与模块设计请参阅 [docs/architecture.md](./docs/architecture.md)。

## 开发

开发需使用 `package.json` 中固定的 Bun 版本：

```bash
bun install --frozen-lockfile
bun run check
bun run clean && bun run build
```

预览浏览器 Client：

```bash
bun run preview:web
```

真实 Codex 模型目录与模型切换集成测试：

```bash
CODEX_INTEGRATION_PATH=/absolute/path/to/codex bun run test:integration:codex
```

OpenCode 能力与原生 Session 生命周期集成测试：

```bash
OPENCODE_EXECUTABLE=/absolute/path/to/opencode bun run test:integration:opencode
```

`bun run build:binary` 会生成较轻量的未打包独立构建，并将 Connect 可执行文件及已校验 SHA-256 的当前平台 Liveware 资源写入 `dist/`；Windows 构建使用 `.exe` 名称。

`bun run build:release` 会生成当前主机的可分发发行包，并将归档文件、安装器、`CHANGELOG.md` 和 SHA-256 校验和写入 `build/release/`。

匹配 `v*-beta.*` 的标签会运行 [`.github/workflows/release-beta.yml`](./.github/workflows/release-beta.yml)。该工作流校验标签与 `package.json`、运行确定性代码检查、验证全部六个内置 Liveware 资源，并构建 macOS、Linux 和 Windows 的 arm64/x64 二进制。本机已安装产品验收属于可选的任务内测试，不会阻止创建发布标签。所有资源发布后，工作流会更新供默认安装和更新使用的 [`release-channel/latest-beta.txt`](https://github.com/XMethues/clawchat-plugin-connect/blob/release-channel/latest-beta.txt) 指针。

贡献代码前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)、[CONTEXT.md](./CONTEXT.md) 和相关 [ADR](./docs/adr/)。

## 许可证

ClawChat Connect 使用 [MIT License](./LICENSE)。内置依赖的许可证声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

> 英文 README 是完整的规范参考。中文文档聚焦安装和日常使用；高级配置和所有边界行为请查阅[英文版本](./README.md)。
