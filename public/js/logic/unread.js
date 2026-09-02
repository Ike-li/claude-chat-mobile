// logic/unread.js —— R65 未读点判定（纯函数：数据进数据出，不碰 DOM/window/storage）
//
// 语义红线（draft/plan-unread-dot-fable-5.md）：点=「有没看过的新内容」，看过即清；
// 与「需要你」chip/抽屉聚合（阻塞等你，答过才清）分层不合并——两者清除条件不同，
// 合并会让「扫一眼」解除本应钉到「答过」的警报。
//
// 判据字段是 session:list 行的 lastUsedAt：上游（src/sessions/history.js scanViaReaddir 头注）
// 已保证它取「最后主链消息时间、无则回落 mtime」，元数据写盘不会推它——假未读风险在上游消化。
//
// 手动未读（2026-09-02，长按「标为未读」）：用户显式要求「稍后再看」，压过时间判据；
// 唯一的自动清除点是「再次打开该会话」（tracker 的 markEntered），离场记 seen 不动它——
// 否则「正看着时标一下、离开就被离场记录清掉」，标记形同虚设。

// 未读判定。never-seen 会话对比基线（首装不追溯历史）；看过的对比 seenAt；正在看的恒不亮；
// manual=true 时不看时间（标记不依赖 lastUsedAt 字段）。
export function isSessionUnread({ lastUsedAt, seenAt, baselineTs = 0, isViewing = false, manual = false } = {}) {
  if (isViewing) return false;
  if (manual) return true;
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

// 手动未读表的不可变增删：on=true 记入标记时刻（复用 seen 表同一套「记 ts + 超限淘汰最旧」），
// on=false 移除；不存在时原样返回同一对象，调用方可据此免写盘。
export function setManualUnreadEntry(manual, sessionId, on, now, cap = 100) {
  if (!sessionId) return manual;
  if (on) return markSeenEntry(manual, sessionId, now, cap);
  if (!(sessionId in manual)) return manual;
  const next = { ...manual };
  delete next[sessionId];
  return next;
}

// localStorage 原文 → 状态。任何解析失败/形状不对都回落全新状态（基线=now）：
// 隐私模式、首装、坏数据同一条降级路径，绝不抛。已有合法基线必须保留——被 now 覆盖
// 等于每次启动重置基线，点永远不亮。manual 字段是后加的：旧落盘缺它时回空表，不重置基线/seen。
export function parseUnreadState(raw, now) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof parsed.baselineTs === 'number' && Number.isFinite(parsed.baselineTs)) {
      return { baselineTs: parsed.baselineTs, seen: numericMap(parsed.seen), manual: numericMap(parsed.manual) };
    }
  } catch { /* 坏 JSON → 全新状态 */ }
  return { baselineTs: now, seen: {}, manual: {} };
}

// 只保留「值是有限数」的条目——防手改/旧版本残留把非数字混进比较。
function numericMap(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function serializeUnreadState(state) {
  return JSON.stringify({ baselineTs: state.baselineTs, seen: state.seen, manual: state.manual || {} });
}
