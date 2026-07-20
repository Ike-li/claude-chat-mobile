// message-dedup.js —— 客户端消息 ID 去重（纯函数，承接 REL-01：离线输入幂等）
//
// 断线重连后离线队列重发 user:message 此前无 clientMessageId/去重，网络抖动可能致同一条消息
// 被处理两次。本模块只做"是否已处理过"的判定 + 有界记录，状态外置（调用方持有 Map<clientMessageId, ts>）；
// n=1 场景内存态即可（重启清零可接受，同 rate-limiter.js 的取舍）。

export const DEDUP_CAP = 500; // 有界窗口上限：超出后清最旧一条（Map 保插入序，近似 LRU），防内存无限增长

// 纯函数：只【查询】clientMessageId 是否已处理过，无副作用。
// 无 ID（旧客户端未传/未升级）→ 恒 false（不去重），保持向后兼容。
export function isProcessed(clientMessageId, state) {
  if (!clientMessageId) return false;
  return state.has(clientMessageId);
}

// 纯函数：【提交】一个已成功处理的 clientMessageId（有界窗口）。返回新 state（幂等：已存在则原样返回引用）。
// 无 ID → 原样返回。BE-002：调用方必须在消息真正成功入队后才 commit——校验失败/队满失败时【不要】commit，
// 否则失败的 ID 被提前登记，第二次重发命中去重被当作成功静默丢弃。
export function commitProcessed(clientMessageId, state, cap = DEDUP_CAP) {
  if (!clientMessageId) return state;
  if (state.has(clientMessageId)) return state;
  const next = new Map(state);
  next.set(clientMessageId, Date.now());
  if (next.size > cap) {
    next.delete(next.keys().next().value); // 最旧的一条（插入序首位）
  }
  return next;
}

// 查询 + 提交耦合成一步的旧原语（保留给不区分成败的调用方）。等价于 isProcessed 后 commitProcessed。
// 注意：把「登记」与「成功」绑死，不适合需要「失败不登记」的路径（见 commitProcessed 说明）。
export function checkAndRecord(clientMessageId, state = new Map(), cap = DEDUP_CAP) {
  if (isProcessed(clientMessageId, state)) return { duplicate: true, next: state };
  return { duplicate: false, next: commitProcessed(clientMessageId, state, cap) };
}

// ---- 处理中占用（区别于上面「已处理完」的永久记录）----
// isProcessed/commitProcessed 之间横跨校验、resolveTarget、a.send 等多个 await，不是原子的：断线重连
// 重发可能让同一 clientMessageId 的第二个请求在第一个请求 commit 之前就跑到同一段代码，两边各自调一次
// a.send() 造成真实的重复发送（不只是重复 ack）。这里补一层"眼下有没有人正处理这条、尚未落定成败"的
// 临时占用——处理结束【无论成功失败】都必须 release，否则失败重试会被永久卡在"仍在处理中"（对称于
// commitProcessed 的"失败不 commit"：这里是"失败也要 release"，调用方应在 try/finally 里 release）。

// 纯函数：是否有人正在处理这条 clientMessageId、尚未 release。
export function isInFlight(clientMessageId, inFlightSet) {
  if (!clientMessageId) return false;
  return inFlightSet.has(clientMessageId);
}

// 纯函数：声明"我在处理这条了"。已被占用则原样返回（幂等，不产生新引用）。
export function claimInFlight(clientMessageId, inFlightSet) {
  if (!clientMessageId) return inFlightSet;
  if (inFlightSet.has(clientMessageId)) return inFlightSet;
  const next = new Set(inFlightSet);
  next.add(clientMessageId);
  return next;
}

// 纯函数：释放占用（无论处理成功还是失败都要调用）。未占用则原样返回。
export function releaseInFlight(clientMessageId, inFlightSet) {
  if (!clientMessageId || !inFlightSet.has(clientMessageId)) return inFlightSet;
  const next = new Set(inFlightSet);
  next.delete(clientMessageId);
  return next;
}
