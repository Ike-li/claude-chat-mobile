# 决策合集（ADR 单文件）

> 本文是原 `docs/adr/0001…0018` 18 个独立 ADR 文件的合并：单人本地工具，一个决策一个文件属仪式过重，收成此一处。每节以原 ADR 编号作裸标题、锚点 `#adr-000X`——故散落在代码注释/文档里的 `ADR-NN` 提及仍然有效。**只记「决定了什么」**，推翻条件等冗余已按 n=1 实际删除。产品需求与终端等价性 E# 清单见 [design.md](design.md)，前后端事件契约见 [event-contract.md](event-contract.md)，验收剧本见 [design.md §5 验收](design.md#5-验收)。
>
> **本质**：把「坐在电脑前对着 claude CLI 打字」变成「在手机上打字」，效果一样——web 端与终端 claude code CLI 等价，session 双向可见互续。本项目本质 = 一条把本机 shell 暴露到公网的代码执行通道，安全是 P0 的 P0。

## ADR-0001
**Agent 运行时 = claude CLI，集成面 = Claude Agent SDK.** 用 `@anthropic-ai/claude-agent-sdk` 驱动本机 claude CLI——同一集成面给出审批回调、`interrupt()`、结构化消息对象与 session 管理；中间层不加工命令。

## ADR-0002
**web 会话语义 = claude 原生 session.** 服务端不维护任何对话内容副本；会话事实源 = CLI 的 JSONL。

## ADR-0003
**权限两层闸门.** 与终端 claude 同源、用户自管：命中 `.claude/settings.json` 的 `permissions.allow` 自动放行，放行外触发 `canUseTool` → 审批弹窗。

## ADR-0004
**完整加载本机 claude CLI 配置.** 加载本机完整配置（hooks/skills/MCP/CLAUDE.md）正是产品价值——你远程操作的就是「你的 Claude Code」。SDK 配置须显式保留全部 setting sources；此条防任何「启动性能优化」顺手关掉它。

## ADR-0005
**持久化 = 单 JSON 文件.** 服务端唯一持久状态 = `data/sessions.json`（会话指针 + 网关后缀模型名缓存），原子写、只存元数据、**永不存消息内容**。跨重启靠它恢复列表 + resume。resume 坑：CLI 会把模型恢复为规范化裸名，部分网关只认带后缀名——init 时把 `msg.model` 记入 `sessions.json`、resume 时显式回传 `options.model`。

## ADR-0006
**技术栈与前端自托管.** 纯 JS / ESM / 零构建；前端第三方库本地自托管（vendored 到 `public/vendor/`），减少手机网络连不上 CDN 的问题。

## ADR-0007
**实时通道 = Socket.IO.** 自动重连 + 断线检测开箱即用；统一事件信封见 [event-contract.md](event-contract.md)。

## ADR-0008
**斜杠命令透传.** `init.slash_commands` 列出的命令直接发送即执行；不可透传的（TUI 面板类）由前端拦截、用 app UI 或自然语言替代，不复刻终端面板。

## ADR-0009
**推送触达 = Web Push（VAPID）.** Service Worker + Push API + VAPID，HTTPS 由 Cloudflare Tunnel 提供、零第三方中继。仅三类触发：`permission_request`、`question` 始终推，`result` 仅在无已连 socket 时推。端点 `GET /push/vapid-public-key`、`POST /push/subscribe`；VAPID 私钥仅 shell env、推送内容无工作区路径。iOS 须 16.4+ 且加到主屏。

## ADR-0010
**多 repo / 同仓库会话并发.** 终端真身 = N 个 tab：`agents: Map<instanceId>`，repo A 任务运行中可在 repo B（甚至同一 repo）开第二会话并行派活、互不打断。`instanceId` = 前端分流权威锚点；cwd 降为分组维度 + `WORK_DIRS` 白名单。

## ADR-0011
**statusLine 投送.** server 用 web 会话自有的 SDK 数据 + 本机 git，在服务端纯 JS 组装结构化状态，经 `status_line` 事件投前端、以 web 原生 UI 渲染。不调 shell 脚本、不读 `.quota-now` 快照、不依赖 `~/.claude/settings.json`，不含账号级配额段（SDK 物理拿不到）。

## ADR-0012
**权限模式（运行时可切）.** CLI `PermissionMode` 6 档（default/acceptEdits/plan/bypassPermissions/dontAsk/auto），运行时经 `q.setPermissionMode` 切换、广播 `permission_mode`。`dontAsk` = 非交互严格档（白名单外直接 deny、不弹窗、与审批流互斥）；`bypassPermissions` 机主已开放（含公网），由 `handleCanUseTool` 自放行、**不用** `allowDangerouslySkipPermissions`（它是全局 skip、会废掉 default 审批）。plan 档在部分网关下退化为 default，不可指望其拦截。**退出 plan（ExitPlanMode 批准）→ 切 `default`**：实测 SDK 的 ExitPlanMode 工具 `checkPermissions` 只回 `{behavior:'ask'}`、**不带 setMode suggestion**（交互式 CLI 的切档由 plan-exit 弹窗用户选档时补，headless/canUseTool 路径无此弹窗），故 `resolvePermission` 对 ExitPlanMode **兜底合成** `{type:'setMode',mode:'default',destination:'session'}`——既回传 `updatedPermissions` 让 SDK 真退出 plan、又 emit `permission_mode` 同步前端图标；缺此兜底则审批后 SDK 仍停 plan、图标停「计划模式」。**SDK 源头对账（防同类 bug）.** 上述兜底治本，drift 自检防复发：SDK init 消息回 `msg.permissionMode`（实际生效档），`map()` 在 init 时与本地 shadow 对账——不一致（bypass 例外，SDK 实为 default）即告警 `[perm-drift]` + 留痕交互日志 + 以 SDK 为准对账，使「我们以为切了、SDK 没应用」这类 bug 每轮 init 自动暴露、前端图标如实反映 SDK 真值。模型同理以 `msg.model` 为权威（ADR-0005）。**effort 无此凭证**：SDK init/result 都不回 effort，`effort_mode` 仅自发回执、事件流无法证明 `--effort` 生效（错值令 CLI spawn 失败兜底；行为级验证 `scripts/smoke-effort.js`）。

## ADR-0013
**文件/图片上传 = 落盘 + Read.** 落盘 `WORK_DIR/.ccm-uploads/` + 路径注入 prompt + claude `Read`——最贴终端等价（把文件丢进项目再让 claude 读）；支持任意文件类型（非图片走 `Read` 文本提取，与 vision 无关）。

## ADR-0014
**运维与安全增强旁路工具组.** doctor 自检、交互日志、日志脱敏、文件安全、启动 token 打印策略。

## ADR-0015
**思考强度投送.** web 选思考强度 = 终端 `/effort` 的同一个 `--effort` flag（low/medium/high/xhigh/max），下一条消息才生效。

## ADR-0016
**结构化配额卡片 — ⛔ 已推翻.** 曾计划把配额渲成结构化进度条卡片（5h/7d/重置倒计时，与 ANSI 行并行第二路），已推翻、回退 [ADR-0011](#adr-0011) 单 ANSI 行 + 一行摘要（手机小屏与折叠 ANSI 行重复占地、数据冗余；生产以 LaunchAgent 跑、终端常没开致卡片最有价值的段常空）。墓碑保留：若 SDK/CLI 原生暴露 rate_limits 可重评。

## ADR-0017
**公网固定入口 + Cloudflare Access 双因素 + 服务端 JWT 纵深.**
1. 登录验人（CF Access 2FA）——挡没票的。
2. server 自己再验一遍 JWT、不准降级用 token——挡绕门卫的、堵后门（`cf-access.js` fail-closed、按 Host 判鉴权）。
3. 局域网/本机仍走 `AUTH_TOKEN`。

## ADR-0018
**TOFU 设备信赖授权.** 设备没见过就先冻结、等已信任设备批准（TOFU）——挡 token 被偷后的陌生机器。未授权连接的所有上行 Socket 事件被拦截丢弃（统一过滤点 fail-closed）；审批权恒属已信任设备，待审批设备无法自批。
