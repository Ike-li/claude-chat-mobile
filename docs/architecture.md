# 架构说明

> 本文解释 Claude Chat Mobile 如何在“不共享实时 TTY”的前提下，让 Web 与终端 CLI 续用同一套配置和落盘会话。

[English](architecture.en.md) · [返回 README](../README.md)

## 设计目标

Claude Chat Mobile 是一层本机转发与同步服务：

- Web 发起任务时，通过 Claude Agent SDK 驱动本机 `claude` CLI。
- 终端直接运行任务时，不接管终端进程，只读取 CLI 已落盘的 transcript。
- 两端共享项目配置、工具、权限来源和会话记录，但同一时刻只允许一个驾驶员写入。
- 手机断线或切后台后，重新连接时可以去重并补发服务端仍保留的事件。

它不是远程桌面、TTY multiplexor、多租户托管服务，也不会把终端进程的 stdin/stdout 暴露给浏览器。

## 总体组件

```mermaid
graph LR
    subgraph Phone["手机 / PWA"]
        UI["app/public/ 单页应用<br/>消息·工具卡片·审批·文件"]
    end
    subgraph Edge["可选公网入口"]
        CF["Cloudflare Tunnel + Access"]
    end
    subgraph Host["本机"]
        S["app/server.js + app/src/server/<br/>Express · Socket.io · 鉴权 · 路由"]
        A["AgentSession<br/>SDK 流 · 权限闸门 · 事件缓冲"]
        SDK["Claude Agent SDK"]
        CLI["本机 claude CLI"]
        T[("~/.claude/projects/<br/>transcript")]
        H["catchUpTick + hooks inbox<br/>只读追平与即时信号"]
        D[("CCM_DATA_DIR<br/>设备·会话指针·审批·审计")]
        FS[("授权工作区")]
    end

    UI <-->|"agent:event / user:*"| CF <--> S
    S <--> A
    A <-->|"Web 驾驶"| SDK <-->|spawn| CLI
    CLI <--> FS
    CLI -->|"CLI 驾驶时落盘"| T
    T --> H --> S
    S --- D
```

Cloudflare 不是必需组件。同一 WiFi 可直接访问本机 server；固定公网部署才需要 Tunnel/Access 或等价的安全入口。

## 两条数据路径

### Web 驾驶

1. 浏览器建立 Socket.io 连接，通过 `AUTH_TOKEN` 或 Cloudflare Access 完成鉴权，再通过设备门。
2. 用户事件以 `user:*` 进入 server，并按 `instanceId` / 当前视图路由到对应 `AgentSession`。
3. `AgentSession` 把消息送入 Agent SDK streaming input；SDK 启动或续接本机 CLI，让它在授权 `cwd` 中工作。
4. SDK 输出经映射层转成文本、工具、审批、提问、状态、后台任务等产品事件。
5. 所有出向事件统一封装为 `agent:event`，前端按会话与实例分流并渲染。

Web 会话并不是远端 Anthropic 聊天页。SDK 子进程继承本机 CLI 的登录态、项目 `CLAUDE.md`、Claude settings、MCP、skills、hooks 和受控 provider 环境。

### CLI 驾驶

1. 用户在电脑终端直接运行 `claude`。这个进程不经过 Claude Chat Mobile 的 Agent SDK 子进程。
2. CLI 把已经完成的消息写入 `~/.claude/projects/` 下的 transcript。
3. server 的 `catchUpTick` 常态每 2.5 秒检查当前会话的磁盘变化（进入只读镜像后收紧到 1 秒，解锁前的静默判定按约 12.5 秒墙钟折算），并把新增的落盘消息推给 Web。
4. 可选 hooks bridge（`npm run hooks:install`）把 Stop / Notification 写入 `~/.claude/ccm/hooks-v1/` 文件投递箱，server 用 `fs.watch` 消费，把「回合结束/需要你」从轮询变成即时信号；未安装则回落轮询。`fs.watch` 只是加速触发器，磁盘 transcript 仍是真相源。
5. 可选 statusline bridge 给 CLI 会话写入模型、effort、上下文、成本和额度快照。

因此只读镜像有明确限制：

- 只能看到已经落盘的内容，不是实时 stdout。
- 不能向终端进程输入，也不能附着到它的 stdin。
- 尚未落盘的 thinking、子 agent 中间过程或工具输出可能暂时不可见。
- 跨会话“需要你”聚合只覆盖 Web 后端正在驱动的实例；纯终端里等待的会话不进这个聚合，只能靠可选 hooks bridge 单独通知。
- hooks 可以缩短“回合结束/需要你”的发现时间，但不会把镜像变成共享 TTY。

## 单驾驶员模型

共享 transcript 不等于允许两端同时写。并发启动两个独立 Claude turn 可能造成上下文分叉、文件竞争和错误的结束状态。

项目用以下规则降低风险：

1. **Web 驾驶时**，该 `AgentSession` 是写入方，前端执行“一轮一条”并在任务中把发送键改为停止键。
2. **检测到 CLI 外部写入时**，server 标记磁盘状态比 SDK 内存更新，Web 进入只读镜像。
3. **CLI 仍在运行时**，Web 不向同一会话发送新消息；界面展示终端驾驶状态。
4. **终端回合结束并经过静默判定后**，镜像锁释放，Web 才能续接。静默判定只认**终端写的**未完结尾部
   （transcript 逐条自报写入方：CLI 写 `cli`，本项目 SDK 写 `sdk-ts`）——己方 SDK 留下的未完结尾部撑不住锁，
   否则 Web 等一条审批时就会自锁：尾部恒未完结 ⇒ 锁恒维持 ⇒ 手机只读 ⇒ 点不到「批准」⇒ 审批永远等下去。
5. **Web 接管发送前**，若 transcript 相对现有 SDK 实例有外部增长，server 先 dispose 旧实例并 resume 吸收，再发送新消息。

**这五条是默认路径，不是硬约束。** 项目管得住自己的 SDK 实例，管不住终端里那个独立进程：镜像锁只作用于 Web 端的输入，
用户仍可在只读态下点「强制立即续接」/「仍要续接」显式解锁（`app/public/js/app.js` 的 `requestMirrorResume` /
`appendForceResumeAction`，两条路径都要过一次写明分叉风险的确认框）。解锁只是撤掉 Web 侧的锁，**不会停止终端进程**——
若终端此后继续写同一会话，仍会形成两条 transcript 分支。这个逃生口是有意保留的：用户常常比判定链更早知道终端已经关掉。

轮询意味着存在最多一个检查周期的观察窗口。切换会话、手动刷新镜像与 hooks 信号会主动插队触发检查，但它们仍不能证明对另一个活进程拥有控制权。

## 事件信封与断线回放

出向 Socket.io 只使用一个 `agent:event` 信封：

```json
{
  "seq": 42,
  "epoch": "server-instance-id",
  "sessionId": "cli-session-id",
  "instanceId": "web-instance-id",
  "cwd": "/approved/workspace",
  "ts": 1780000000000,
  "type": "text_delta",
  "payload": {}
}
```

- `type` 是闭合事件集合，由 `tests/gates/contract-check.js` 对**后端发送方**（递归扫 `app/src/`）与 **mock server** 做一致性校验；入向 socket 事件另查前端 emit 是否都在契约内。
  出向另有一道**前端接收面覆盖**检查：`app/public/js/app.js` 的 `handle` 表 + `outOfBand` 表键并集必须精确等于 `AGENT_EVENT_TYPES`（少一个＝事件到达浏览器后静默丢弃，多一个＝死键），同一 type 落进两表也拦（`outOfBand` 在派发时优先，`handle` 那条会变成死代码）。`event-dispatch.js` 的 `DEFAULT_REPLAY_OOB_TYPES` 是 `outOfBand` 的平行副本，同样被钉成逐字一致——漏改它会让新的 OOB 类型被 replay buffer 误入队，在 `resolve('reload')` 时永久丢失。
- `seq` 在一个 `AgentSession` 内递增，前端据此去重。
- `epoch` 标识服务端/实例世代；变化时客户端重置旧的去重基线。
- `sessionId` 与 `instanceId` 分开，避免同一 CLI 会话的逻辑身份和当前 Web 进程实例混淆。
- 每个 AgentSession 保留有界环形缓冲；客户端以 `sync:since` 请求仍在缓冲中的缺口。

环形缓冲不是永久历史。缺口超出缓冲或服务重启时，客户端回退到鉴权的 `session:history`，从 CLI transcript 重建稳定消息。高频瞬态状态不会全部进入永久历史。

## 鉴权与范围边界

```text
AUTH_TOKEN（必备，无它不启动）
        ↓
公网 IdP 策略（可选，当前唯一实现 Cloudflare Access）
        ↓
设备信任（真·本机直连豁免此层，不豁免 token）
        ↓
WORK_DIR / WORKDIRS 范围门
        ↓
CLI permissions.allow + Web 当前权限档
        ↓
Agent 工具审批或用户直接文件编辑
```

第一层是**前提而非选项**（[hard-rules §1「鉴权是启动前提」](hard-rules.md)）：没有 `AUTH_TOKEN`
连 server 都起不来，本机浏览器打开也一样，所以下游各层永远建立在「对方已持令牌」之上。
第二层写成「公网 IdP 策略」而不是具体产品名，是因为核心代码只认 `app/src/auth/auth-strategy.js`
的接口形状；Cloudflare Access 是当前唯一实现，换 IdP 不该动核心。

这些边界互不替代：

- `AUTH_TOKEN` 证明请求持有实例密钥，不代表设备已经获准。
- Cloudflare Access 是公网身份层，不扩大工作区；它替代设备审批（第二因子），不替代 token。
- `WORK_DIR` / `WORKDIRS` 限定路径，不决定 Claude 工具是否自动获批（旧版外置 `workdirs.json` 仍受支持，经 `WORK_DIRS_FILE`；shell env 压过配置文件内联 `WORKDIRS`）。
- Agent 的 `canUseTool` 审批只管理 Agent 自主行为；用户在文件编辑器中点击保存属于直接写入，走独立的范围、大小、哈希与审计防线。

安全摘要见 [README 安全边界](../README.md#安全边界)，部署拓扑见[部署与运维](deployment.md)。

### 设备审批的四个入口

设备信任层的事实源是 `trusted-devices.json`，server 用文件监听把变更广播给在线客户端，因此任一入口批准后其余入口即时生效：

- 桌面端菜单栏（macOS CCM.app）
- Web 端由**已受信任的设备**远程准入
- headless 终端里直接回车 / deny —— **要求 TTY**，launchd 起的 server 没有 TTY，这条入口在受管服务下不可用
- `node scripts/device.js approve|deny <ID>`

新设备入列时会推一条通知，**正文不含设备 ID 与 IP**（推送通道未必端到端加密），并按 5 分钟节流避免同一设备反复重试刷屏。

### 离线唤醒与推送抑制

离线唤醒走 web-push / ntfy。抑制策略按「用户是否可能看不到」分档，而不是按事件重要性：

- **审批、提问、后台任务完成：无条件推。** 这三类都意味着有人在等一个动作，而用户此刻可能锁屏或在别的 app 里。
- **回合完成的 `result`：仅当 approved 房间存在前台可见连接时抑制。** 前台判据是客户端主动上报的 `client:presence`，**不是 socket 是否连着**——手机切后台时 socket 常常还活着，拿连接状态当判据会让用户收不到本该收到的完成通知。

推送 body 默认最小化、不含消息正文；用户可按设备开启「推送内容预览」，之后改发 `previewBody`。实现见 `app/src/ops/notifications.js` 与 `app/src/ops/notify-channels.js`。

## 状态与持久化

| 数据 | 事实源 | 用途 |
|---|---|---|
| Claude 对话 | `~/.claude/projects/` transcript | CLI/Web 续接与稳定历史 |
| Web 实例运行态 | 内存中的 `AgentSession` | 流式 turn、审批、事件缓冲 |
| CCM 控制面 | `CCM_DATA_DIR` | 会话指针、设备、审批、审计、推送、已读位点与缓存 |
| 工作区白名单 | `WORK_DIR` / `WORKDIRS` | 限定可见与可操作目录 |
| Web 驾驶状态栏 | SDK 事件 | 当前模型、上下文、成本、effort |
| CLI 驾驶状态栏 | 可选 statusline 快照 | 终端会话的只读状态展示 |
| CLI 即时信号 | 可选 hooks 投递箱 | Stop / Notification 加速与通知 |

`CCM_DATA_DIR` 不保存 Claude 原始 transcript。清理它会影响 CCM 的控制面状态，但不会等同删除全部 Claude 会话；SDK 真删会话是另一条显式操作。

## 运行时可观测与服务可见性

### 两个鉴权端点

- `GET /health` → `{status, sessionId, busy, versions, buildNonce, timestamp}`
- `GET /metrics` → `{metrics{activeSessions, events, catchUpHits, catchUpReloads, rateLimitLockouts, pushSuccess, pushFailure, ntfyFailure, clientErrors, hookEventsConsumed, hookEventsIgnored, hookPushes}, state, states, timestamp}`

设了 `AUTH_TOKEN` 时两者都需带 `?token=` 或 `x-auth-token` 头，否则 401。`state` / `states` 是 StateProbe 的状态分类：后端产出其中四类，`host_offline` 由客户端心跳判定，后端无从知道自己已经联系不上。

`/metrics` 是**鉴权 JSON 快照，不是 Prometheus 文本**——n=1 自托管默认没有 scraper，多实例 scrape 属于要先改立场的事（见 [hard-rules](hard-rules.md)）。历史回显同样走鉴权的 `session:history` socket 事件；**项目不开无鉴权的 HTTP 数据端点**。

### 服务状态面板：判定化，不是计数器

面板渲染四段：基础信息 + 判定化告警 + 安全日志 + 重启记录。**不展示裸计数器**——一个孤零零的 `pushFailure: 3` 对人没有参照系、无法解读，原始计数留给 `/metrics` 巡检。

告警随 `instances` 广播的 `service{startedAt, deliveryFailure, rateLimitLockout, clientError}` 字段下发，均带 24h 时效窗自动退场。每条告警都要说得出「是谁、为什么」：

- **限速锁定**带 `source`（限速桶 key），前端 `describeRateLimitSource` 分本机 / 局域网 / 公网三档改措辞与判色。**本机来源绝不说成「有人在暴力尝试」**——自己输错一次密码不是攻击。
- **投递失败**带 `reason`，由后端 `describeDeliveryError` 清洗，保证不含 endpoint URL。

两者都走 `metrics.label()` 这张非数值上下文表，不进 `/metrics` 的数值面。

安全日志段读 `audit:get`，这是 `data/audit-records.json` 的唯一读取面：只读、过 deviceApproved 闸、不开 HTTP 端点。

### 服务告警与「需要你」是不同轴，绝不混判

- 顶栏 chip / 角标只表达「点一下就能处理」的待办（审批、提问）。
- 服务告警只活在抽屉「服务」小节与服务状态面板里。

把推送投递失败混进「需要你(N)」会让那个数字失去含义：用户点进去发现无事可做，下次就不再信它。

## 代码入口

- `app/server.js`：兼容启动入口；实际装配在 `app/src/server/app.js`。
- `app/src/agent/agent.js`：`AgentSession`、SDK 映射、权限闸门与环形缓冲。
- `app/src/server/mirror-engine.js`：catchUp 追平调度与镜像状态机（状态自持）。
- `app/src/sessions/history.js`：transcript 读取、历史重建与镜像判定纯函数。
- `app/src/ops/cli-hooks-bridge.js` / `app/src/ops/cli-statusline-bridge.js`：CLI 侧信号与快照消费。
- `app/public/js/app.js` 与 `app/public/js/app/`：客户端状态、事件派发与交互模块。
- `tests/gates/contract-check.js`：双向 Socket.io 事件契约门禁。

目录职责与模块边界见[硬性规则索引](hard-rules.md) §3.3（那份索引同时收录 n=1 取舍与已决技术债）；模型、effort 与 statusline 的跨层变换见[展示契约](display-contracts.md)。
