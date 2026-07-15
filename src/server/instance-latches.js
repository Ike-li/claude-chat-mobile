// instance-latches.js —— 实例状态 latch（done/error/aborted）派生纯函数
//
// 三个 latch 互斥（同一 instanceId 同一时刻至多命中一个），供 server.js 的 instanceState() 在
// "无在途轮次/无待批审批/无后台任务"时才落到这三者之一（否则 idle）。分出纯函数而非散落在
// onEvent 大回调里的原因：done/error 的既有规则（"只在非 viewing 时才 latch，前台自己看事件流即可"）
// 与 aborted 的规则（"必须无条件 latch，因为中止操作本身几乎总发生在 viewing 的前台会话"）不对称——
// 若照搬同一形态实现，容易在 result 事件到达时漏清另一侧的 aborted（见测试："中止后前台又正常完成一轮"）。
export function deriveLatches({ inDone, inError, inAborted, eventType, isError, isViewing, wasInterrupted }) {
  if (eventType === 'system_interrupted') {
    // 中止是用户主动操作，不论是否 viewing 都要能在 instancesPayload().state 里反映"已中止"——
    // 前台会话的中止入口是唯一实际使用路径（public/js/app.js 只对 viewingInstanceId 发 user:interrupt），
    // 若照抄 done/error"只在非 viewing 时 latch"会导致这个新状态在最常见场景下永远不触发。
    return { done: false, error: false, aborted: true };
  }
  if (eventType === 'result') {
    // 实证发现：真实 SDK 在 interrupt() 成功后，消息流会紧接着自己吐出一条 result 终结这一轮
    // （即便 isError:true）——这不是独立的新错误，是这次中断的终态确认，须保持 aborted、不落 done/error，
    // 否则"已中止"这个状态刚置位就被自己触发的伴随 result 立即抹掉（agent.js 已标记 payload.interrupted）。
    if (wasInterrupted) return { done: false, error: false, aborted: true };
    // aborted 无论是否 viewing 都必须清除：一旦有新的完整轮次结果落地（非中断导致），"中止"已成历史，
    // 不该继续显示（即便这次仍在前台、done/error 按既有规则不 latch）。
    if (isViewing) return { done: inDone, error: inError, aborted: false };
    return isError ? { done: false, error: true, aborted: false } : { done: true, error: false, aborted: false };
  }
  if (eventType === 'new_activity') { // init / permission_request / question：新一轮活动开始，旧终态标记全部作废
    return { done: false, error: false, aborted: false };
  }
  return { done: inDone, error: inError, aborted: inAborted }; // 其它事件不影响三者
}
