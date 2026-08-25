# Claude Chat Mobile

**把你电脑上的 Claude Code，带到手机上。**

Claude Chat Mobile 是一个**本机自托管的 Claude Code 远程控制台**。它把本机 `claude` CLI 的会话接到手机或浏览器，让你离开电脑后，仍然可以新建或续接会话、查看任务进度、回答问题、审批工具调用和中断任务。

代码、Claude CLI、项目文件以及 CCM / Claude 的本地会话状态仍然运行或保存在**你自己的电脑上**。项目没有数据库、没有多租户、没有 SaaS 后端；模型请求仍由本机 `claude` CLI 按你现有的 Anthropic 官方登录或第三方网关配置发送。

**中文** · [English](README.en.md) · [🌐 网站](https://ike-li.github.io/claude-chat-mobile/)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Agent SDK](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.dependencies%5B%22%40anthropic-ai%2Fclaude-agent-sdk%22%5D&label=Agent%20SDK&color=blue)](https://code.claude.com/docs/en/agent-sdk/overview)
[![tested with claude CLI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.verifiedWith.claudeCli&label=tested%20with%20claude%20CLI&color=blue)](#使用前提)
[![PWA](https://img.shields.io/badge/PWA-installable-blueviolet.svg)](#快速开始)
[![CI](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg)](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml)

![Claude Chat Mobile — 终端里的 claude，手机上也能用](https://ike-li.github.io/claude-chat-mobile/assets/hero-zh.jpg)

## 为什么需要它？

Claude Code 可以在你的电脑上持续执行开发任务，但遇到提问、工具审批或需要人工决策时，通常仍然需要你回到电脑前。

Claude Chat Mobile 把这部分交互带到手机上：

```text
电脑上的 Claude Code 正在工作
        ↓
你离开电脑
        ↓
手机查看进度 / 回答问题 / 审批工具 / 中断任务
        ↓
Claude Code 继续在原来的电脑上运行
```

它的目标不是重新做一个 AI 聊天产品，而是：

> **让你不在电脑前时，仍然可以安全、接近终端等价地操作本机 Claude Code。**

## 适合谁？

如果你已经在使用 Claude Code，并且有下面这些需求，Claude Chat Mobile 比较适合你：

* Claude 跑长任务时不想一直守在电脑前；
* 出门后仍想查看任务进度并继续交互；
* 希望从手机回答 `AskUserQuestion` 或审批工具调用；
* 希望任务完成或需要人工介入时收到通知；
* 希望继续使用原电脑上的项目、Claude CLI 配置和开发环境；
* 希望自己掌控服务和数据，而不是把完整开发环境迁移到第三方 SaaS。

它可能**不适合**这些场景：

* 你只是想在手机上和 Claude 普通聊天；
* 你目前并不使用 Claude Code；
* 你希望注册账号后直接使用，而不想在自己的电脑上运行服务。

## 核心能力

* **远程控制 Claude Code**：新建和续接会话、流式查看输出、回答问题、审批工具、停止任务、切换模型 / 权限档 / effort。
* **会话与工作区**：多个工作区、多个会话，并可续接本机已有 Claude CLI 会话。
* **项目内容交互**：查看工具调用、Edit / Write diff、Read 内容、浏览和编辑授权工作区中的文件，支持上传文件、图片和粘贴截图。
* **通知**：通过 Web Push / ntfy 接收审批、提问和任务结果通知，并可选接入 Claude CLI hooks bridge。
* **断线恢复**：手机网络中断后重新连接，可以补齐缺失的会话事件。
* **本机运维**：提供 `doctor` 启动自检；macOS 还可选安装桌面控制台管理配置、日志、服务和设备审批。
* **PWA**：支持安装到手机主屏幕，并提供完整中英文界面。

## 它是怎么工作的？

```text
手机 PWA / 浏览器
        ↕
     Socket.io
        ↕
Claude Chat Mobile Server
      （本机）
        ↕
 Claude Agent SDK
        ↕
本机 claude CLI
        ↕
项目文件 / Claude 会话
```

手机和浏览器只是**远程控制面**。

真正执行代码、读取项目、调用工具和维护 Claude 会话的仍然是你电脑上的 Claude Code。

### 一个重要的使用边界

同一个实时 Claude 会话同一时刻只有一个驾驶端。

终端正在驾驶时，Web 默认只读；需要时可以从 Web 显式续接，但可能产生会话分叉。终端和 Web 不会同时向同一个实时 Claude 进程输入内容。

完整的组件关系、Web / CLI 双通道、事件同步和会话接管机制见 [架构说明](docs/architecture.md)。

## 使用前提

你需要：

* **Node.js ≥ 20**；
* 本机已经安装并可以正常使用 `claude` CLI；
* 已登录 Claude 官方账号，或已经配置可正常工作的第三方网关；
* 至少一个准备让 Claude Code 操作的项目目录。

> ⚠️ 用第三方网关时有一条容易踩的规则：网关的 `ANTHROPIC_*` 变量**必须来自启动 server 的那个 shell**，写进 `ccm.config.json` 会在启动时被剥除——文件里明明写着，却不生效，也不报错。

平台支持：

| 平台             | 状态   |
| -------------- | ---- |
| macOS          | 一等支持 |
| Linux          | 一等支持 |
| Windows + WSL2 | 推荐路径 |
| 原生 Windows     | 实验性  |

Claude Chat Mobile **不包含 Claude Code，也不会替你安装或登录 Claude CLI**。

## 快速开始

如果 Claude Code 已经可以在你的电脑上正常运行：

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile

node --version
which claude
claude auth status

npm install --omit=dev
npm run setup
node scripts/doctor.js
npm start
```

`npm run setup` 会引导你生成本地配置、设置允许访问的工作区，并可选安装 CLI hooks bridge；macOS 上还可以选择安装桌面控制台。

启动成功后，终端会打印可在手机打开的局域网地址。

首次从其他设备访问时，需要批准该设备：

```bash
node scripts/device.js list
node scripts/device.js approve <ID>
```

然后在手机中打开启动日志给出的地址，即可进入工作区并向 Claude Code 发送第一条消息。

> macOS 桌面端如果已经启动了 server，不要再执行第二个 `npm start`。按照 `doctor` 的提示使用桌面端菜单重启服务即可。

完整的首次安装、配置、非交互 setup、PWA 和 CLI hooks 说明：

**→ [首次使用指南](docs/getting-started.md)**

## 远程访问

Claude Chat Mobile 支持从局域网到长期公网访问的不同方式：

| 场景       | 方式                                | 适合        |
| -------- | --------------------------------- | --------- |
| 同一 Wi-Fi | 局域网地址                             | 最简单的首次使用  |
| 临时公网     | Cloudflare Quick Tunnel           | 临时试用、演示   |
| 长期公网     | 固定域名 + Cloudflare Tunnel + Access | 长期从外部网络访问 |

PWA 和 Web Push 需要 HTTPS；iOS Web Push 还要求 iOS 16.4+，并先将应用添加到主屏幕。

固定域名、Cloudflare Tunnel、Cloudflare Access、长期运行和运维方式：

**→ [部署与运维](docs/deployment.md)**

## 安全边界

> **Claude Chat Mobile 是一个可以远程触达本机 Claude Code，并间接获得本机代码执行能力的入口。**

请把它当作开发机远程控制工具，而不是普通网页。

使用前需要理解这些边界：

1. **单用户。** 项目没有多用户或租户隔离，通过鉴权后的操作权限最终取决于运行 `claude` 的本机账号。
2. **无 Token 不向局域网暴露。** 未设置 `AUTH_TOKEN` 时，服务只监听 `127.0.0.1`。
3. **工作区显式放行。** 文件、会话和相关操作只能进入配置的 `WORK_DIR` / `WORKDIRS`，不要为了方便把整个 Home 目录加入工作区。
4. **新设备需要信任。** 除本机直连或已经通过 Cloudflare Access 的连接外，持有正确 Token 的新设备仍需要一次设备审批。
5. **继承 Claude Code 权限。** `permissions.allow` 等已有 Claude Code 权限规则会继续生效，公网使用前应检查 Bash、Write 等自动放行规则。
6. **文件编辑属于直接写入。** 内置文件编辑器**不经过 Agent 的工具审批链**，只能修改授权工作区内已存在的文件，并做范围校验、大小限制、哈希冲突检测和审计记录；不需要时可以通过 `FILE_EDIT=off` 关闭。

如果计划长期暴露到公网，请先阅读 [部署与运维](docs/deployment.md)。

安全漏洞请通过 [GitHub Security Advisories](SECURITY.md) 私下报告，不要公开提交 Issue。

## 文档

### 我想开始使用

**[首次使用指南](docs/getting-started.md)**
从已经可以运行 Claude Code 的电脑开始，一直到手机成功发出第一条消息；同时包含配置、迁移、PWA 和 CLI hooks 等说明。

**[部署与运维](docs/deployment.md)**
局域网、公网访问、Cloudflare Tunnel、Cloudflare Access、长期运行和日常运维。

配置项不单独维护静态列表，可以直接查看由 schema 生成的当前定义：

```bash
node scripts/config.js schema
```

### 我想了解它是怎么实现的

**[架构说明](docs/architecture.md)**
Web / CLI 双通道、Agent SDK、事件同步、断线恢复和会话接管。

### 我想修改或维护项目

**[硬性规则与技术债](docs/hard-rules.md)**
项目的架构不变量、设计取舍和明确不做的事情。

**[展示契约](docs/display-contracts.md)**
模型、思考强度、状态栏等 UI 信息的事实源和展示规则。

**[仓库地图](docs/repository-map.md)**
代码入口、目录职责和仓库文件结构。

### 安全

**[安全策略](SECURITY.md)**
漏洞报告方式。

## License

[GNU AGPL-3.0-only](LICENSE) © 2026 Ike-li，附带 Section 7 补充条款，详见 [NOTICE](NOTICE)。

你可以使用、研究、修改和自托管本项目。若将修改后的版本作为网络服务向其他用户提供，需要遵守 AGPL 对应的源码提供义务；补充条款同时要求保留原作者署名并不得歪曲项目来源。

## 友链

* [LINUX DO](https://linux.do/)
