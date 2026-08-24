# Claude Chat Mobile

这是一个本机自托管的「Claude Code 远程控制台」：把本机 `claude` CLI 的 agent 会话，接到手机/浏览器的聊天 UI 上。

没有数据库、没有多租户、没有 SaaS 后端——状态落在本机磁盘和进程内存里。

**中文** · [English](README.en.md) · [🌐 网站](https://ike-li.github.io/claude-chat-mobile/)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Agent SDK](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.dependencies%5B%22%40anthropic-ai%2Fclaude-agent-sdk%22%5D&label=Agent%20SDK&color=blue)](https://code.claude.com/docs/en/agent-sdk/overview)
[![tested with claude CLI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.verifiedWith.claudeCli&label=tested%20with%20claude%20CLI&color=blue)](#前置条件)
[![PWA](https://img.shields.io/badge/PWA-installable-blueviolet.svg)](#快速开始)
[![CI](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg)](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml)

## 一句话产品形态

```
手机 PWA / 浏览器
    ↕ Socket.io（鉴权后进 approved 房间）
本机 Node server（server.js → src/server/app.js）
    ↕ Agent SDK query()
本机 claude CLI 子进程（cwd = 某个白名单工作区）
    ↕ 读写
~/.claude 下的 transcript / 会话文件
```

目标不是「再做一个 AI 聊天产品」，而是 **远程等价地使用本机 Claude Code**：发消息、流式看输出、工具审批、中断、续接会话、切模型/权限档/effort。

它解决的是：**人不在电脑前时，仍能安全、接近终端等价地操作本机 Claude Code。**

![Claude Chat Mobile — 终端里的 claude，手机上也能用](https://ike-li.github.io/claude-chat-mobile/assets/hero-zh.jpg)

同一时刻只有一个驾驶员。Web 驾驶时消息经 Agent SDK 进入本机 CLI；终端 CLI 驾驶时，Web 只读追平落盘记录，两端不能同时向一个实时进程输入。终端仍在跑时你可以显式强制续接（会先弹确认框说明分叉风险）——那只解除手机这一侧的只读，不会停掉终端进程。完整的组件图、消息流、单驾驶员状态转换与断线回放见[架构说明](docs/architecture.md)。

## 核心能力

- **会话与工作区**：续接、分叉、两级删除 CLI 会话；跨会话聚合「需要你」的任务；多工作区、多会话并行查看。一轮一条——任务运行时输入可继续写草稿，但发送键切换为停止键，不积压待发消息。
- **对话与文件**：流式 Markdown、代码高亮、工具卡片、Edit/Write diff、Read 片段、`AskUserQuestion` 原生选择器；上传图片与文件、粘贴截图、历史附件预览、composer `@` 文件引用；在授权工作区内浏览项目文件，并用 CodeMirror 直接编辑。
- **通知**：Web Push / ntfy 推送审批、提问和结果，默认只发类型级提示，可测试推送链路并选择是否开启内容预览；可选 CLI hooks bridge，把终端会话的「回合结束/需要你」从轮询升级为即时信号。
- **可见性**：API 错误、重试倒计时、SDK 提示、子 agent 与后台任务进度直接显示在界面中，不再只藏在服务端日志。
- **可靠性与运维**：`seq + epoch` 事件去重与断线补发；状态栏按当前驾驶方选择 SDK 或 CLI 快照作为事实源；`doctor` 启动自检、UI 安全体检、日志脱敏、鉴权限速、服务状态面板和鉴权后的 `/health`、`/metrics`。全部配置集中在一份 `ccm.config.json`，命令行 (`config.js`) 与图形界面读写同一份。
- **配置入口**：headless 用 `node scripts/config.js`；macOS 上另有可选的桌面控制台（菜单栏图标 + 主窗口），配置表单、日志、体检、服务安装全部内嵌，**不需要开终端**，且 server 没起来时照样能改配置。
- **形态**：可安装 PWA，完整中英文界面；前端依赖均随项目自托管，不依赖 CDN。

## 前置条件

- **Node.js ≥ 20**。
- **本机已安装并登录 `claude` CLI**；先确认 `which claude` 能找到命令，并能在终端正常开始对话。
- **macOS 或 Linux** 为一等支持平台；原生 Windows 属实验路径，推荐使用 WSL2。
- 官方订阅和第三方网关都可用。网关相关 `ANTHROPIC_*` 必须存在于**启动 server 的 shell 环境**；写进配置文件会被剥除。
- 截至 **2026-07-31**，Agent SDK 与 `claude -p` 仍消耗 Claude 订阅额度，Anthropic 曾公布的独立 credit 方案处于暂停状态（政策可能变化，以[官方说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)为准）；用 API key 或第三方网关时，费用与限额由对应平台决定。

## 快速开始

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile

node --version && which claude && claude auth status
npm install --omit=dev
npm run setup                    # 生成 AUTH_TOKEN，问 WORK_DIR（必须是项目绝对路径）、CLI hooks bridge，macOS 上再问桌面控制台
node scripts/doctor.js
npm start                        # 若 doctor 说 3000 已被桌面端占用，不要再起一个；用菜单里 server 一行的「重启」

# 手机首次从非本机地址连接时批准设备（桌面端也可直接从菜单栏「🔐 N 台新设备等待批准」点准入）
node scripts/device.js list
node scripts/device.js approve <ID>
```

启动日志会打印带 token 的局域网地址，在手机上打开即可。完整的首次安装、非交互 setup、可复制的编程 agent 安装提示、PWA 和 bridge 配置见[首次使用指南](docs/getting-started.md)。

## 运行方式

| 方式 | 适合 | 注意事项 |
|---|---|---|
| 同 WiFi：`http://<lan-ip>:3000/#token=…` | 家中或办公室局域网 | 最省事，离开当前网络后不可用 |
| 临时公网：`cloudflared tunnel --url http://localhost:3000` | 试用、演示 | 随机域名会变化；没有 Access，仍需设备审批 |
| 固定公网：固定域名 + Cloudflare Access | 长期随时访问 | 进程用桌面端或保持 `npm start`；隧道见 [部署指南](docs/deployment.md) |

PWA 与 Web Push 需要 HTTPS；iOS Web Push 还要求 iOS 16.4+ 并先「添加到主屏幕」。

## 安全模型

> 这是一个可远程触达、直通本机 shell 的代码执行入口。暴露到公网前，请先理解这些边界。

1. **单用户，权限等同机主。** 项目没有多用户或租户隔离；通过鉴权的操作拥有启动 `claude` 的本机账号权限。
2. **无 token 不出本机。** 未设置 `AUTH_TOKEN` 时只监听 `127.0.0.1`；需要手机或隧道访问时必须设置强 token。
3. **工作目录必须收窄。** `WORK_DIR` / `WORKDIRS` 是文件、会话和 git 操作的范围门。不要为了省事把整个家目录交给远程入口。
4. **自动放行继承 CLI 配置。** `~/.claude/settings.json`、项目 `.claude/settings.json` 和 `.claude/settings.local.json` 中的 `permissions.allow` 会同源生效；公网使用前应审查累积的 Bash/Write 等规则。
5. **设备信任是第二道门。** 除本机直连或已通过 Cloudflare Access JWT 的连接外，合法 token 仍需一次性设备审批；可用 `node scripts/device.js deny <ID>` 吊销。
6. **文件编辑器是用户直写。** 它不经过 Agent 的工具审批链，只允许修改已存在、≤256KB 的文件，并做范围校验、哈希冲突检测和审计记录；设 `FILE_EDIT=off` 可退回只读。

漏洞请通过 [GitHub Security Advisories](SECURITY.md) 私下报告，不要公开提交 issue。

## 文档导航

**装机与运行**

- [首次使用指南](docs/getting-started.md)：从 clone 到手机发出第一条消息。
- [部署与运维](docs/deployment.md)：两条启动入口、Cloudflare Tunnel 与 Access。
- **配置项说明**：`node scripts/config.js schema` —— 全部配置项、类型与默认值，由 schema 生成，永不与代码分叉。
- [安全策略](SECURITY.md)：漏洞报告方式。

**理解与参与**（维护者）

- [架构说明](docs/architecture.md)：Web/CLI 双通道、事件信封与接管边界。
- [硬性规则与技术债](docs/hard-rules.md)：n=1 取舍、架构不变量、已决「不做」项。
- [展示契约](docs/display-contracts.md)：模型、思考强度和状态栏的事实源。

**生成物**

- [仓库地图](docs/repository-map.md)：`npm run inventory:update` 产出的全文件清单，供 `inventory:check` 门禁拒绝未分类文件。人类通常不需要读它。

## 许可证

[GNU AGPL-3.0-only](LICENSE) © 2026 Ike-li，附带 Section 7 补充条款；见 [NOTICE](NOTICE)。

你可以使用、研究、修改并自托管本软件。若把修改后的版本作为网络服务对外提供，AGPL 要求开放对应源代码；补充条款还要求保留原作者署名、不得歪曲项目来源。

## 友链

- [LINUX DO](https://linux.do/)
