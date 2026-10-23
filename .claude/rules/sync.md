---
paths:
  - "app/src/agent/**"
  - "app/src/sessions/**"
  - "app/src/server/**"
  - "app/src/ops/notif*.js"
  - "app/src/shared/protocol.js"
  - "app/public/js/app.js"
  - "app/public/js/app/**"
---

# 同步、推送、镜像锁、回放

改这几处之前先读 [docs/architecture.md](../../docs/architecture.md)，判据和参数都在那里，凭直觉改基本会错。

- 出向统一收敛成 `agent:event` 信封，type 白名单是 `app/src/shared/protocol.js` 的 `AGENT_EVENT_TYPES`；seq+epoch 去重回放；`npm run check` 校验双向事件契约。
- 并存的通道：Web 驾驶走 Agent SDK 双向流；CLI 终端驾驶**不经过 SDK**，靠磁盘 transcript 轮询同步只读镜像；「单驾驶员模型」防两端同时写分叉；设备审批走文件监听广播；离线唤醒走 web-push/ntfy。
- **推送抑制**：审批、提问、后台任务完成**无条件推**（用户可能锁屏或在别的 app）。只有回合完成的 `result` 与网关静默告警（`system` 信封里的 `gateway_stall` notice）在「approved 房间有前台可见连接」时才抑制，两者共用 `notifyHasClientsAtSend` 那条判据。前台判据是客户端上报的 `client:presence`，不是 socket 连着。
- 「后台任务完成」**只算真后台任务**：CLI 把跑得久的前台 Bash 也建模成 task、走同一条 `task_notification`，靠 `task_started` 的 `is_backgrounded` 过滤掉。别把这道过滤当多余删掉，删了每条跑几秒的命令都会推到锁屏手机上。
