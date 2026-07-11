// message-dedup.js —— 客户端消息 ID 去重（纯函数，承接 REL-01：离线输入幂等）
//
// 断线重连后离线队列重发 user:message 此前无 clientMessageId/去重，网络抖动可能致同一条消息
// 被处理两次。本模块只做"是否已处理过"的判定 + 有界记录，状态外置（调用方持有 Map<clientMessageId, ts>）；
// n=1 场景内存态即可（重启清零可接受，同 rate-limiter.js 的取舍）。

export const DEDUP_CAP = 500; // 有界窗口上限：超出后清最旧一条（Map 保插入序，近似 LRU），防内存无限增长

// 纯函数：判断 clientMessageId 是否已处理过。
// 无 ID（旧客户端未传/未升级）→ 不去重、原样放行，保持向后兼容。
export function checkAndRecord(clientMessageId, state = new Map(), cap = DEDUP_CAP) {
  if (!clientMessageId) return { duplicate: false, next: state };
  if (state.has(clientMessageId)) return { duplicate: true, next: state };
  const next = new Map(state);
  next.set(clientMessageId, Date.now());
  if (next.size > cap) {
    next.delete(next.keys().next().value); // 最旧的一条（插入序首位）
  }
  return { duplicate: false, next };
}
