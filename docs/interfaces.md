# 接口参考 · Interface Reference

本项目所有对外接口与内部模块 API 的地图。定位与既有文档的分工：

- **出向事件**（`agent:event` 24 类 `type`）的可执行事实源是 [event-contract.md](event-contract.md) + `scripts/agent-event-contract.js`（`npm run contract:check` 机械校验）。本文只做引用与信封说明，不重复 24 类明细。
- **架构与需求**背景见 [design.md](design.md)（§"一条消息的旅程"给出事件流全景）。
- 本文覆盖 event-contract 之外的部分：**HTTP 端点、入向 Socket 事件、内部模块 API**。

---

## 一、运行时对外接口

### 1. 传输与鉴权

前端单页（`public/`）与 server 之间：**主通道 = Socket.IO**（双向事件），另有 4 个 HTTP 端点服务健康检查、推送订阅与脚本分发。三层鉴权（详见 [design.md](design.md) §4）：

1. **`AUTH_TOKEN`** — 未设置时 server 只绑 `127.0.0.1`；设置后 HTTP（`httpAuth`）与 Socket 握手都需带 token（`?token=` / `x-auth-token` 头 / 握手 auth）。
2. **TOFU 设备信赖** — 非本机、非 CF Access 的连接须先在宿主机一次性授权设备指纹（`user:approveDevice`）。
3. **Cloudflare Access JWT**（可选纵深防御） — 经隧道的公网请求（`Host = CF_ACCESS_HOSTNAME`）强制带合法 Access JWT，见 `cf-access.js`。

### 2. HTTP 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | `httpAuth` | 健康检查，返回 `{status:'ok', sessionId, busy, versions, timestamp}` |
| GET | `/push/vapid-public-key` | `httpAuth` | 取 Web Push 的 VAPID 公钥（前端订阅用） |
| POST | `/push/subscribe` | `httpAuth` | 提交浏览器 Push subscription（`express.json`，限 4kb） |
| GET | `/js/app.js` | 无 | 前端主脚本分发（静态资源；其余静态文件走 `express.static`） |

> 历史数据不走无鉴权 HTTP，一律经鉴权的 `session:history` Socket 事件（取代早期的 `GET /sessions/:id/history`）。

### 3. Socket.IO 出向（服务端 → 客户端）

所有服务端主动下发**只有一个事件名 `agent:event`**，统一信封：

```js
{ seq, epoch, sessionId, instanceId, cwd, ts, type, payload }
```

- `seq` 单调递增（进 500 条环形缓冲，供 `sync:since` 断线补发）；`epoch` 变化 = 服务端换了实例，客户端据此重置去重基线。
- `type` 为 **24 类之一**（`text_delta` / `tool_use` / `permission_request` / `question` / `result` / `status_line` / `task_progress` / `task_notification` / `init` / `instances` / `models` / … 完整清单与契约见 [event-contract.md](event-contract.md)）。
- 前端按 `viewingInstanceId` 分流；后台 tab 的高频 delta 不广播以省带宽。

### 4. Socket.IO 入向（客户端 → 服务端）

注册于 `server.js`（`on(socket, 'event', handler)` 统一闸，含设备信赖校验）。带 `ack` 的事件通过回调返回数据。`instanceId` 省略时默认作用于当前查看实例（`viewingInstanceId`）。

**会话内操作 `user:*`**

| 事件 | payload | 说明 |
|---|---|---|
| `user:message` | `{text, attachments?, model?, instanceId?, cwd?}`（或纯 string） | 发消息。校验非空、`text ≤ 50000`、附件条数/大小；无可路由实例则懒开一个 |
| `user:approve` | `{requestId, decision:'allow'\|'deny', alwaysThisSession?, instanceId?}` | 审批挂起的 `permission_request` |
| `user:answer` | `{requestId, optionIndex, instanceId?}` | 回答 `AskUserQuestion` 的 `question` |
| `user:interrupt` | `{instanceId?}` | 中断当前轮（不毁会话） |
| `user:setPermissionMode` | `{mode, instanceId?}` | 切权限档：`default`/`plan`/`acceptEdits`/`bypassPermissions`/`dontAsk` |
| `user:setEffort` | `{level, instanceId?}` | 切思考强度（`level` 为模型支持档位或 `null`=模型默认）；置换实例，busy 时拒切 |
| `user:setWorkdir` | `{cwd}` | 切工作区（白名单校验，防穿越） |
| `user:setViewing` | `{instanceId}` | 切当前查看 tab |
| `user:approveDevice` | `{deviceId}` | 远程批准待信任设备（仅对确在待审批列表的 token 生效） |
| `user:denyDevice` | `{deviceId}` | 远程拒绝/移除设备 |

**会话与 tab 管理 `session:*`**（均带 `ack`）

| 事件 | payload | ack 返回 |
|---|---|---|
| `session:new` | `{cwd?}` | `{ok, instanceId:null, sessionId:null}`（清 cwd 指针，首条消息懒开 FRESH 会话） |
| `session:switch` | `{sessionId, cwd?}` | `{ok, instanceId, sessionId}` 或 `{ok:false, error}`（按 jsonl 文件存在性裁决归属，接纳终端建的会话） |
| `session:close` | `{instanceId}` | `{ok, viewingInstanceId}` 或 `{ok:false, error}`（dispose 实例，会话留盘可再开） |
| `session:list` | `{cwd?, all?}` | `{currentSessionId, sessions[], hasMore}`（默认截断 `sessionLimit`，`all:true` 用硬顶 50） |
| `session:history` | `{sessionId, cwd?}` | `{messages[]}` 或 `{messages:[], error}`（E14 历史回显） |

**同步 / 日志 / 元数据 / 开发**（均带 `ack`）

| 事件 | payload | ack 返回 |
|---|---|---|
| `sync:since` | `{sessionId, lastSeq, instanceId?}` | `{replayed, gap, found, pending}`（断线重连补发环形缓冲；`found:false`=实例已没了→客户端清屏重载历史） |
| `logs:get` | `{instanceId?}` | `{logs[]}`（该实例的交互日志，需 `LOG_INTERACTIONS=1`） |
| `models:get` | `{}` | `{models[]}`（当前查看 cwd 的可用模型清单，未知工作区返回空） |
| `dev:restart` | `{}` | `{ok}` 或 `{ok:false, error}`（**仅 `DEV_MODE=1`**：优雅退出，靠 KeepAlive 自动拉起） |
| `disconnect` | — | 系统事件；**不动 agent**（任务独立于连接存活） |

---

## 二、内部模块 API

根级 ESM 模块（`export`）。签名以参数名示意，`?` 表可选。

### `agent.js` — `class AgentSession`

一个会话 = 一个长驻 SDK query（streaming input 模式），SDK 消息 → `agent:event` 统一信封。由 `server.js` 编排调用，主要公开方法：

| 方法 | 说明 |
|---|---|
| `constructor({instanceId, resumeId, cwd, claudeBin, model, permissionMode, effort, idleTimeoutMs, onEvent, onSessionId, onExit, onUsage, onBgTaskChange, historicalCostUsd})` | 构造会话（未 `start` 不 spawn） |
| `start()` | 启动 SDK query 流；`fetchModels()` 推 `models` |
| `send(text, model?, opts?)` | 发一轮消息（`opts.displayText`/`opts.attachments` 用于附件旅程） |
| `interrupt()` | 中断当前轮 |
| `setPermissionMode(mode)` | 切权限档（返回是否成功） |
| `resolvePermission(requestId, decision, alwaysThisSession)` | 解挂 `permission_request` |
| `resolveQuestion(requestId, optionIndex)` | 解挂 `question` |
| `eventsSince(lastSeq)` | 取环形缓冲增量 `{events, gap}`（供 `sync:since`） |
| `pendingRequestsSnapshot()` | 当前未决审批/提问快照（状态对账用） |
| `bgTaskSummary()` / `hasBgTasks()` | 子 agent 后台任务摘要 / 是否有 |
| `dispose()` | 杀进程、deny 挂起审批、释放资源 |

> `emit`/`emitTransient`/`map`/`consume` 等为内部事件机制，非编排入口。

### `server.js`

`export { httpServer, io, port }` — 仅供集成测试注入（`test/integration/`）。

### `history.js` — CLI 会话历史读取（事实源 `~/.claude/projects/<project>/<id>.jsonl`）

`HISTORY_MAX_MESSAGES` · `getProjectDir(cwd)` · `getSessionHistory(sessionId, cwd, limit?)` · `catchUpStep(state, …)`（只读追平增量） · `listSessionsPage(cwd, opts)` · `listSessions(cwd, opts?)` · `invalidateListCache(cwd)` · `sessionFileExists(cwd, id)`

### `sessions.js` — 服务端唯一持久状态（会话元数据，单 JSON 原子写；永不存消息内容）

`flushSaveSync()` · `getState()` · `getCurrent(cwd)` · `setCurrent(cwd, sessionId)` · `upsertSession(…)` · `getSession(id)` · `updateSessionCost(id, cost)` · `updateSessionPrefs(id, prefs)`

### `workdirs.js` — 多工作区白名单（解析 / 校验 / 归一）

`DEFAULT_SESSION_LIMIT`（6） · `MAX_SESSION_LIMIT`（50） · `normalizeWorkdirEntries(parsed)` · `loadWorkdirsFile(filePath)` · `resolveWorkdirs(entries)`

### `uploads.js` — 附件落盘 + 路径注入 + 防穿越（E17）

`UPLOAD_DIR`（`.ccm-uploads`） · `sanitizeName(name)` · `validateAttachments(attachments)` · `saveAttachments(workDir, attachments)` · `buildPromptText(text, saved)` · `toEventMeta(saved)`

### `devices.js` — 受信任 / 待确认设备指纹

`loadTrustedDevices()` · `saveTrustedDevices()` · `loadPendingDevices()` · `savePendingDevices()` · `isDeviceTrusted(deviceToken)` · `addPendingDevice(deviceToken, info)` · `removePendingDevice(deviceToken)` · `getPendingDevices()` · `getLatestPendingDevice()` · `approveDevice(deviceToken)` · `denyDevice(deviceToken)`

### `statusline.js` — web 自有状态栏（E16，自包含、不读 `~/.claude/settings.json`）

`parseShortstat(str)` · `parseRepo(url)` · `gitStatus(cwd)` · `webContextCost(…)` · `buildWebStatusLine(…)`（组装 `status_line` payload）

### `notifications.js` — 事件 → 离线 web-push 文案的纯映射

`notificationForEvent(type, payload)` → `{title, body}`（应推）或 `null`（不推）

### `models-cache.js` — 按 cwd 归键的可用模型清单缓存

`createModelsCache(…)` · `isCwdDefaultModel(…)`

### `interaction-log.js` — 可选交互日志（`LOG_INTERACTIONS=1`）

`enabled` · `setCallback(cb)` · `getSessionLogs(sessionId)` · `addSessionLog(sessionId, type, text, meta)` · `userMessageIn(…)` · `userMessageOut(…)` · `agentSend(…)` · `agentResult(…)` · `textDelta(sessionId, delta)`

### `cf-access.js` — Cloudflare Access JWT 校验（纵深防御）

`initCfAccess()` · `isAccessEnabled()` · `isPublicHost(host)` · `verifyAccessJwt(token)`

### `file-security.js` — 文件安全守卫（symlink 穿越防御 + owner-only 权限）

`rejectableSymlinkComponent(path)` · `isOwnerOnly(path, isDir?)` · `fixPermissions(path, isDir?)` · `writeOwnerOnlyFile(path, content)` · `checkPermissions(paths, isDir?)`

### `sanitizer.js` — 日志脱敏（15 种敏感模式，含 Anthropic key）

`stripControlSequences(text)` · `sanitize(text)` · `maskToken(token)` · `sanitizePath(path)`

---

## 三、事实源与校验

| 层 | 事实源 | 机械校验 |
|---|---|---|
| 出向 `agent:event` 类型 | `scripts/agent-event-contract.js`（24 类 allowlist） | `npm run contract:check`（零 token 静态，校验 real ⊇ mock） |
| 文档链接 / npm 脚本名 / SDK 版本 | `scripts/doc-consistency.js` | `npm run check`（含本文件的死链扫描） |

本文件是人类可读地图；协议真相以上表的可执行事实源为准，两者漂移由 `npm run check` + `npm run contract:check` 拦截。
