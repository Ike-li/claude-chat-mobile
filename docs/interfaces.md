# 接口参考 · Interface Reference

本文件是项目对外接口与内部模块 API 的索引。它和既有文档的分工如下：

- **出向事件**（`agent:event` 26 类 `type`）的可执行事实源是 [event-contract.md](event-contract.md) + `scripts/agent-event-contract.js`（`npm run contract:check` 静态校验）。本文只说明信封与引用关系，不重复 26 类明细。
- **架构与需求**背景见 [design.md](design.md)，README 的"消息流程"小节给出事件流。
- 本文覆盖 event-contract 之外的部分：**HTTP 端点、入向 Socket 事件、内部模块 API**。

---

## 一、运行时对外接口

### 1. 传输与鉴权

前端单页（`public/`）与 server 之间，**主通道是 Socket.IO**（双向事件），另有 4 个鉴权 HTTP 运维/推送端点与静态资源分发。三层鉴权见 [design.md](design.md) §4：

1. **`AUTH_TOKEN`** — 未设置时 server 只绑 `127.0.0.1`；设置后 HTTP（`httpAuth`）与 Socket 握手都需带 token（`?token=` / `x-auth-token` 头 / 握手 auth）。
2. **TOFU 设备信赖** — 非本机、非 CF Access 的连接须先在宿主机一次性授权设备指纹（`user:approveDevice`）。
3. **Cloudflare Access JWT**（可选纵深防御） — 经隧道的公网请求（`Host = CF_ACCESS_HOSTNAME`）强制带合法 Access JWT，见 `src/auth/cf-access.js`。

### 2. HTTP 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | `httpAuth` | 健康检查，返回 `{status:'ok', sessionId, busy, versions, timestamp}` |
| GET | `/metrics` | `httpAuth` | JSON 指标与 StateProbe 投影，返回 `{metrics,state,states,timestamp}` |
| GET | `/push/vapid-public-key` | `httpAuth` | 取 Web Push 的 VAPID 公钥（前端订阅用） |
| POST | `/push/subscribe` | `httpAuth` | 提交浏览器 Push subscription（`express.json`，限 4kb） |
| GET | `/js/app.js` | 无 | 前端兼容主入口分发（其余静态文件走 `express.static`） |

> 历史数据不走无鉴权 HTTP，一律经鉴权的 `session:history` Socket 事件（取代早期的 `GET /sessions/:id/history`）。

### 3. Socket.IO 出向（服务端 → 客户端）

服务端主动下发只用一个事件名：`agent:event`。信封统一：

```js
{ seq, epoch, sessionId, instanceId, cwd, ts, type, payload }
```

- `seq` 单调递增（进 2000 条环形缓冲，供 `sync:since` 断线补发）；`epoch` 变化 = 服务端换了实例，客户端据此重置去重基线。瞬时状态用 `seq:0` 的 transient 事件，不挤占补发缓冲。
- `type` 为 **26 类之一**（`text_delta` / `tool_use` / `permission_request` / `question` / `result` / `status_line` / `task_progress` / `task_notification` / `init` / `instances` / `models` / … 完整清单与契约见 [event-contract.md](event-contract.md)）。
- `status_line.payload.source.kind` 标明该帧唯一事实源：`sdk`（Web 驾驶，含仅 externalDirty、mirror 已解锁）、`cli`（`mirrorReadonly` 终端驾驶且快照新鲜）或 `cli-unavailable`（mirror 锁定期 CLI 应为权威，但快照缺失、过期或校验失败）。CLI 权威时不按字段混入 SDK 陈值；不可用就明确显示未知。`selectStatusOwner` 只看 `mirrorReadonly`，`externalDirty` 不参与（后者只驱动发送前实例置换）。
- `tool_use` 对文件类工具（`Edit` / `Write` / `Read` / `MultiEdit` / `NotebookEdit`）额外附 `file: {path, changeKind}`（`path` 未截断、`changeKind` ∈ `edit` / `write` / `read` / `multiedit` / `notebook`），供前端工具卡片发起 `tool:preview` 重建 diff / 片段（③）。
- 前端按 `viewingInstanceId` 分流；后台 tab 的高频 delta 不广播以省带宽。

### 4. Socket.IO 入向（客户端 → 服务端）

这些事件由 `src/server/app.js` 组合，统一经过 `src/server/socket.js` 的设备信赖闸；文件类事件单列在 `src/server/socket-files.js`。带 `ack` 的事件通过回调返回数据。`instanceId` 省略时默认作用于当前查看实例（`viewingInstanceId`）。

> **事件名的可执行事实源**：`scripts/agent-event-contract.js` 的 `INBOUND_SOCKET_EVENTS`（29 项）。`npm run contract:check` 校验三面对齐：server 注册面 = 契约（双向相等）、前端 emit 面 ⊆ 契约、visual mock 注册面 ⊆ 契约。本表描述各事件的 payload / ack 形状；表中事件名与 allowlist 漂移会被检查拦截。

**会话内操作 `user:*`**

| 事件 | payload | 说明 |
|---|---|---|
| `user:message` | `{text, attachments?, model?, instanceId?, cwd?}`（或纯 string） | 发消息。校验非空、`text ≤ 50000`、附件条数/大小；无可路由实例则懒开一个 |
| `user:approve` | `{requestId, decision:'allow'\|'deny', alwaysThisSession?, instanceId?}` | 审批挂起的 `permission_request` |
| `user:answer` | `{requestId, optionIndex, instanceId?}` | 回答 `AskUserQuestion` 的 `question` |
| `user:interrupt` | `{instanceId?}` | 中断当前轮（不毁会话） |
| `user:setPermissionMode` | `{mode, instanceId?}` | 切权限档：`default`/`plan`/`acceptEdits`/`bypassPermissions`/`dontAsk`/`auto` |
| `user:setEffort` | `{level, instanceId?}` | 切思考强度（`level` 为模型支持档位或 `null`=模型默认）；置换实例，busy 时拒切 |
| `user:setViewing` | `{instanceId}` | 切当前查看 tab |
| `user:approveDevice` | `{deviceId}` | 远程批准待信任设备（仅对确在待审批列表的 token 生效） |
| `user:denyDevice` | `{deviceId}` | 远程拒绝/移除设备 |
| `task:stop` | `{instanceId?, taskId}` | 停止指定后台 task |

**会话与 tab 管理 `session:*`**（均带 `ack`）

| 事件 | payload | ack 返回 |
|---|---|---|
| `session:new` | `{cwd?}` | `{ok, instanceId:null, sessionId:null}`（清 cwd 指针，首条消息懒开 FRESH 会话） |
| `session:home` | `{cwd?}` | `{ok, viewingInstanceId:null}`（回到工作区空首页，不关闭其他实例） |
| `session:switch` | `{sessionId, cwd?}` | `{ok, instanceId, sessionId}` 或 `{ok:false, error}`（按 jsonl 文件存在性裁决归属，接纳终端建的会话） |
| `session:close` | `{instanceId}` | `{ok, viewingInstanceId}` 或 `{ok:false, error}`（dispose 实例，会话留盘可再开） |
| `session:list` | `{cwd?, all?}` | `{currentSessionId, sessions[], hasMore}`（默认截断 `sessionLimit`，`all:true` 用硬顶 50） |
| `session:history` | `{sessionId, cwd?}` | `{messages[]}` 或 `{messages:[], error}`（E14 历史回显） |
| `session:delete` | `{sessionId, cwd?}` | `{ok}`；L1 只从 CCM 列表隐藏，transcript 保留 |
| `session:deletePermanent` | `{sessionId, cwd?}` | `{ok}`；L2 经活跃实例与 transcript 静默检查后调用官方 SDK 真删 |

**同步 / 日志 / 元数据 / 开发**（均带 `ack`）

| 事件 | payload | ack 返回 |
|---|---|---|
| `sync:since` | `{sessionId, lastSeq, instanceId?}` | `{replayed, gap, found, pending, diskLen}`（断线补发；`found:false`=实例已没了，`diskLen` 供 transcript 对账） |
| `logs:get` | `{instanceId?}` | `{logs[]}`（该实例的交互日志，需 `LOG_INTERACTIONS=1`） |
| `mirror:syncNow` | `{}` | 无 ack；立即触发一次 transcript 追平 |
| `conn:ping` | `{}` | `{ok:true,t}`；连接 RTT 探活，不进业务缓冲 |
| `dev:restart` | `{}` | `{ok}` 或 `{ok:false, error}`（**仅 `DEV_MODE=1`**：优雅退出，靠 KeepAlive 自动拉起） |
| `disconnect` | — | 系统事件；**不动 agent**（任务独立于连接存活） |

**预览 / 诊断 `tool:*` / `doctor:*`**（均带 `ack`）

| 事件 | payload | ack 返回 |
|---|---|---|
| `tool:preview` | `{instanceId?, toolUseId}` | `{ok, name, inWhitelist, attribution:{workdirLabel, relPath}, diff?, snippet?}` 或 `{ok:false, inWhitelist?, error}`（③ 工具卡片文件预览：`Edit`/`Write`/`MultiEdit`/`NotebookEdit` 出 `diff`、`Read` 出有界 `snippet`；**唯一闸门 `attributePath` 归属 + symlink + realpath 二核**，白名单外 / 穿越一律拒，绝不成为任意文件读） |
| `tool:full` | `{instanceId?, toolUseId}` | `{ok,text}` 或 `{ok:false,error}`（读取 Agent 内有界缓存的完整工具输出） |
| `browse:list` | `{cwd?,relPath?,offset?,maxEntries?}` | `{ok,entries,...}` 或越界错误 |
| `browse:read` | `{cwd?,relPath,offset?,maxBytes?}` | `{ok,text,...}` 或越界错误；同样受工作目录、symlink 与 realpath 边界保护 |
| `doctor:run` | `{}` | `{checks[], readiness}`（④ UI 安全体检：运行时检查 + 全局危险白名单审查；**全程脱敏**，只出布尔 / 计数 / 危险规则串，绝不回显明文 token / 绝对路径 / AUD / 密钥） |

---

## 二、内部模块 API

`src/` 下的 ESM 模块（`export`）。签名以参数名示意，`?` 表可选。

### `src/agent/agent.js` — `class AgentSession`

一个会话 = 一个长驻 SDK query（streaming input 模式），SDK 消息 → `agent:event` 统一信封。由 `src/server/app.js` 编排调用，主要公开方法：

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

### `server.js` 与 `src/server/`

根 `server.js` 是薄兼容入口，继续支持 `node server.js`、LaunchAgent 与 systemd，并转出 `httpServer`、`io`、`port` 供 `tests/integration/` 注入。`src/server/config.js` 处理配置/预检，`http.js` 处理 HTTP，`socket.js`/`socket-files.js` 处理事件边界，`instance-manager.js` 处理实例生命周期，`app.js` 负责组合。

### `src/sessions/history.js` — CLI 会话历史读取（事实源 `~/.claude/projects/<project>/<id>.jsonl`）

`HISTORY_MAX_MESSAGES` · `getProjectDir(cwd)` · `getSessionHistory(sessionId, cwd, limit?)` · `catchUpStep(state, …)`（只读追平增量） · `MIRROR_RELEASE_QUIET_TICKS` · `mirrorReleaseStep(state, …)`（只读镜像锁静默自动释放） · `listSessionsPage(cwd, opts)` · `listSessions(cwd, opts?)` · `invalidateListCache(cwd)` · `lastPermissionMode(entries)` · `readLastPermissionMode(sessionId, cwd)`（末条权限档恢复） · `sessionFileExists(cwd, id)` · `sessionFileSize(sessionId, cwd)`

### `src/sessions/sessions.js` — 会话控制面元数据（永不存消息内容）

`flushSaveSync()` · `getState()` · `getCurrent(cwd)` · `setCurrent(cwd, sessionId)` · `upsertSession(…)` · `getSession(id)` · `updateSessionCost(id, cost)` · `updateSessionPrefs(id, prefs)`

### `src/sessions/workdirs.js` — 多工作区白名单（解析 / 校验 / 归一）

`DEFAULT_SESSION_LIMIT`（6） · `MAX_SESSION_LIMIT`（50） · `normalizeWorkdirEntries(parsed)` · `loadWorkdirsFile(filePath)` · `resolveWorkdirs(entries)`

### `src/files/uploads.js` — 附件落盘 + 路径注入 + 防穿越（E17）

`UPLOAD_DIR`（`.ccm-uploads`） · `sanitizeName(name)` · `validateAttachments(attachments)` · `saveAttachments(workDir, attachments)` · `buildPromptText(text, saved)` · `toEventMeta(saved)`

### `src/auth/devices.js` — 受信任 / 待确认设备指纹

`MAX_PENDING_DEVICES`（50，待审设备上限） · `loadTrustedDevices()` · `getTrustedCount()` · `saveTrustedDevices()` · `loadPendingDevices()` · `savePendingDevices()` · `isDeviceTrusted(deviceToken)` · `addPendingDevice(deviceToken, info)` · `removePendingDevice(deviceToken)` · `getPendingDevices()` · `getLatestPendingDevice()` · `approveDevice(deviceToken)` · `denyDevice(deviceToken)`

### `src/ops/statusline.js` — 状态栏 payload 构建（E16）

`parseShortstat(str)` · `parseRepo(url)` · `gitStatus(cwd)` · `webContextCost(…)` · `buildWebStatusLine(…)`（SDK 单一来源） · `buildCliStatusLine({snapshot, cwd})`（CLI 快照单一来源）。两条构建路径分开，除当前 cwd 的本机 git 状态外不做字段级混拼。

### `src/ops/cli-statusline-bridge.js` — CLI statusline 私有快照

`CLI_STATUSLINE_SCHEMA_VERSION` · `MAX_CLI_STATUSLINE_SNAPSHOT_BYTES`（64 KiB） · `DEFAULT_CLI_STATUSLINE_DIR` · `cliStatuslineTtlMs(refreshIntervalSec)` · `normalizeCliStatusInput(raw, opts?)` · `writeCliStatusSnapshot(snapshot, opts?)` · `readCliStatusSnapshot(sessionId, opts?)` · `selectStatusOwner({mirrorReadonly, externalDirty})`（**只看 mirrorReadonly**；`externalDirty` 形参兼容保留、不参与判定）· `selectStatusSource({owner, cliRead, sdkPayload})` · `selectStatusReplay(cache, current)`。读取会验证 schema/source、session、cwd、大小、权限与 TTL；连接重放还要求 owner、instance、session、cwd 全匹配，失败时不返回半可信数据。

### `scripts/statusline-bridge*.js` — 显式安装与透明运行

- `npm run statusline:status`：只读报告 `installed` / `not-installed` / `drifted`，不创建文件、不改 Claude settings。
- `npm run statusline:install`：备份原 `statusLine.command`/`refreshInterval` 后安装透明 wrapper；重复执行幂等。
- `npm run statusline:uninstall`：仅当当前 command 仍等于已安装 wrapper 时恢复原配置；检测到 drift 时按 CAS 语义拒绝覆盖。
- wrapper 保持原 renderer 的 stdin/stdout/stderr/退出码；`CCM_STATUSLINE_ORIGIN=web-sdk` 时不采集，防 Web SDK 子进程覆盖真实 CLI 快照。

运维步骤、环境变量和故障处理见 [statusline-bridge.md](statusline-bridge.md)。

### `src/ops/notifications.js` — 事件 → 通知的纯映射（渠道无关文案 + ntfy 渠道元数据）

`notificationForEvent(type, payload, opts?)` → `{title, body, data?}`（应推）或 `null`（不推）；`opts = {hasClients, instanceId?, sessionId?, cwd?}`，传 `instanceId` 时附 `data`（`{instanceId, sessionId, cwd}`）供点击深链回该会话（②） · `ntfyMetaFor(type, data, publicUrl)` → `{priority, tags, click?}`（ntfy 优先级 / 标签 / 深链 URL） · `ntfyRequestInit({url, topic, token}, title, body, meta)` → `{url, init}`（构造 ntfy POST，纯函数不发网络）

> 传输层 `pushNotify`（Web Push）与 `ntfyNotify`（ntfy）在 `src/ops/notify-channels.js`（`createNotifyChannels({dataDir, env, fetchImpl?, webpushImpl?, onDeliveryFailure})` 工厂：订阅按 endpoint 去重存储、410/404 剔除、失败计数与回调），由 `src/server/app.js` 组装；本模块只出渠道无关的文案与元数据，便于单测。

### `src/auth/device-gate.js` — 设备审批网关（socket 分组操作 + CLI 审批文件监听）

`createDeviceGate({io, dataDir, onUnlockSocket, listPendingDevices?, isTrusted?})` → `{unlockDeviceSockets(token)` · `disconnectDeviceSockets(token)` · `pendingDevicesPayload()` · `broadcastPendingDevices()}`；创建时确保设备文件存在并监听 `trusted-devices.json` 父目录（原子写免疫），CLI 侧批准/吊销即时同步 web 连接。重放初始态的 `unlockSocket` 留在 `src/server/app.js`、经 `onUnlockSocket` 注入。

### `src/agent/approval-lifecycle.js` — 审批台账生命周期

`approvalRetentionMs(env?)`（`APPROVAL_RETENTION_DAYS` 解析，0/负/NaN 回落 90 天） · `expireOrphanedPending()`（重启 fail-closed：遗留 pending 一律标 expired，须在 listen 前跑） · `startApprovalRetentionSweep()`（NFR-16 留存清扫：启动即清 + 每 24h，定时器 unref）

### `src/agent/models-cache.js` — 按 cwd 归键的可用模型清单缓存

`createModelsCache(…)` · `isCwdDefaultModel(…)`

### `src/agent/interaction-log.js` — 可选交互日志（`LOG_INTERACTIONS=1`）

`enabled` · `setCallback(cb)` · `getSessionLogs(sessionId)` · `addSessionLog(sessionId, type, text, meta)` · `userMessageIn(…)` · `userMessageOut(…)` · `agentSend(…)` · `agentResult(…)` · `textDelta(sessionId, delta)`

### `src/auth/cf-access.js` — Cloudflare Access JWT 校验（纵深防御）

`initCfAccess()` · `isAccessEnabled()` · `isPublicHost(host)` · `verifyAccessJwt(token)`

### `src/files/file-security.js` — 文件安全守卫（symlink 穿越防御 + owner-only 权限）

`rejectableSymlinkComponent(path)` · `isOwnerOnly(path, isDir?)` · `fixPermissions(path, isDir?)` · `writeOwnerOnlyFile(path, content)` · `checkPermissions(paths, isDir?)`

### `src/files/file-preview.js` — 工具卡片文件预览（③）的纯逻辑 + 有界读盘

`attributePath(filePath, workDirs, cwd)` → `{workDir, relPath, resolved}` / `null`（**唯一安全闸门**：路径归属 + 穿越裁决，零 IO；与 `uploads.js` 同源的 `dir + sep` 前缀判定） · `buildDiff(name, input?)`（`Edit`/`MultiEdit`/`Write`/`NotebookEdit` 变更摘要，不读盘、来自缓存 input；`Read` / 其他 → `null`） · `readPreview(resolved, {maxBytes?, maxLines?})` → `{snippet, truncated, size, binary?}`（有界读盘，字节 + 行数双封顶、含 NUL 判二进制；**调用方必须先过 `attributePath`**）

### `src/shared/sanitizer.js` — 日志脱敏（15 种敏感模式，含 Anthropic key）

`stripControlSequences(text)` · `sanitize(text)` · `maskToken(token)` · `sanitizePath(path)`

### `src/ops/doctor-runtime.js` — UI 安全体检（④）运行时编排（读合并白名单 + 检查 + 脱敏聚合）

`readMergedPermissions({home, workDirs?})` → `{allow, sources}`（合并 `~/.claude` 与各 workDir 的 `permissions.allow`，标 `scope`；坏 JSON 不清空、skip） · `runDoctor(ctx)` → `{checks[], readiness}`（`ctx` 由 `src/server/app.js` 喂 env + 内存态：`authToken` / `claudeVersion` / `workDirs` / `home` / `cfEnabled` / `cfAudSet` / `pushEnabled` / `trustedDevices` / `pendingDevices`；**脱敏**，绝不回显明文 token / 绝对路径 / AUD / 密钥）。底层判定在 `src/ops/doctor-checks.js`（`classifyAuthToken` / `summarizeDangerous` / `computeReadiness` 等，doctor CLI 与 UI 体检共用）

---

## 三、事实源与校验

| 层 | 事实源 | 机械校验 |
|---|---|---|
| 出向 `agent:event` 类型 | `scripts/agent-event-contract.js`（26 类 allowlist） | `npm run contract:check`（零 token 静态，校验 real ⊇ mock） |
| 入向 socket 事件名 | `scripts/agent-event-contract.js`（`INBOUND_SOCKET_EVENTS` 29 项） | `npm run contract:check`（server 注册面 = 契约；前端 emit / mock ⊆ 契约） |
| 文档链接 / npm 脚本名 / SDK 版本 | `scripts/doc-consistency.js` | `npm run check`（含本文件的死链扫描） |

本文件给人读；协议以表中的可执行事实源为准。两者漂移由 `npm run check` + `npm run contract:check` 拦截。
