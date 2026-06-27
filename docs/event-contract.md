# 事件契约（前后端唯一接口）

> 前后端**只**通过下述事件通信。实现不得在此之外随手发明事件。**字段可加不可改语义**。SDK 消息 → 信封的映射在 `agent.js` 的 `map()`。

## 服务端 → 客户端：统一事件信封

```text
agent:event  { seq, epoch, sessionId, instanceId, cwd, ts, type, payload }
```

- **`seq`**：实例内单调递增整数，续传去重的基础。服务端为每个实例维护环形缓冲（最近 ≥500 条）。
- **`epoch`**：每个 `AgentSession` 实例一个跨重启唯一标识（wall-clock + 进程内计数）。`seq` 随实例从 0 重启，客户端据 `epoch` 判定"新流"——epoch 变化即重置 seq 去重基线，避免重启/切回后旧 `lastSeq` 误吞实时事件。服务端合成事件用 `epoch:'server'`（`seq:0`，始终透传不去重）。
- **`instanceId`**：事件所属实例（[ADR-0010](decisions.md#adr-0010)）。每个 `AgentSession` 创建即分配进程内唯一、永不变的 `inst_${n}`，`agents: Map<instanceId>`——**前端分流的权威锚点**：前端按 `viewingInstanceId` 只渲染当前查看 tab 的事件流，其余按角标/通知处理或丢弃。**`viewingInstanceId=null`（新会话空窗口/无 live 实例）时无「当前 tab」，带 `instanceId` 的后台事件一律丢弃**——前端须以「是否已收到首个 `instances` 广播」区分「视图未知（连接初期，放行重放批次）」与「空视图（新会话懒开，丢弃后台事件）」；**不可用 `viewingInstanceId` 真假短路判定**，否则二者混为一谈，活跃后台实例的 `tool_use`/`tool_result`/`result` 会污染空窗口（见 `logic.js` `shouldDropAgentEvent`）。新会话在 init 前 `sessionId=null`，故分流/路由用 `instanceId`。合成事件按需带目标 `instanceId` 或省略（缺省即不过滤）。**广播裁剪**：后台实例（`instanceId !== viewingInstanceId`）的高频 `text_delta`/`thinking_delta` 不进 `io.emit`——它们仍入环形缓冲供 `sync:since` 回放；低频事件（`tool_use`/`init`/`result` 等）不受此限制，维持广播（角标/通知依赖）。
- **`cwd`**：事件所属工作目录（每实例属性，供 tab 栏按 cwd 分组、`session:history`/`session:list` 定位 project 目录）。非分流锚点。
- **`type` 与 `payload`**：见下表。

### 事件类型表

| type | payload | 对应 |
|---|---|---|
| `init` | `{ model, cwd, claudeVersion, mcpServers[], skillsCount, permissionMode, slashCommands[] }` | E9。`slashCommands` 供前端斜杠提示（全量）。init 在**每轮开始时**到达，非仅会话启动；前端把列表存 localStorage、每轮 init 覆盖刷新。服务端内存缓存最近一次 init，新连接以 `epoch:'server'` 重放（**重放剔除 `slashCommands`**——lastInit 是全局最近一次任意实例 init、其斜杠命令含 project 级项，跨 repo/tab 重放会串；前端保留 localStorage 缓存、真 init 到达即校正。持久化至 `data/init-cache.json`，重启读回）。**实测 CLI 在收到首条消息前不输出 init**，故启动预热拿不到 init——持久化是空窗的唯一解。`permissionMode`/`model` 取 SDK init 上报的真值（`msg.permissionMode`/`msg.model`）= 「档位/模型已被 SDK 应用」的唯一权威凭证；`permissionMode` 与本地 shadow 漂移（如修复前 ExitPlanMode 没真退 plan）时**以 SDK 为准对账 + 告警留痕**（bypass 例外：用户档保留、SDK 实为 default），见 [ADR-0012](decisions.md#adr-0012) |
| `text_delta` | `{ messageId, text }` | E4（亦作非流式网关的全文兜底载体）。`text` 可携带服务端时间窗（≤20ms）内合并的多段文本，前端用 `appendData(text)` 增量追加，无需逐 token 处理。 |
| `thinking_delta` | `{ messageId, text }` | 透明性（前端默认折叠）。`text` 同 `text_delta` 可批量合并。 |
| `tool_use` | `{ toolUseId, name, inputSummary }` | E5 |
| `tool_result` | `{ toolUseId, ok, outputSummary, denyKind? }` | E5。`denyKind ∈ answered\|denied\|cancelled`：`deny+message` 通道（AskUserQuestion 作答/取消、审批拒绝/取消）的真实语义——`ok:false` 但**非工具报错**，前端据 `denyKind` 显 ☑️/🚫 并剥 `Error:` 前缀，不靠字符串匹配。无 `denyKind` 才按 `ok` 显 ✅/❌ |
| `permission_request` | `{ requestId, name, input, cwd }`（**完整命令，不截断**） | E3 |
| `question` | `{ requestId, text, options[] }` | E7；`requestId` 格式 `${toolUseID}#${i}`（一个 AskUserQuestion 可含多个问题） |
| `models` | `{ models[] }` | E8；`start()` 时即 fire-and-forget `supportedModels()`（**不依赖 init**，因 CLI 首条消息前不输出 init），供前端模型下拉候选；init 到达时再调一次兜底（通常幂等）。自由输入任意模型名走 `/model <名>` 拦截通道。服务端**按 cwd 归键缓存**（清单随工作区 settings 覆盖网关/模型名而变，非全局量）+ 新连接按当前查看 cwd 重放 |
| `user_message` | `{ text, attachments? }` | 用户消息入缓冲并广播，多设备/重载后均可回放。`attachments[] = { name, mimeType, size, thumb? }`（**仅元数据 + 小缩略图，无完整字节**——[ADR-0013](decisions.md#adr-0013)） |
| `request_resolved` | `{ requestId, kind: 'permission'\|'question', outcome }` | 审批/选题完成后广播，多设备/续传场景关闭陈旧弹窗 |
| `result` | `{ messageId, durationMs, costUsd?, isError, errors?, models[], text? }` | 一轮结束标记；`models` = 本轮使用的模型名（验收语义断言用）；`text` = 完整回复文本（E18：供前端断网恢复后校正截断的流式拼接，可选） |
| `error` | `{ message, recoverable }` | `message` **透传上游错误原文**（SDK 已带 `API Error:` 前缀的文本块），不显示 SDK 归类枚举——终端等价 = 上游返回什么显示什么 |
| `system` | `{ message, kind? }` | 提示类；`kind:'interrupted'` 表示用户主动中断（前端据此 finalize 流式气泡） |
| `status_line` | `{ ts, model, project, cwd, git:{branch,changed,ahead,behind,insertions,deletions,repo}, ctx:{tokens,cacheHitPct,in,w,r}, cost, duration:{wallMs,apiMs}, version }` | E16/[ADR-0011](decisions.md#adr-0011)。**纯服务端合成事件**（恒 `epoch:'server'`/`seq:0`/`sessionId:null`）：web 会话自有 SDK 数据 + 本机 git 结构化组装，**不执行脚本/不读快照**（账号级配额 SDK 拿不到，故无 5h/7d 段）。全字段可选（缺则省）；前端原生 UI 渲染——折叠摘要（ctx·cost·耗时）+ 展开分段着色（git+增删 / token+cache+API / repo+版本+时间，时间用 `ts` 前端渲染）。不进 seq 流/环形缓冲；内存缓存最近一条对新连接重放，不持久化 |
| `permission_mode` | `{ mode }` | [ADR-0012](decisions.md#adr-0012)。权限档切换回执/重放（4 档之一），多设备同步。合成事件；带作用实例的 `instanceId`，前端仅对该实例应用（新会话 pending echo 时 `instanceId:null`，前端不过滤照常应用） |
| `effort_mode` | `{ level }` | [ADR-0015](decisions.md#adr-0015)。思考强度档回执/重放（`low/medium/high/xhigh/max` 或 `null`）。合成事件；busy/非法档拒切时单发拨回该 socket（新会话 pending echo 时 `instanceId:null`）。⚠️ effort **无 SDK 应用确认**：SDK init/result 均不回 effort，此事件仅我们自己的回执，无法在事件流证明 `--effort` 真生效（错值会令 CLI spawn 失败兜底；行为级验证见 `scripts/smoke-effort.js`）——与 `permissionMode`/`model` 有 SDK 源头凭证不同 |
| `instances` | `{ viewingInstanceId, viewingCwd, dirs, defaultPermissionMode?, defaultEffort?, instances:[{instanceId, cwd, sessionId, title, state, permissionMode, effort, model}] }` | [ADR-0010](decisions.md#adr-0010)。tab 栏数据源：列出全部 live 实例，`state ∈ idle/busy/permission/error/done`（`done`/`error` 为非查看实例的完成/出错 latch，被切为 viewing 或新活动时清除）。聚合优先级 `permission>error>busy>done>idle`。合成事件；轮次/审批边界 + `session:*`/`setViewing` 后广播，新连接重放。`permissionMode`/`effort`/`model` = 各实例当前档，供前端切 tab 时**静默同步**顶部面板（权限档/思考强度/模型 select）——上下文恢复显示、非用户切档、不上屏系统条。`defaultPermissionMode`/`defaultEffort` = 空首页（`viewingInstanceId=null`、无 live 实例）下「下一条新会话(FRESH)将用的」权限档/思考强度（= 该 cwd `pending` 预设 ?? **CLI 启动默认**：权限 `default`、effort `null`(模型默认)）——供前端如实显示该工作区新会话将用的档（终端等价），修「空首页残留上个会话档」。有 live 实例时这两段省略，前端走实例自身档（`instances[].permissionMode/effort/model`）。**模型不下发**——新会话模型 = 终端 `ANTHROPIC_*` env 默认、服务端不可知，前端显「不指定（沿用当前）」、首条消息后由 `init.model` 校正（**不猜**，A1 删原 `defaultModel` 推断字段，2026-06-22） |
| `session_log` | `{ type, text, ts, model? }` | 实时流式日志事件（**服务端发出的** `type ∈ user_in\|user_out\|agent_send\|agent_result\|sys_info`；`sys_info`=服务端运维/状态提示）。`model?` = 该跳生效模型 ID（前端渲染独立 chip；四类消息条目带、`sys_info` 不带）。仅对当前活跃会话推送并缓存最后 100 条。注：前端日志面板还会混入客户端本地生成的 `client_conn` 等（`type: 'client_xxx'`）条目，这些**不经 socket 传输**，仅存于 `clientLogBuffer`（`client_send/client_recv` 也带 `model`），故不属于本契约范畴。 |
| `device_status` | `{ status, deviceId }` | [ADR-0018](decisions.md#adr-0018)。TOFU 设备审批状态（`status ∈ pending\|approved\|denied`）。合成事件（`epoch:'server'`）：未批准设备连接广播 `pending`，控制台/脚本审批后 `approved`、拒绝后 `denied` |
| `pending_devices` | `{ devices:[{ deviceId, ip, userAgent, ts }] }` | [ADR-0018](decisions.md#adr-0018)。**仅发给已 `deviceApproved` 的 Socket**：当前全量待审批设备列表（幂等，空数组=无待批）。新待批出现 / 批准 / 拒绝后广播，可信端连入时重放。供已信任设备在 Web UI 远程一键审批（免终端）。合成事件（`epoch:'server'`） |

## 客户端 → 服务端

| 事件 | payload | 说明 |
|---|---|---|
| `user:message` | `{ text, model?, attachments?, instanceId?, cwd? }` | 发消息（路由到 `instanceId`，缺省 `viewingInstanceId`）；同会话串行，处理中再发则排队（队长 1）。`attachments[] = { name, mimeType, size, data, thumb? }`（`data` = 完整文件 base64，落盘后把绝对路径注入 prompt；条数 ≤10、单 ≤10MB、总 ≤20MB） |
| `user:approve` | `{ requestId, decision: 'allow'\|'deny', alwaysThisSession?, instanceId? }` | 审批回应 |
| `user:answer` | `{ requestId, optionIndex, instanceId? }` | 选择题回应 |
| `user:interrupt` | `{ instanceId? }` | 中断指定 tab 的在途任务（缺省 `viewingInstanceId`），不波及其他 |
| `user:approveDevice` | `{ deviceId }` | [ADR-0018](decisions.md#adr-0018)。已信任设备远程批准待审批设备：server 调 `approveDevice`+`unlockDeviceSockets`、重广播 `pending_devices`。**经统一 Socket 过滤点保护——`deviceApproved=false` 的待审批设备发此事件会被丢弃，无法自批**，审批权恒属已信任设备 |
| `user:denyDevice` | `{ deviceId }` | [ADR-0018](decisions.md#adr-0018)。已信任设备远程拒绝待审批设备：server 调 `denyDevice`+`disconnectDeviceSockets`、重广播。同样仅已信任设备可发 |
| `user:setPermissionMode` | `{ mode, instanceId? }` | 切权限档；server 调 `q.setPermissionMode` 后广播 `permission_mode`。`bypassPermissions` 须前端二次确认后才发。**新会话懒创建期**（`viewingInstanceId=null`、无实例）改存服务端 pending 档（按 `viewingCwd`）+ echo 新档，首条消息 `openInstance` 时消费（[ADR-0012](decisions.md#adr-0012)） |
| `user:setEffort` | `{ level, instanceId? }` | 切思考强度档；busy 拒绝；空闲时**当场置换实例**（dispose + 立即 resume 重生）注入 `--effort`，成功广播 `effort_mode`。**新会话懒创建期**（无实例）改存服务端 pending（按 `viewingCwd`）+ echo，首条消息 `openInstance` 消费（[ADR-0015](decisions.md#adr-0015)） |
| `user:setWorkdir` | `{ cwd }` | 切 cwd 分组上下文；server 校验 `cwd ∈ WORK_DIRS`（**精确白名单匹配**，防 `../` 穿越）；响应广播 `instances` |
| `user:setViewing` | `{ instanceId }` | 切视图到指定 tab：校验 ∈ live 实例 → 改 `viewingInstanceId` + 广播 `instances` + 清该实例 `done` latch |
| `session:new` | `{ cwd? }` | 新建会话开新 tab（首条消息才懒开 FRESH 实例）。不再 dispose 同 cwd。清该 cwd 的 pending 预设档（权限/effort）。ack `{ ok: true, instanceId: null, sessionId: null }` |
| `session:switch` | `{ sessionId, cwd? }` | 打开或聚焦会话：校验 `<id>.jsonl` 存在于本 cwd 的 project 目录 + **id 字符集守卫 `^[0-9a-zA-Z_-]+$`**（防路径穿越）；已有 live 实例则聚焦不重开（去重）。成功 ack `{ ok: true, instanceId, sessionId }`；失败 ack `{ ok: false, error }` |
| `session:close` | `{ instanceId }` | 关闭 tab：`disposeInstance`（杀进程、deny 挂起审批、释放配额；会话留盘可再开）。ack `{ ok: true, viewingInstanceId }`（viewingInstanceId 为关闭后回落的当前查看 tab，可能为 null） |
| `session:list` | `{ cwd? }` | 返回该 cwd 会话列表，**数据源 = 扫 `~/.claude/projects/<编码cwd>/*.jsonl`**（与 CLI `/resume` 同源，含终端会话）。ack `{ currentSessionId, sessions:[{id,title,model,lastUsedAt,entrypoint}] }` |
| `session:history` | `{ sessionId, cwd? }` | E14 历史回显：读 CLI JSONL 最近 N 条 user/assistant 消息，ack `{ messages }`。走 socket 继承握手鉴权——**不开无鉴权 HTTP 数据端点**。归属校验同 `session:switch`，接纳终端创建的会话 |
| `sync:since` | `{ sessionId, lastSeq, instanceId? }` | 重连/切 tab 续传：补发缓冲中 `seq > lastSeq` 的事件；有缺口先发一条 `system` 告知。ack `{ replayed, gap, found }`——`replayed=0` 表示该实例无对话内容，客户端据此回落到 `session:history` 避免空屏；`found=false` 专指「实例已没了」（dispose/重启/effort 切档换 `instanceId`），与「实例还在、只是无新事件」的 `replayed=0` 区分开，重连客户端据此清屏重载历史。服务端校验 `agents.get(instanceId).sessionId === sessionId` 才回放 |
| `logs:get` | `{ instanceId }` | 获取当前会话缓冲的历史交互日志。ack `{ logs: [{ type, text, ts, model? }] }` |
| `models:get` | `{}` | 主动拉取【当前查看工作区】的可用模型清单。ack `{ models[] }`。**即时回按 cwd 归键的缓存、不实时调 `supportedModels()`**（其需活实例，新建会话时实例懒开尚未起）——清单**随工作区变**（`.claude/settings.local.json` 的 env 块可覆盖 `ANTHROPIC_BASE_URL`/`ANTHROPIC_DEFAULT_*_MODEL`，改写网关与自定义模型名，**非账号级全局量**），故按 `viewingCwd` 取、未知工作区诚实返回空、**绝不回退别区清单**（防跨工作区泄漏，如切区点新会话冒出上个区 deepseek 名）；连接时按 cwd 已重放一次；本事件供新建会话主动确认 + 防御 `modelsList` 为空 |

## 鉴权

Socket.IO 握手 `auth.token` 必须等于 `AUTH_TOKEN`（仅当对外监听时）。失败即断开，无匿名降级。`connect_error` 为 `unauthorized` 时前端显示令牌输入页（存 localStorage、以新 token 重连），纯客户端引导，不新增服务端端点。

## HTTP 端点（少量，均带鉴权）

- `GET /health` → `{status, sessionId, busy, versions, timestamp}`（设了 `AUTH_TOKEN` 时需 `?token=` 或 `x-auth-token` 头，否则 401）。
- `GET /push/vapid-public-key`、`POST /push/subscribe`（[ADR-0009](decisions.md#adr-0009)，同鉴权）。
