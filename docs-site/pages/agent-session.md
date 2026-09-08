# AgentSession
> 长驻 SDK query、权限闸、环形缓冲、排队与中断。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~14 min
- **Estimated Tokens**: ~1520

---

`AgentSession`（位于 `app/src/agent/agent.js`）是驱动 Agent SDK 双向流的核心引擎：负责输入队列调度、权限拦截挂起、SDK 消息向契约信封的映射，以及本地事件环形缓冲。

## 核心职责

- 持有一条到 @anthropic-ai/claude-agent-sdk 的 streaming input 双向长会话（支持基于原有 sessionId 执行 resume）。
- 将 SDK 吐出的原始异步消息流（Chunks / Actions）通过 map() 规范化为标准 agent:event 信封并广播。
- 通过 canUseTool 拦截点实现细粒度的工具放行、挂起与手机卡片审批，维护活跃的审批台账。
- 处理前端的主动中断（interrupt）、排队消息撤回（cancelQueued）、动态切换模型与思考强度（ effort ）。

## 忙碌判定与看门狗

 在途轮次计数。仅由发送（+1）与结果返回/主动中断/撤回成功（-1）闭环结算，严禁双扣。  
    bgTasks  活跃后台子代理/任务表。后台子代理仍在执行时持续刷新心跳，防止被空闲超时误杀。  
    isBusy  `pendingTurns > 0` 或存在未完成的后台任务，或挂起未决的工具审批/用户提问。  
    idle hang watchdog  若 `pendingTurns > 0` 但长达 `IDLE_TIMEOUT_MS` 没有任何新事件产生，触发看门狗强制中断。  
 

## 事件信封与 2000 条环形缓冲

- 标准信封格式： { seq, epoch, sessionId, instanceId, cwd, ts, type, payload } 。
- 分配 seq： 除瞬态进度（ task_progress ）外，每个正式事件分配单调递增的 seq ，写入容量为 2000 条的内存环形缓冲区。
- 离线追平： 客户端断网重连后，仅需上报 sync:since { lastSeq } ，服务端即可从环形缓冲快速补发漏掉的事件。

## SDK 消息映射矩阵 (map)

| SDK 原始消息类型 | CCM 契约事件类型 | 前端渲染与行为 |
| --- | --- | --- |
| content_block_delta (text) | text_delta | 文本流式输出，追加至最新气泡 |
| content_block_delta (thinking) | thinking_delta | 思考流输出，渲染于可折叠思考面板中 |
| tool_use | tool_use | 渲染工具调用卡片（展示入参与执行态） |
| tool_result | tool_result | 回填工具执行结果（支持大输出折叠展示） |
| canUseTool (未放行) | permission_request | 挂起等待，向移动端投递审批交互卡片 |
| AskUserQuestion | question | 在输入区域上方弹出单选/多选题交互面板 |
| turn_complete | result | 轮次收尾，回传 Token 消耗并持久化状态 |

## 权限闸 (canUseTool) 执行时序

```mermaid
sequenceDiagram
  participant CLI as Claude CLI
  participant SDK as Agent SDK
  participant AS as AgentSession
  participant S as Server
  participant UI as 手机端 UI

  CLI->>SDK: 请求执行工具 (如 Bash)
  SDK->>AS: canUseTool(tool, input)
  AS->>AS: 校验 settingSources 自动白名单
  alt 命中用户本地白名单
    AS-->>SDK: allow (直接放行)
  else 未命中预设白名单
    AS->>S: 派发 permission_request 事件
    S->>UI: agent:event 信封 (推送+卡片弹窗)
    UI->>S: 发送 user:approve {requestId, allow}
    S->>AS: resolvePermission(allow)
    AS-->>SDK: 返回裁决结果 (allow/deny)
    AS->>UI: 广播 request_resolved 事件
  end
```

## 思考强度 (effort) 运行时热修改

在最新实现中，得益于 SDK 0.3.263 升级，用户在手机端切换思考强度（低、中、高）时，服务端直接调用底层 `applyFlagSettings({effortLevel})` 实时下发至活跃进程。彻底淘汰了早期由于无法热调参而被迫采取的「销毁旧实例 + 重启新实例」低效模式。
