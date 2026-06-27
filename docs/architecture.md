# 架构深度解析

> 本文深入代码库的设计哲学、安全纵深、核心模块内部机制与并发模型。
> **快读入门**（架构图 + 消息旅程 + 文件表）见 [README.md](../README.md#架构)。
> 事件契约见 [event-contract.md](event-contract.md)，架构决策记录见 [decisions.md](decisions.md)。

---

## 1. 设计哲学

### 单一事实源

| 概念 | 事实源 |
|------|--------|
| 会话元数据 | `data/sessions.json`（服务端**唯一**持久状态） |
| 消息内容 | claude CLI 自己的 JSONL（服务端**不存**任何消息副本） |
| 工具放行白名单 | `.claude/settings.json` `permissions.allow`（与终端同源） |
| Anthropic 凭据/网关 | **只能来自启动 shell 的 env**；`dotenv` 启动期删除 `.env` 注入的 `ANTHROPIC_*` |
| 事件定义 | `docs/event-contract.md`（前后端唯一接口，字段可加不可改语义） |
| 架构决策 | `docs/decisions.md`（ADR 001-018，代码注释通过 `ADR-NN` 引用） |
| 环境变量 | `docs/configuration.md`（唯一权威参考，`.env.example` 同步维护） |

### 三个不做（与 P0 同等用力维护）

1. **不做多用户/多租户** — n=1，通过鉴权的请求权力与"坐在终端前"完全相同
2. **不做消息数据库** — 不建 SQLite/消息表；会话内容事实源是 claude 自己的 JSONL
3. **不做 CDN 依赖** — 前端第三方库自托管到 `public/vendor/`（Tailwind/marked/highlight.js/DOMPurify），零网络依赖

---

## 2. 四层架构

项目代码按职责分为四个逻辑层，每层只通过下层定义的接口交互：

```
┌──────────────────────────────────────────────────┐
│ 层1: 通信契约层 (server.js)                       │
│ Express 静态托管 · Socket.IO 路由 · 鉴权          │
│ 启动预检 · 实例池 agents: Map<instanceId>        │
│ 所有 handler 经 on() 包裹防崩                     │
├──────────────────────────────────────────────────┤
│ 层2: Agent 会话桥 (agent.js)                      │
│ AgentSession 类包装 SDK query                     │
│ streaming input · 审批闸门 · SDK消息→事件信封     │
│ 500条环形缓冲 seq+epoch · 静默看护               │
├──────────────────────────────────────────────────┤
│ 层3: 持久化层 (sessions.js)                       │
│ data/sessions.json 原子写+防抖200ms              │
│ 只存元数据，永不存消息内容                         │
├──────────────────────────────────────────────────┤
│ 层4: 前端 SPA (public/js/app.js + logic.js)      │
│ 纯客户端、零构建、Text节点 appendData 增量渲染    │
│ 审批弹窗 · TOFU 设备指纹 · 断线重连主路径         │
└──────────────────────────────────────────────────┘
```

---

## 3. 五层安全纵深

本项目的本质是**一条暴露在公网上的代码执行通道**。安全不是功能特性，而是项目存在的前提。

```
┌─ 层1 ──────────────────────────────────────────────┐
│  Cloudflare Access 双因素 (ADR-0017)                │
│  · CF Access 2FA 登录验人                          │
│  · server 二次 JWT 校验，fail-closed               │
│  · 不回退到 AUTH_TOKEN                              │
├─ 层2 ──────────────────────────────────────────────┤
│  AUTH_TOKEN                                         │
│  · 空 token = 只监听 127.0.0.1                     │
│  · Socket.IO 握手鉴权，失配即断开                   │
│  · timingSafeEqual 防计时侧信道                     │
├─ 层3 ──────────────────────────────────────────────┤
│  设备信赖 TOFU (ADR-0018)                           │
│  · 未批准设备 → 先一次性授权                        │
│  · 光有合法 token 不够                              │
│  · 未授权连接上行事件全部丢弃 (fail-closed)         │
├─ 层4 ──────────────────────────────────────────────┤
│  工具审批两层闸门 (ADR-0003)                        │
│  · permissions.allow 白名单 → 自动放行              │
│  · 其余 → 手机弹窗（完整命令 + cwd + 参数）        │
│  · dontAsk 模式 = 白名单外直接 deny                 │
│  · bypassPermissions 需 UI 显式切换 + 危险确认      │
├─ 层5 ──────────────────────────────────────────────┤
│  文件安全 + 防穿越                                  │
│  · file-security.js：0600 原子写 (tmp→fsync→rename)│
│  · uploads.js：O_EXCL/O_NOFOLLOW + 落点校验        │
│  · session id 字符集守卫 `^[0-9a-zA-Z_-]+$`        │
│  · WORK_DIRS 精确白名单匹配防 `../` 穿越            │
└──────────────────────────────────────────────────────┘
```

完整威胁矩阵与部署加固建议见 [design.md §4 安全模型](design.md#4-安全模型)。

---

## 4. AgentSession 内部机制

`agent.js` 的 `AgentSession` 是项目最核心的抽象——每个 tab/会话对应一个长驻 SDK query。

### 生命周期

```
constructor()
    ↓
start()           ← 创建 SDK query（懒执行，首条消息才真正 spawn）
    ↓
consume()         ← 异步 consume 循环，消费 SDK 消息流
    ↓
interrupt()       ← 用户中断在途轮次
    ↓
dispose()         ← 关闭 tab/服务重启：杀子进程、deny 挂起审批
    ↑
onExit 回调       ← 进程意外退出/挂死时通知 server 置空，下条消息懒重生
```

### 核心属性

| 属性 | 说明 |
|------|------|
| `instanceId` | 进程内唯一、永不变 (`inst_${n}`) — 前端分流的权威锚点 |
| `epoch` | 跨重启唯一标识 (wall-clock + 进程内计数) — 客户端据此识别"新流" |
| `seq` | 实例内单调递增事件序号 — 断线续传去重 |
| `buffer[]` | 最近 500 条事件环形缓冲 — `sync:since` 续传 |
| `sessionId` | claude 原生 session_id |
| `pendingPermissions` | 待审批 `Map<requestId, {resolve, suggestions, input}>` |
| `pendingQuestions` | 待回答问题 `Map<toolUseID, {...}>` |
| `permissionMode` | 当前权限档 (`default`/`plan`/`acceptEdits`/`bypassPermissions`/`dontAsk`) |
| `effort` | 思考强度 (`low`/`medium`/`high`/`xhigh`/`max`/`null`) |

### 审批闸门逻辑

```
canUseTool(toolUse)
    │
    ├─ permissions.allow 命中 → 自动放行 (resolve(true))
    │
    ├─ dontAsk 模式         → 白名单外直接 deny (resolve(false))
    │
    └─ 其余                 → 挂起，emit permission_request 事件
                               → 手机弹窗 → user:approve → resolve(decision)
```

### 三个 SDK 陷阱（已显式处理，勿简化）

1. `settingSources` 必须 `['user','project','local']` — 完整加载本机配置
2. `systemPrompt` 必须显式 `claude_code` preset
3. `pathToClaudeCodeExecutable` 指向本机 `claude`（`which claude` / `CLAUDE_BIN`），不用 SDK 捆绑副本

---

## 5. 并发模型

```
agents: Map<instanceId, AgentSession>

instanceId = inst_${n}   ← 进程内唯一、永不变
              │
              ▼
前端按 viewingInstanceId 分流：
  切 tab 只换视图，不 dispose 实例
              │
              ▼
cwd 降为分组维度：
  WORK_DIRS 白名单，每目录独立会话列表
              │
              ▼
同一 repo 可开多个会话并行派活，互不打断
```

### 事件去重与续传

```
客户端连上 → sync:since { lastSeq, instanceId }
                  │
                  ▼
服务端查 agents.get(instanceId).buffer
    ├─ buffer 中有 seq > lastSeq → 回放
    └─ 有缺口 → 先发一条 system 告知
                  │
                  ▼
                      epoch 变化时
客户端自动重置 seq 去重基线
（epoch 跨重启唯一 → 不走"猜缺口"逻辑）
```

### 广播裁剪

后台实例的高频 `text_delta`/`thinking_delta` **不进** `io.emit`（仍入环形缓冲供 `sync:since` 回放）；
低频事件（`tool_use`/`init`/`result` 等）不受限制，维持广播（角标/通知依赖）。

---

## 6. 关键文件职责速查

| 文件 | 角色 | 关键行/函数 |
|------|------|-------------|
| `server.js` | 契约层 | `on()` 包裹所有 handler、`agents.get()` 路由、`shutdown()` |
| `agent.js` | AgentSession | `map()` SDK→信封、`askPermission()` 审批闸门、`consume()` 循环 |
| `sessions.js` | 持久化 | `load()`/`save()` 防抖异步写、`currentByCwd` 多目录指针 |
| `uploads.js` | 附件落盘 | `sanitizeName()` 文件名收敛、`saveAttachments()` O_EXCL/O_NOFOLLOW |
| `statusline.js` | 状态栏 | `execGit()` 短 TTL 缓存、`parseShortstat()`/`parseRepo()` |
| `public/js/app.js` | 前端契约 | `handle*()` 分发表、`appendData()` 增量渲染、epoch 感知续传 |
| `public/js/logic.js` | 纯逻辑 | `modelEntryFor()`、`effortLevelsFor()`、`aggregateStates()` |

### 读代码推荐顺序

[docs/design.md](design.md) §0 北极星 + [docs/event-contract.md](event-contract.md) 事件契约 → `server.js` → `agent.js` 的 `map()` 与 `askPermission()` → `public/js/app.js` 的 `handle*` 分发表 → 本文。
