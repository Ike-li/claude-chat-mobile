// queued-message-policy.js —— 排队消息的判定纯函数与常量（调度在 server/message-queue.js）。

export const MAX_QUEUED_TOTAL = 20;     // 全局条数上限：防止常驻进程里无限累积，每条可带 20MB 附件
export const QUEUE_PREVIEW_CHARS = 140; // 卡片预览。instances 广播有近三十个触发点，不下发全文

// 回合正常结束后等 CLI 报 idle 的上限。CLI 一直不报时兜底放行：后台子 agent 占着（实测主循环结束后 idle 要等它们
// 跑完，但这时发消息会立刻开跑），或者 CLI 没有这个帧。汇报轮的 init 在 result 后 7–36ms 到（2.1.318 实测），
// 余量留给 hook 和慢盘。估小了只是消息提前进 CLI 队列排在汇报轮后面，账面不会错。
export const QUEUE_SETTLE_MS = 1500;

/**
 * 这一轮的结局能不能替用户发下一条。
 * 不看 subtype：额度墙和 API 错误都是 subtype:'success' + is_error:true（2.1.318 实测）。
 * 缺 terminal_reason 算正常：本地命令的 result 没有这个字段。除此之外只认 completed，上游新增死因时默认停下。
 * @returns {{kind:'release'} | {kind:'hold', reason:string}}
 */
export function classifyTurnEnd({ isError, interrupted, approvalExpired, terminalReason }) {
  if (interrupted) return { kind: 'hold', reason: 'interrupted' };
  if (isError) return { kind: 'hold', reason: 'turn_error' };
  if (approvalExpired) return { kind: 'hold', reason: 'approval_expired' };
  if (terminalReason != null && terminalReason !== 'completed') return { kind: 'hold', reason: 'incomplete' };
  return { kind: 'release' };
}

// 未发送要不要推送、进「需要你」：用户自己点的停止、关闭会话是他刚做的事，再提醒就是打扰；其余原因用户多半不在，
// 不推就没人知道这句话停在那里。认不出的原因按提醒算——漏推比多推一条代价大。
const HELD_SILENT_REASONS = new Set(['stopped', 'closed']);
export const heldNeedsAttention = reason => !HELD_SILENT_REASONS.has(reason);
