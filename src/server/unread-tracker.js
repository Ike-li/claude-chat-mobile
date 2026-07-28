// unread-tracker.js —— 未读消息计数判断纯函数（是否有人在看 / 这条事件是否算一条新顶层消息）
// 拆出而非散落在 onEvent 大回调里的原因：与 instance-latches.js#deriveLatches 同样的考虑——
// "是否计未读"要同时满足两个独立判断（有没有人在看 + 这条事件是不是一条新的顶层消息），
// 混在一起写容易在补分支时顾此失彼，拆纯函数才能各自穷举分支单测。

// 是否有人正在看这个实例：viewingInstanceId 是全局唯一值（项目采用"镜像视图"架构，见 public/js/app.js
// setInstances() 的跟随切换逻辑——任意设备收到不一致的 viewingInstanceId 广播就会自动切过去），但只比较
// id 不够：同一会话锁屏/切后台会断开 socket、但 viewingInstanceId 全程不变，必须叠加"approved 房间是否
// 还有活连接"，否则这个最常见的"离开"场景会被误判为"仍在看"、未读永远不计。
// 第三参数是「approved 房间里还有【前台可见】的连接吗」（hasForegroundApprovedClient 的结果），
// 不是房间连接数。二者的差别正是 PWA 的常态：切后台后 socket 往往还连着（要等 OS 冻结页面才真断），
// 只看「有没有连接」会把这段窗口判成「有人在看」→ 一条未读都不计。而推送侧早已按 socket.data.hidden
// 判前台（见 src/ops/notifications.js 的同名修复），两边判据不一致就会出现最难解释的组合：
// 手机收到了「✅ 任务完成」推送，点回去却是 0 未读、没有「以下为新消息」分割线。
export function isInstanceBeingWatched(id, viewingInstanceId, hasForegroundClient) {
  if (id == null || id !== viewingInstanceId) return false;
  return hasForegroundClient === true;
}

// 这条 envelope 是否代表一条新出现的"顶层消息"（未读计数的颗粒度：用户消息 + assistant 文字回复，
// 不含工具调用/thinking），以及去重游标 lastCountedMessageId 的下一个值（调用方应无条件写回，
// 未变化时值不变，天然幂等）。user_message 每次 send() 恰好 emit 一次，天然不重复；text_delta 只认
// 主链（parentToolUseId 非空=子agent/侧链，不算），且同一 messageId 只在第一次出现文本时算一次——
// 与前端渲染出的顶层气泡数保持一一对应，避免"未读数"和"跳转到第 N 条"的颗粒度对不上。
export function resolveUnreadDelta({ eventType, payload, lastCountedMessageId = null }) {
  if (eventType === 'user_message') return { counts: true, lastCountedMessageId };
  if (eventType === 'text_delta') {
    if (payload?.parentToolUseId) return { counts: false, lastCountedMessageId };
    const messageId = payload?.messageId ?? null;
    if (!messageId || messageId === lastCountedMessageId) return { counts: false, lastCountedMessageId };
    return { counts: true, lastCountedMessageId: messageId };
  }
  return { counts: false, lastCountedMessageId };
}
