// logic/unread.js —— R65 未读点判定（纯函数：数据进数据出，不碰 DOM/window/storage）
//
// 语义红线（draft/plan-unread-dot-fable-5.md）：点=「有没看过的新内容」，看过即清；
// 与「需要你」chip/抽屉聚合（阻塞等你，答过才清）分层不合并——两者清除条件不同，
// 合并会让「扫一眼」解除本应钉到「答过」的警报。
//
// 判据字段是 session:list 行的 lastUsedAt：上游（src/sessions/history.js scanViaReaddir 头注）
// 已保证它取「最后主链消息时间、无则回落 mtime」，元数据写盘不会推它——假未读风险在上游消化。

// 未读判定。never-seen 会话对比基线（首装不追溯历史）；看过的对比 seenAt；正在看的恒不亮。
export function isSessionUnread({ lastUsedAt, seenAt, baselineTs = 0, isViewing = false } = {}) {
  if (isViewing) return false;
  if (typeof lastUsedAt !== 'number' || !Number.isFinite(lastUsedAt)) return false;
  const seenBar = typeof seenAt === 'number' && Number.isFinite(seenAt) ? seenAt : baselineTs;
  return lastUsedAt > seenBar;
}

// 记「本设备已看过该会话到 now」。不可变更新；超过 cap 时按 ts 淘汰最旧（新记录后写，必留）。
export function markSeenEntry(seen, sessionId, now, cap = 500) {
  if (!sessionId) return seen;
  const next = { ...seen, [sessionId]: now };
  const keys = Object.keys(next);
  if (keys.length > cap) {
    keys.sort((a, b) => next[a] - next[b]);
    for (const k of keys.slice(0, keys.length - cap)) delete next[k];
  }
  return next;
}

// localStorage 原文 → 状态。任何解析失败/形状不对都回落全新状态（基线=now）：
// 隐私模式、首装、坏数据同一条降级路径，绝不抛。已有合法基线必须保留——被 now 覆盖
// 等于每次启动重置基线，点永远不亮。
export function parseUnreadState(raw, now) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof parsed.baselineTs === 'number' && Number.isFinite(parsed.baselineTs)) {
      const seen = {};
      const src = (parsed.seen && typeof parsed.seen === 'object' && !Array.isArray(parsed.seen)) ? parsed.seen : {};
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'number' && Number.isFinite(v)) seen[k] = v;
      }
      return { baselineTs: parsed.baselineTs, seen };
    }
  } catch { /* 坏 JSON → 全新状态 */ }
  return { baselineTs: now, seen: {} };
}

export function serializeUnreadState(state) {
  return JSON.stringify({ baselineTs: state.baselineTs, seen: state.seen });
}
