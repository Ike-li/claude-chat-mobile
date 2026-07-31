# Claude Chat Mobile

> 把本机 `claude` CLI 接到手机：沿用同一套项目配置、工具与会话记录，但不是远程桌面，也不是共享实时 TTY。

**中文** · [English](README.en.md) · [🌐 网站](https://ike-li.github.io/claude-chat-mobile/)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Agent SDK](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.dependencies%5B%22%40anthropic-ai%2Fclaude-agent-sdk%22%5D&label=Agent%20SDK&color=blue)](https://code.claude.com/docs/en/agent-sdk/overview)
[![tested with claude CLI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.verifiedWith.claudeCli&label=tested%20with%20claude%20CLI&color=blue)](#前置条件)
[![PWA](https://img.shields.io/badge/PWA-installable-blueviolet.svg)](#快速开始)
[![CI](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg)](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml)

> Agent SDK 与 claude CLI 徽章直接读取 `master` 上的 `package.json`。CLI 徽章表示上个发布版的验证环境，不是最低版本要求。

![Claude Chat Mobile — 终端里的 claude，手机上也能用](https://ike-li.github.io/claude-chat-mobile/assets/hero-zh.jpg)

Claude Code 在跑，人却不总在电脑前。Claude Chat Mobile 通过 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 驱动你本机已登录的 CLI，让你在手机上继续改代码、跑命令、回答问题和审批操作。它不打包 Claude，也不建立第二套账号或会话系统。

## 适合谁

- 已经在 macOS 或 Linux 终端使用 `claude`，希望离开电脑后继续查看和处理任务。
- 需要在多个仓库、多个会话之间切换，并在手机上查看工具调用、diff、后台任务和错误状态。
- 希望危险操作或问题能主动通知到手机，而不是一直盯着终端。

同一时刻只有一个驾驶员：Web 驾驶时消息经 Agent SDK 进入本机 CLI；终端 CLI 驾驶时，Web 只读追平落盘记录。它不是远程桌面，也不能让手机和终端同时向同一个实时进程输入。

## 核心能力

### 会话与工作区

- 续接、分叉和两级删除 CLI 会话；跨会话聚合“需要你”的任务。
- 多工作区、多会话并行查看。git worktree 必须把绝对路径显式加入 `workdirs.json`，不会自动探测或隐式放行。
- 一轮一条：任务运行时输入可继续写草稿，但发送键切换为停止键，不会积压待发消息。

### 手机交互

- 流式 Markdown、代码高亮、工具卡片、Edit/Write diff、Read 片段、`AskUserQuestion` 原生选择器。
- 上传图片与文件、粘贴截图、历史附件预览，以及 composer `@` 文件引用。
- 在授权工作区内浏览项目文件；不超过 256KB 的现有文本文件可用 CodeMirror 编辑，写前用内容哈希阻止并发覆盖。

### 通知与可见性

- Web Push / ntfy 通知审批、提问和结果；默认只发类型级提示，可测试推送链路并选择是否开启 Web Push 内容预览。
- 可选 CLI hooks bridge，让终端会话的 Stop / Notification 从轮询升级为即时信号。
- API 错误、重试倒计时、SDK 提示、子 agent 与后台任务进度直接显示在界面中，不再只藏在服务端日志。

### 可靠性与运维

- `seq + epoch` 事件去重与断线补发；状态栏按当前驾驶方选择 SDK 或 CLI 快照作为事实源。
- `doctor` 启动自检、UI 安全体检、日志脱敏、鉴权限速、服务状态面板和鉴权后的 `/health`、`/metrics`。
- 可安装 PWA，完整中英文界面；前端依赖均随项目自托管，不依赖 CDN。

## 前置条件

- **Node.js ≥ 20**。
- **本机已安装并登录 `claude` CLI**；先确认 `which claude` 能找到命令，并能在终端正常开始对话。
- **macOS 或 Linux** 为一等支持平台；原生 Windows 属实验路径，推荐使用 WSL2。
- 官方订阅和第三方网关都可用。网关相关 `ANTHROPIC_*` 必须存在于**启动 server 的 shell 环境**；写进 `.env` 会被剥除。

## 快速开始

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile

node --version
which claude
npm install --omit=dev
npm run setup
node scripts/doctor.js
npm start
```

`setup` 会生成 `AUTH_TOKEN`、询问允许 Claude 操作的 `WORK_DIR`，并明确询问是否安装 CLI hooks bridge。启动日志会打印带 token 的局域网地址，在手机上打开即可。

手机首次从非本机路径连接时，还要在电脑上批准设备：

```bash
node scripts/device.js list
node scripts/device.js approve <ID>
```

完整的首次安装、非交互 setup、可复制的编程 agent 安装提示、PWA 和 bridge 配置见 [首次使用指南](docs/getting-started.md)。

## 运行方式

| 方式 | 适合 | 注意事项 |
|---|---|---|
| 同 WiFi：`http://<lan-ip>:3000/#token=…` | 家中或办公室局域网 | 最省事，离开当前网络后不可用 |
| 临时公网：`cloudflared tunnel --url http://localhost:3000` | 试用、演示 | 随机域名会变化；没有 Access，仍需设备审批 |
| 固定生产：固定域名 + Cloudflare Access + 常驻服务 | 长期随时访问 | 需要一次性部署与运维，见 [部署指南](docs/deployment.md) |

PWA 与 Web Push 需要 HTTPS；iOS Web Push 还要求 iOS 16.4+ 并先“添加到主屏幕”。

## 安全模型

> 这是一个可远程触达、直通本机 shell 的代码执行入口。暴露到公网前，请先理解这些边界。

1. **单用户，权限等同机主。** 项目没有多用户或租户隔离；通过鉴权的操作拥有启动 `claude` 的本机账号权限。
2. **无 token 不出本机。** 未设置 `AUTH_TOKEN` 时只监听 `127.0.0.1`；需要手机或隧道访问时必须设置强 token。
3. **工作目录必须收窄。** `WORK_DIR` / `workdirs.json` 是文件、会话和 git 操作的范围门。不要为了省事把整个家目录交给远程入口。
4. **自动放行继承 CLI 配置。** `~/.claude/settings.json`、项目 `.claude/settings.json` 和 `.claude/settings.local.json` 中的 `permissions.allow` 会同源生效；公网使用前应审查累积的 Bash/Write 等规则。
5. **设备信任是第二道门。** 除本机直连或已通过 Cloudflare Access JWT 的连接外，合法 token 仍需一次性设备审批；可用 `node scripts/device.js deny <ID>` 吊销。
6. **文件编辑器是用户直写。** 它不经过 Agent 的工具审批链，只允许修改已存在、≤256KB 的文件，并做范围校验、哈希冲突检测和审计记录；设 `FILE_EDIT=off` 可退回只读。

漏洞请通过 [GitHub Security Advisories](SECURITY.md) 私下报告，不要公开提交 issue。

## Web 与 CLI 如何协作

```text
Web 驾驶：手机 → Socket.io → AgentSession → Agent SDK → 本机 claude CLI → 工作区
CLI 驾驶：终端 claude → transcript / hooks → server → 手机只读镜像
```

两条路径共享 CLI 的落盘会话记录，但不共享一个实时 TTY。CLI 驾驶时，Web 只能看到已经落盘的内容；hooks 负责加速“回合结束/需要你”信号，不会把终端进程变成可双向附着的会话。Web 接管前会等待终端回合结束，并在发送前吸收磁盘上的外部增长。

完整组件图、消息流、单驾驶员状态转换与断线回放见 [架构说明](docs/architecture.md)。

## 文档导航

- [首次使用指南](docs/getting-started.md)：从 clone 到手机发出第一条消息。
- [部署与运维](docs/deployment.md)：Cloudflare Tunnel、Access、LaunchAgent 与 systemd。
- [架构说明](docs/architecture.md)：Web/CLI 双通道、事件信封与接管边界。
- [展示契约](docs/display-contracts.md)：模型、思考强度和状态栏的事实源。
- [仓库地图](docs/repository-map.md)：入口、目录职责与完整文件清单。
- [环境变量模板](.env.example)：所有运行时配置及默认值。
- [安全策略](SECURITY.md)：漏洞报告方式。

## 用量与兼容性

截至 **2026-07-31**，Agent SDK、`claude -p` 和第三方 Agent SDK 应用仍使用 Claude 订阅额度；Anthropic 曾公布的独立 credit 方案处于暂停状态。政策可能变化，请以 [官方说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) 为准。

使用 API key 或第三方网关时，费用与限额由对应平台决定。项目记录的 claude CLI 版本只是发布验证环境；升级前可查看 [Releases](https://github.com/Ike-li/claude-chat-mobile/releases)。

## 许可证

[GNU AGPL-3.0-only](LICENSE) © 2026 Ike-li，附带 Section 7 补充条款；见 [NOTICE](NOTICE)。

你可以使用、研究、修改并自托管本软件。若把修改后的版本作为网络服务对外提供，AGPL 要求开放对应源代码；补充条款还要求保留原作者署名、不得歪曲项目来源。

## 友链

- [LINUX DO](https://linux.do/)
