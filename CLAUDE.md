# 项目概述

移动端聊天式 Web UI，把**本机 claude CLI** 投送到手机——目标是终端等价性："坐在电脑前对 claude 打字"和"在手机上打字"效果一样。v2 为绿地重写。**规格源在 `docs/`**，改代码前先确认与规格一致；规格要变，先改文档再改代码。**Git**：单人 n=1 本地工具，直接在 `main` 提交、不开特性分支。

## 文档导航

| 要找什么 | 去哪里 |
|----------|--------|
| 产品需求、终端等价性清单、安全模型、验收剧本 | `docs/design.md` |
| 前后端事件契约 | `docs/event-contract.md` |
| 架构决策记录（ADR 001-018） | `docs/decisions.md` |
| 环境变量完整参考 | `docs/configuration.md` |
| 生产部署 | `docs/deployment.md` |
| 架构导览、后端文件表、消息旅程 | `README.md` |
| 架构深度解析（设计哲学、安全纵深、并发模型、AgentSession 内部机制） | `docs/architecture.md` |

## 常用命令

> ⚠️ **生产部署 = 常驻服务**（macOS LaunchAgent / Linux systemd 占着 3000 端口，固定公网域名 + Cloudflare Access 2FA）：**勿手动 `npm start`**（会撞端口）；改 `.env`/代码后须**重启常驻 server 进程**才生效。

```bash
npm start          # node server.js（默认端口 3000）
npm run dev        # node --watch server.js
npm test           # node --test test/*.test.mjs：纯逻辑单测（devices/logic，零 token）
npm run test:visual # puppeteer 移动端视觉回归 E2E（零外部依赖 mock server）

# 启动前自检配置
node scripts/doctor.js              # 检查 AUTH_TOKEN/CLAUDE_BIN/WORK_DIR(S)/PORT/settings.json/ANTHROPIC_*
node scripts/doctor.js --env=prod.env  # 指定 .env 文件

# 设备指纹审批与管理（ADR-018 纵深防御）
node scripts/device.js list         # 列出所有受信任和等待确认的设备
node scripts/device.js approve <ID> # 批准指定设备 ID
node scripts/device.js deny <ID>    # 拒绝/删除指定设备 ID

# 冒烟验收（真实调用 claude 消耗 token）
# ⚠️ e2e 前先备份会话指针：cp data/sessions.json data/sessions.json.bak && rm data/sessions.json
AUTH_TOKEN='' PORT=3100 WORK_DIR=/tmp/ccm-test node server.js   # 终端 1：测试 server
node scripts/smoke.js              # 终端 2：M1 行走骨架（A1/A2/A4/A6/A9 + 会话切换）
node scripts/smoke.js --phase2     # 重启终端 1 后：跨重启 resume
```

健康检查：`GET /health` → `{status, sessionId, busy, versions, timestamp}`（设了 `AUTH_TOKEN` 时需带 `?token=` 或 `x-auth-token` 头，否则 401）。历史回显走鉴权的 `session:history` socket 事件，不开无鉴权 HTTP 数据端点。

## 架构（必须知道的核心概念）

> 深度参考：[docs/architecture.md](docs/architecture.md)（设计哲学、安全纵深、并发模型、AgentSession 内部机制）

1. **每个会话/tab = 一个长驻 SDK query**（`agent.js` 的 `AgentSession`，streaming input 模式）。`server.js` 维护 `agents: Map<instanceId, AgentSession>`——并发单位 = 「逻辑会话/tab」，每实例有进程内唯一的 `instanceId`（`inst_${n}`），同 cwd 也可多会话后台并行。`viewingInstanceId`=前端当前查看 tab，切 tab 只换视图不 dispose 实例。实例创建：`session:switch`/启动预热显式 open；`session:new` 首条消息才懒开 FRESH 实例。`session:switch` 对已 live 会话聚焦不重开（`instanceForSession` 去重）。权限档/effort 每 tab 独立；新会话(FRESH)用 CLI 启动默认档、resume 继承该 cwd 末实例档。事件信封 `instanceId` 字段是前端分流的权威锚点。详见 ADR-010。

2. **权限两层闸门**（ADR-003）：`.claude/settings.json` 的 `permissions.allow`（与终端同源）自动放行；放行外 → `canUseTool` → `permission_request` 事件 → 手机弹窗审批。审批等待不超时；静默看护（`IDLE_TIMEOUT_MS`）在等审批时暂停。**5 档权限模式**（ADR-012）：default/plan/acceptEdits/bypassPermissions/dontAsk；`dontAsk`=白名单外直接 deny、不弹窗；`bypassPermissions` 由 `handleCanUseTool` 自放行（**不用** `allowDangerouslySkipPermissions`——它是全局 skip、会废掉 default 审批）。

3. **三个 SDK 陷阱**（都已显式处理，勿简化）：`settingSources` 必须 `['user','project','local']`；`systemPrompt` 必须显式 `claude_code` preset；必须 `pathToClaudeCodeExecutable` 指向本机 claude（`which claude` / `CLAUDE_BIN`）。

4. **resume 的模型坑**（ADR-005）：CLI resume 把模型恢复为规范化裸名，部分网关只认带后缀名——init 时把 `msg.model` 记入 `data/sessions.json`，resume 时显式回传 `options.model`。

5. **事件信封**：所有服务端→客户端消息走 `agent:event {seq, epoch, sessionId, instanceId, cwd, ts, type, payload}`。`seq` 实例内单调 + 500 条环形缓冲；`epoch` 每实例跨重启唯一，客户端据它识别新流。**广播裁剪**：后台实例的高频 `text_delta`/`thinking_delta` 不进 `io.emit`（仍入环形缓冲供 `sync:since` 回放）。合成事件用 `epoch:'server'`。详见 `docs/event-contract.md`。

## 健壮性约定（勿回退）

- **所有 socket handler 经 `server.js` 的 `on()` 包裹**：任一抛错只回 error，不崩进程。新增 handler 必须走 `on()`。启动期致命错误（EADDRINUSE）fail-fast exit 1。
- **env 规整一次性**：`server.js` 顶部 dotenv 后剥除空串环境变量。同时剥除 `.env` 注入的 `ANTHROPIC_*`（shell 已有的保留）——Anthropic 凭据/网关/模型只能来自终端环境，`.env` 不得造成 web/终端分叉。
- **路径锚定 `import.meta.dirname`**（`HERE`），不用 `process.cwd()`。
- **SIGINT 与 SIGTERM 都走 `shutdown()`**：dispose agent、杀子进程、deny 挂起审批。
- **进程退出/挂死靠 `AgentSession.onExit`**：consume 循环结束后回调 server 置空，下条消息懒重生。
- **interrupt 结果驱动**：`interrupt()` 不直接改 `pendingTurns`（仅丢弃排队消息），在途轮由 SDK 的 result 回收。
- **dispose 后 `consume`/`map` 有 `disposed` 守卫**。
- **前端**：流式用 Text 节点 `appendData` 增量显示，仅在 `result`/`error` 时做唯一一次 Markdown 全量渲染（避免 O(n²)）；Enter 发送须 `!e.isComposing`（中文输入法）。
- **前端移动端重连**：`visibilitychange`(visible)/`online`/`pageshow` 主动 `socket.connect()`。**勿删这些监听**。
- **前端资源版本化**：自写 `/js/` 资源经 `server.js` 动态注入 `?v=<hash>`。**勿回退成无版本静态引用**。
- **模型 select 保留"默认（服务端配置）"空选项**：发送时空选择回退会话原模型，不调 `setModel(undefined)`。
- **session id 字符集守卫正则 `^[0-9a-zA-Z_-]+$`** 勿删——挡路径穿越。
- **plan 档在部分网关下退化为 default**：plan「不执行」依赖模型主动 ExitPlanMode + SDK 强制，网关不生效时勿指望其拦截。

## 环境变量

`server.js` 顶部加载 `.env`。dotenv 不覆盖 shell 已有变量；空串值被过滤（= 未设置）；`.env` 注入的 `ANTHROPIC_*` 启动期剥除（shell 已有的保留）。

完整变量清单与默认值见 [`docs/configuration.md`](docs/configuration.md)（**唯一参考**）。AI 高频红线（不复述清单）：`AUTH_TOKEN` 未设→仅监听 127.0.0.1；`ANTHROPIC_*` 不经 `.env`、只从启动 shell export。
