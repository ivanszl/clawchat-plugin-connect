<div align="center">
  <p><a href="./README.md">English</a> | <strong>中文</strong></p>
  <img src="./docs/assets/clawchat-connect.svg" alt="ClawChat Connect 标志" width="152" />
  <h1>ClawChat Connect</h1>
  <p><strong>把运行在你电脑上的编程 Agent 接入任意 ClawChat 对话。</strong></p>
  <p>
    <a href="https://github.com/XMethues/clawchat-plugin-connect/releases"><img alt="GitHub 版本" src="https://img.shields.io/github/v/release/XMethues/clawchat-plugin-connect?include_prereleases&style=flat-square"></a>
    <a href="./LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-4c8bf5?style=flat-square"></a>
    <img alt="支持 macOS、Linux 和 Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-59636e?style=flat-square">
    <img alt="运行时：Codex CLI" src="https://img.shields.io/badge/runtime-Codex%20CLI-f97316?style=flat-square">
  </p>
  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#在代码仓库中工作">项目</a> ·
    <a href="#connect-client">Connect Client</a> ·
    <a href="#配置">配置</a> ·
    <a href="#开发">开发</a>
  </p>
</div>

---

ClawChat Connect 是连接 ClawChat 与本地编程 Agent 运行时的桥梁。Agent、凭据、项目文件和运行时历史都保留在你的电脑上；你可以从 ClawChat 或浏览器中的 Connect Client 继续同一个持久 Session。

## 主要特性

- **随时发起任务：** 在 ClawChat 对话中启动或继续本地编程工作。
- **项目保留在本地：** Project 路径和 Runtime Thread 均位于运行 Connect 的电脑。
- **跨入口连续协作：** ClawChat 与 Connect Client 的消息会进入同一个有序 Session。
- **支持丰富上下文：** 可向 Codex 提交图片、音频、文件和视频引用。
- **访问方式可控：** 默认仅监听本机，也可显式开放到可信局域网，或通过 Liveware 在 ClawChat 中访问。
- **原生用户级服务：** 无需管理员或 root 权限。

当前 Alpha 版本支持：

- 通过 `codex app-server` 接入 Codex CLI；
- macOS、Linux 和 Windows，支持 arm64 与 x64；
- 持久 Session 和可复用的 Project 工作区；
- 从 ClawChat 接收图片、音频、文件和视频；
- 将本地 Codex 生成的图片回复到 ClawChat；
- 使用本地浏览器 Client 查看 Session，并发送仅保留在本地的消息。

目前只提供 Codex Runtime Adapter，因此一个 Connect 安装实例只能配置一个 Codex Agent Binding。底层运行时接口支持适配器扩展，但其他编程 Agent 尚未发布。

> [!IMPORTANT]
> ClawChat Connect 仍处于 Alpha 阶段。启用可信局域网或公开 Liveware 访问前，请先阅读[本地数据与安全](#本地数据与安全)。

## 环境要求

安装前需要：

1. ClawChat 账号和 Agent 邀请码；
2. 已在同一台电脑上安装并登录 `codex-cli 0.145.0`；
3. arm64 或 x64 架构的 macOS、Linux 或 Windows 10/11。

检查 Codex 版本：

```bash
codex --version
```

Connect 严格要求 `codex-cli 0.145.0`。它会使用已有的 Codex 登录状态、配置、MCP Server 和 `~/.codex/sessions` 数据，不会安装或重新配置 Codex。

## 快速开始

### 1. 安装 Connect

macOS 或 Linux 的独立安装包不需要 Bun 或 Node.js：

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | sh
```

独立发行包包含对应平台的 Liveware companion，并会与 `clawchat-connect` 一起安装。默认安装目录为 `~/.local/bin`；如果该目录不在 `PATH` 中：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

安装指定版本或自定义目录：

```bash
curl -fsSL https://raw.githubusercontent.com/XMethues/clawchat-plugin-connect/main/install.sh | \
  CLAWCHAT_CONNECT_INSTALL_DIR="$HOME/bin" sh -s -- v0.1.0-alpha.6
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

### 2. 创建 Agent Binding

`work` 是本地名称，可替换为任意简短名称：

```bash
clawchat-connect init --agent work --kind codex
```

需要指定 Codex 可执行文件时：

```bash
clawchat-connect init --agent work --kind codex --codex-path /absolute/path/to/codex
```

`init` 用于创建新配置。已有安装请使用 `agent add` 更新 Binding：

```bash
clawchat-connect agent add work --kind codex --codex-path /absolute/path/to/codex
```

### 3. 激活 Binding

使用 ClawChat 提供的邀请码：

```bash
clawchat-connect activate work YOUR_INVITE_CODE
```

Connect 只保存激活后返回的凭据，不会保存邀请码。激活过程还会创建或接管名为 `ClawChat Connect` 的 Liveware App。默认访问策略为 `private`，仅 Connect Owner 可打开。

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

如果尚未选择 Project，Connect 会在 `~/.clawchat-connect/workspaces/` 下创建隔离工作区，并自动启动持久 Codex Session。

## 在代码仓库中工作

Project 路径属于本机管理信息，请通过终端或 Connect Client 注册，不要在 ClawChat 消息中注册：

```bash
clawchat-connect project add connect /absolute/path/to/clawchat-plugin-connect
clawchat-connect project list
```

需要额外可信写入目录时，可重复使用 `--additional-directory /absolute/path`。随后在 ClawChat 中选择 Project 和 Session 选项：

```text
/project connect
/new 审查认证逻辑
/mode workspace-write
/model
/model MODEL_ID high
审查认证实现并报告安全问题。
```

`/project`、`/new`、`/mode` 和 `/model` 会准备一个 Session Intent。下一条普通消息会以原子方式创建 Session 并启动 Codex Runtime Thread。

本地 Project 命令：

| 命令 | 用途 |
| --- | --- |
| `clawchat-connect project add <name> <absolute-path> [--additional-directory <path>]` | 注册 Project 和可选的额外可信目录。 |
| `clawchat-connect project list` | 列出 Project 及其本地路径。 |
| `clawchat-connect project remove <name-or-id>` | 移除未使用的 Project 定义；不会删除文件。 |

## Session 与聊天命令

Connect 会为每个 ClawChat 对话和 Agent Binding 保留一个当前 Session。Session 具有稳定的 8 位 Ref；启动后会关联一个可恢复的 Codex Runtime Thread。

以下命令需要作为独立 ClawChat 消息发送：

| 命令 | 用途 |
| --- | --- |
| `/help` | 显示命令摘要。 |
| `/status` | 显示当前或待创建 Session、有效选项、连接和任务状态。 |
| `/new [name]` | 为下一条普通消息准备新 Session。 |
| `/sessions` | 列出所选工作区的 Session 和可用 Runtime Thread。 |
| `/switch <name-or-ref>` | 恢复 Session 或接管可用 Runtime Thread。 |
| `/project [name-or-id\|none]` | 查看或选择 Project，或选择隔离的 Non-Project 工作区。 |
| `/model [model-id [reasoning-effort]\|default]` | 查看或设置 Session 的模型与推理强度。 |
| `/mode [mode\|default]` | 设置 `read-only`、`workspace-write` 或 `danger-full-access`。 |
| `/cancel` | 尽可能中断当前 Codex 任务。 |
| `/clawchat-output <mode>` | 将 ClawChat 输出设为 `minimal`、`normal` 或 `full`。 |

`/help` 对所有参与者开放；其他控制命令仅限 Connect Owner。模型按“Session 覆盖值 → Agent Binding 默认值 → Runtime Adapter 默认值”解析。更换模型会继续使用同一个 Runtime Thread；更改已创建 Session 的 mode 会开启新的 Runtime Thread 边界。

## Connect Client

服务默认在 `http://127.0.0.1:47823/` 提供浏览器 Client：

```bash
clawchat-connect web
```

只打印地址而不打开浏览器：

```bash
clawchat-connect web --no-open
```

Connect Client 可以创建 Session、管理 Project、浏览 Codex transcript、调整模型选项并发送后续消息。由浏览器发起的消息只保留在 Connect 本地，不会发布到 ClawChat。

同一 Session 中，浏览器与 ClawChat 消息会严格排序；不同 Session 可以并发运行，最大并发数由 `maxConcurrentTurns` 控制。

### 通过 Liveware 在 ClawChat 中访问

激活后的 Agent 会在 ClawChat 中展示 `ClawChat Connect`，其地址会连接到完整的 Connect Client。选择访问策略后重启服务：

```bash
# 仅 Connect Owner（默认）
clawchat-connect config set livewareAccessPolicy private

# 任何能打开此 Liveware App 的已认证 ClawChat 用户
clawchat-connect config set livewareAccessPolicy public

# 注销并停用 Liveware Exposure
clawchat-connect config set livewareAccessPolicy off

clawchat-connect service restart
```

### 可信局域网访问

要让可信私有网络中的其他设备访问：

```bash
clawchat-connect config set clientHost 0.0.0.0
clawchat-connect service restart
```

然后打开 `http://<电脑局域网-IP>:47823/`。

> [!WARNING]
> 局域网模式没有身份验证或 TLS。任何能访问该端口的人都可以读取 Session、管理 Project 路径与偏好，并提交本地 Codex 任务。绝对不要暴露到互联网。

恢复仅本机访问：

```bash
clawchat-connect config set clientHost 127.0.0.1
clawchat-connect service restart
```

## 媒体支持

ClawChat 传入的媒体会保留结构化信息：

- 图片和音频下载到 Connect 管理的缓存，并作为原生本地输入提交给 Codex；
- 文件和视频下载后，以本地文件引用的形式加入提示；
- 单个下载上限为 100 MiB；
- 缓存上限为 512 MiB，文件连续 15 天未访问后过期。

Codex 返回本地 Markdown 图片时，只有位于 Project 工作区、允许的额外目录或 Connect 媒体缓存内，且签名确认为 PNG、JPEG、GIF 或 WebP，Connect 才会上传到 ClawChat。

## 配置

默认配置文件为 `~/.clawchat-connect/config.json`：

```bash
clawchat-connect config get
clawchat-connect config get agents.work.sandboxMode
```

常用设置：

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

| 设置 | 可选值 |
| --- | --- |
| `sandboxMode` | `read-only`、`workspace-write`、`danger-full-access` |
| `modelReasoningEffort` | `minimal`、`low`、`medium`、`high`、`xhigh` |
| `approvalPolicy` | `never`、`on-request`（默认）、`untrusted` |
| `webSearchMode` | `disabled`、`cached`、`live` |
| `networkAccessEnabled` | `true`、`false` |
| `livewareAccessPolicy` | `private`（默认）、`public`、`off` |
| `clientHost` | `127.0.0.1`、`0.0.0.0` |
| `clientPort` | `1024`–`65535` |

修改运行时或端点配置后需要重启服务。`env` 和 `additionalDirectories` 需直接编辑 JSON；完整示例与自托管 ClawChat 配置请参阅[英文文档](./README.md#configuration)。

## 服务与诊断

| 命令 | 用途 |
| --- | --- |
| `clawchat-connect status [--agent <id>]` | 显示激活、运行时和 Liveware Exposure 状态。 |
| `clawchat-connect doctor` | 检查基本配置和内置 Liveware。 |
| `clawchat-connect agent list` | 列出 Agent Binding。 |
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

- **Codex 版本不兼容：** 必须安装 `codex-cli 0.145.0`，或通过 `--codex-path` 指向正确版本。
- **终端中 Codex 正常，但 Connect 无法启动：** 重新安装服务以捕获当前 `PATH`。
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
| Codex Runtime Thread | `~/.codex/sessions/` |

Windows 上，Connect 数据位于 `%USERPROFILE%\.clawchat-connect\`，独立二进制和许可证声明默认位于 `%LOCALAPPDATA%\ClawChatConnect\`。

邀请码不会被持久化。Connect 不会向 Codex 暴露工具、运行 MCP Server 或注入 MCP 配置；用户原有 Codex 环境中的 MCP Server 仍由 Codex 管理。

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

贡献代码前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)、[CONTEXT.md](./CONTEXT.md) 和相关 [ADR](./docs/adr/)。

## 许可证

ClawChat Connect 使用 [MIT License](./LICENSE)。内置依赖的许可证声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

> 英文 README 是完整的规范参考。中文文档聚焦安装和日常使用；高级配置、发布流程和所有边界行为请查阅[英文版本](./README.md)。
