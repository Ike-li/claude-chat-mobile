# Claude Chat Mobile

<p align="center">
  <strong>电脑上的 Claude Code，出门用手机接着干。</strong><br>
  审批 · 提问 · 续接会话 · 控制面留在你自己的机器上
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="https://ike-li.github.io/claude-chat-mobile/">网站</a> ·
  <a href="https://ike-li.github.io/claude-chat-mobile/diagrams/">架构图集</a><br>
  <a href="https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml"><img src="https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20">
</p>

![把终端里的 claude 接到手机上](https://ike-li.github.io/claude-chat-mobile/assets/hero-zh.jpg)

![主页、工作区列表与会话侧栏](https://ike-li.github.io/claude-chat-mobile/screenshots/02-home.webp)

## 终端里的哪些事，手机上也能做

离开电脑时最怕的不是看不到输出，是**它停在某个需要你的地方，白等一晚上**。所以先说这三件：

| 终端里 | 手机上 |
| --- | --- |
| **工具审批**（按 y / n） | 弹审批卡：允许 / 拒绝 / **中止本轮**（对齐 `Esc`）。可勾「总是允许」，并选仅本会话或永久 |
| **它问你问题**（`AskUserQuestion`） | 选项直接点。多选、「其他…」自己填、「跳过并中止本轮」都在 |
| **跑完了？还是卡住了？** | 推到锁屏。审批、提问、后台任务完成**无条件推**，不看你在不在前台 |

剩下的是「接着干活」：

| 终端里 | 手机上 |
| --- | --- |
| `claude` 起新会话 / `--resume` 翻历史 | 顶栏 `+` 新建，选工作区、分支、要不要开在新 worktree；侧栏列出该工作区全部会话，标题自动生成、可搜索、在跑的标「运行中」 |
| `Esc` 打断 | 底栏停止键 |
| `/model`、权限档、思考强度 | 底栏 chip 点开就改，下一条起效；权限六档齐全 |
| `@` 引用文件 | 输入 `@` 搜工作区文件，点选插入路径 |
| `/` 斜杠命令 | 输入 `/` 列候选，含你装的 skills |
| 看它到底改了什么 | 工具卡点开预览变更；回合末尾有文件变更汇总（± 行数） |
| `git diff` 扫一眼 | 工作区面板的「改动」页 |
| 回退重来 / 另开一支 | 长按消息：**回退**连工作区文件一起恢复到发出那条之前，并分叉出一个回到那一刻的新会话；**分叉**只复制对话、不动文件。原会话两种都保留 |
| 瞄一眼 statusline | 底栏常驻摘要。展开看模型 / 分支 / ctx 占用 / **5h 与 7d 额度用量和重置倒计时** / 预估花费，一键复制 |
| 盯后台任务 | 任务横幅，可单独停掉某一个 |
| **终端里开着的那个会话** | 能看，也能接着驾驶——同一时刻只有一个驾驶端，接管时会提示 |

<p align="center">
  <img src="https://ike-li.github.io/claude-chat-mobile/screenshots/03-coding.webp" width="49%" alt="在手机上拍板、改测试、跑到全绿">
  <img src="https://ike-li.github.io/claude-chat-mobile/screenshots/04-usage.webp" width="49%" alt="statusline 展开后的额度用量，以及同时在跑的后台任务">
</p>

![输入 @ 搜工作区文件，输入 / 列出斜杠命令](https://ike-li.github.io/claude-chat-mobile/screenshots/06-files.webp)

另外：上传图片与粘贴截图、断线重连补齐事件、PWA 装到主屏幕、`doctor` 启动自检，macOS 还有桌面控制台。

## 和官方 Remote Control 差在哪

**能用官方 [Remote Control](https://code.claude.com/docs/en/remote-control)、也接受它的账号与数据路径时，用官方**——零部署，是默认推荐。这个项目是给官方路径进不去、或不接受其控制面的人做的：前者典型是在 `claude` CLI 里接了中转、第三方模型、国产模型，官方那扇门直接关着；后者典型是要把会话记录和审计留在自己机器上。

|  | 官方 Remote Control | Claude Chat Mobile |
| --- | --- | --- |
| **模型通路** | 需 claude.ai 订阅登录 + 直连 `api.anthropic.com`。API key、Bedrock / Google Agent Platform / Microsoft Foundry、指向别处的 `ANTHROPIC_BASE_URL`、`DISABLE_TELEMETRY` 一类遥测开关、ZDR 合规组织——命中任一条即整条不可用 | 你的 `claude` CLI 怎么配就怎么用——第三方网关 / API key / Bedrock / Vertex / 关了遥测，都行 |
| **控制面数据** | 会话 transcript 存到 Anthropic 服务器做跨设备同步 | 服务、transcript、设备信任、审计全在你机器上，局域网内可完全闭环 |
| **能看见什么** | 只有显式开过 Remote Control 的会话（或开了 auto-connect 之后新起的）；`/resume` 是终端专属命令，手机上翻不到历史会话 | 放行工作区里的**全部**会话——终端开的、上周的、忘了开开关的，都可见可续 |
| **两端同时驾驶同一会话** | 可以，终端 / 网页 / 手机随便发 | **做不到**——单驾驶员模型，Web 接管要显式续接且可能分叉 |
| **部署成本** | 零 | 自己跑一个 server |

![会话设置里直接切到第三方网关的模型](https://ike-li.github.io/claude-chat-mobile/screenshots/05-gateways.webp)

> 措辞边界：这不等于「数据绝不离开本机」——模型请求本来就由本机 `claude` CLI 按你现有配置发出。CCM 承诺的是**除此之外**不再多一条数据出口。

CCM 对部署位置没有假设：`claude` CLI 在哪台机器上能跑通，控制面就跟到哪。主场景是自己的开发机；跑在一台远程服务器上同样成立，手机连的就是那台服务器。

## 三步跑起来

需要 Node ≥ 20 和本机已经能用的 `claude` CLI。项目**不会**替你安装或登录 Claude。

```bash
curl -fsSL https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz | tar xz
cd claude-chat-mobile-master
npm ci --omit=dev && npm run setup && npm start
```

手机打开终端打印的地址即可。首次从新设备进来要批准一次：`node scripts/device.js list` 再 `approve <ID>`。手输 64 位 token 很痛苦，`node scripts/qr.js` 能把地址打成二维码扫一下。

![登录与新设备准入：新设备等待授权，在已登录的设备上点「准入」即可](https://ike-li.github.io/claude-chat-mobile/screenshots/01-login.webp)

> **起服 ≠ 能聊天。** CCM 的令牌 / 设备审批只决定手机能不能进主壳；**主机终端里的 `claude` 能不能正常跑完一轮会话**，才决定手机上能不能真对话。官方订阅要本机已 `/login`；第三方网关不走 Anthropic 登录、**不会**出现 `Not logged in`，它要的是 `ANTHROPIC_*` 真的生效。手机上收到 CLI 透传的具体报错反而是好消息——说明这条链路本身是通的。两种情况收敛到同一个动作：**先在主机终端把 `claude` 聊通一轮，再从手机重试**。验收清单见 [首次使用指南 §8](docs/getting-started.md#8-完成首次验收)。

要改代码或跑测试请 `git clone` 完整仓库。配置、非交互 setup、PWA、CLI hooks、**更新方式**：**→ [首次使用指南](docs/getting-started.md)**

## 它是怎么工作的

```text
手机 PWA / 浏览器 ↕ Socket.io ↕ CCM Server（本机） ↕ Claude Agent SDK ↕ 本机 claude CLI
```

手机只是**远程控制面**。真正执行代码、读项目、调工具、维护会话的仍然是你电脑上的 Claude Code——没有数据库、没有多租户、没有 SaaS 后端。

**一个要知道的边界**：同一个实时会话同一时刻只有一个驾驶端。终端正在驾驶时 Web 默认只读，可以显式续接但可能产生会话分叉——两端不会同时向同一个 Claude 进程输入。

双通道、事件同步、会话接管：**→ [架构说明](docs/architecture.md)**

## 远程访问

| 场景 | 方式 |
| --- | --- |
| 同一 Wi-Fi | 局域网地址，最简单的首次使用 |
| 临时公网 | Cloudflare Quick Tunnel、ngrok 等托管隧道 |
| 长期公网 | 固定域名 + Cloudflare Tunnel + Access |
| 不经 Cloudflare | Tailscale（推荐，自带 HTTPS）、其他加密隧道 / VPN、自建反向代理 |

装机向导会问你打算怎么从手机访问，答案写进 `ACCESS_PROFILE`，`doctor` 与手机端安全体检据此做针对性检查。产品不安装任何第三方隧道工具，只指路。PWA 和 Web Push 需要 HTTPS（iOS 还要 16.4+ 并先加到主屏幕）。

![设置与状态、接入设备管理、通知开关与锁屏推送](https://ike-li.github.io/claude-chat-mobile/screenshots/07-settings.webp)

**→ [部署与运维](docs/deployment.md)**

## 安全边界

> **这是一个可以远程触达本机 Claude Code、并间接获得本机代码执行能力的入口。** 请把它当开发机远程控制工具，不是普通网页。

1. **单用户。** 没有多用户或租户隔离，鉴权通过后的权限就是运行 `claude` 的本机账号的权限。
2. **没有 Token 就不启动。** `AUTH_TOKEN` 是启动前提，任何绑定模式都一样——本机浏览器打开也要令牌，不存在「本地免鉴权」。
3. **工作区显式放行。** 文件、会话和相关操作只能进入配置的 `WORKDIRS`。别为了方便把整个 Home 目录加进去。
4. **新设备需要信任。** 除本机直连或已通过公网身份层（当前为 Cloudflare Access）外，持正确 Token 的新设备仍需一次审批。注意：**开着 Access 时它替代设备审批**，那张信任表管不到经它进来的连接；想让审批对所有路径生效，设 `DEVICE_APPROVAL_SCOPE=all`。
5. **继承 Claude Code 权限。** `permissions.allow` 等已有规则继续生效，公网使用前应检查 Bash、Write 的自动放行规则。
6. **文件编辑属于直接写入。** 内置编辑器**不经过 Agent 的工具审批链**（有范围校验、大小限制、哈希冲突检测和审计），`FILE_EDIT=off` 可关闭，长期公网暴露建议关闭。

![服务状态、安全事件时间线与手机端安全体检](https://ike-li.github.io/claude-chat-mobile/screenshots/08-ops.webp)

长期暴露到公网前请先读 [部署与运维](docs/deployment.md)。漏洞请走 [GitHub Security Advisories](SECURITY.md) 私下报告，不要公开提 Issue。

## 文档

* **[首次使用指南](docs/getting-started.md)** · [Getting Started (EN)](docs/getting-started.en.md) —— 装机到手机发出第一条消息、配置、更新、命令速查
* **[部署与运维](docs/deployment.md)** —— 局域网到长期公网、Cloudflare Tunnel / Access、不经 Cloudflare 的替代入口
* **[架构说明](docs/architecture.md)** · [Architecture (EN)](docs/architecture.en.md) · [架构图集](https://ike-li.github.io/claude-chat-mobile/diagrams/)
* [硬性规则与技术债](docs/hard-rules.md) · [展示契约](docs/display-contracts.md) · [安全策略](SECURITY.md)

配置项和命令都不维护静态列表：`node scripts/config.js schema` 打印当前配置定义，每条 CLI 不带子命令就打印自己的用法。

## 交流与反馈

Bug 与功能请求走 [GitHub Issues](https://github.com/Ike-li/claude-chat-mobile/issues)，安全漏洞走 [Security Advisories](SECURITY.md)。使用交流 QQ 群 **881200369**（[点击加入](https://qm.qq.com/q/9Bv2ZaSAUw)）。

> ⚠️ 群里不要贴 `AUTH_TOKEN`、公网域名、完整的 `ccm.config.json` 或原始 `doctor` 输出——这些足以让人接管你的机器，而群聊历史对所有成员可见。

## License

[Apache-2.0](LICENSE) © 2026 Ike-li，另见 [NOTICE](NOTICE)。你可以自由使用、研究、修改、自托管和再分发，包括商业用途与闭源产品；再分发时需满足 Apache-2.0 第 4 节的条件（保留版权声明与 NOTICE 归属、随附许可证副本、在改动过的文件上标注变更等），完整条款以 [LICENSE](LICENSE) 为准。v1.10.2 及之前的版本按 AGPL-3.0-only 发布，换协议不追溯。

友链：[LINUX DO](https://linux.do/)
