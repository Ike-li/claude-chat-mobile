# 事件信封与同步
> agent:event 信封、seq/epoch、sync:since、catch-up。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1594

---

系统同步的最小单位是带单调序号的事件信封（Envelope），而不是整页重新渲染。客户端依靠 `seq` 与 `epoch` 实现高效去重与丢包补全；磁盘侧辅以 Catch-up 机制追平终端 CLI 写入。

## 标准事件信封 (agent:event)

```
{
  seq,         // 实例内单调自增序号 (1, 2, 3...)
  epoch,       // 实例世代 ID，实例重建后递增
  sessionId,   // 关联的 Claude 会话 UUID
  instanceId,  // 内存 Agent 实体代号 (如 inst_1)
  cwd,         // 运行工作目录
  ts,          // 服务端生成的精确 ISO 时戳
  type,        // 契约白名单内的事件类型 (当前共 31 种)
  payload      // 业务具体数据载荷
}
```

- 序列号 seq： 实例内唯一单调自增，用于客户端网络断开重连后的 sync:since 增量补发。
- 世代号 epoch： 用于标示实例生命周期变更。当发生外部变脏（ externalDirty ）导致的销毁置换或实例回收重建时递增。客户端一旦检测到 epoch 变更，必须重置 lastSeq 去重基线。
- 环形缓冲： 每个会话在内存维护容量为 2000 条的环形队列（ BUFFER_CAP ），溢出时丢弃最旧数据，若客户端落后过多则提示 gap。

## 分流与广播控制策略

- 房间广播。 业务事件统一广播给已批准设备的 Socket 房间（ approved 命名空间）。
- 高频流式节流（Bandwidth Saver）。 高频的文本流（ text_delta ）与思考流（ thinking_delta ），仅当该实例是用户当前聚焦查看的 viewingInstanceId 时才下发。后台标签页只将事件写入环形缓冲，切回前台时通过 sync:since 批量回放，极大节约移动端蜂窝流量。
- 跨设备已读位点共享。 服务端统一记录会话的已读游标。手动置为未读通过时间戳比对（ manual > seen ）合并，保证手机端长按标为未读的状态能在桌面端和其他设备同步展现。

## 断线快速重连：sync:since 协议

1. 手机端从后台切回或网络闪断重连后，主动发送 sync:since { sessionId, lastSeq, instanceId } 。
2. 服务端提取环形缓冲中大于 lastSeq 的事件子集。
3. 自动过滤已完成（resolved）的历史审批与提问，避免向用户重弹旧卡片。
4. 若客户端请求的 lastSeq 早于环形缓冲中最旧的一条，回传携带 gap: true ，客户端触发完整历史拉取。
5. 回放有超时兜底： sync:since 的 ack 超时后转拉磁盘历史，而不是让加载卡一直转；ack 迟到也不会丢掉已积压的事件。
6. 回放出来的事件对运行态中性：已经结束的回合不会因为回放被重新点亮成「运行中」，回放后再按广播口径对一次账。

## 出向 31 种契约事件分组

| 业务功能分组 | 出向事件类型 (type) |
| --- | --- |
| 流式输出 | text_delta 、 thinking_delta 、 result |
| 工具调用 | tool_use 、 tool_result |
| 人机交互与审批 | permission_request 、 question 、 request_resolved 、 prompt_suggestion |
| 系统与控制 | init 、 system 、 error 、 user_message 、 diag_log |
| 会话状态与配置 | status_line 、 permission_mode 、 effort_mode 、 models 、 mirror_state 、 instances 、 slash_commands 、 session_recap 、 rewind_applied |
| 后台任务与子代理 | task_notification 、 task_progress 、 api_retry |
| 设备与元数据 | device_status 、 pending_devices 、 trusted_devices 、 session_log 、 history_append |

事件定义真相源唯一维护于 `app/src/shared/protocol.js`。`npm run check` 里的 `tests/gates/contract-check.js` 与 `agent-event-contract.js` 对生产代码、mock 与前端做双向校验：改一个 type 必须同时改 protocol、真实的 emit 路径、mock 与前端 handler，否则 check 变红。
