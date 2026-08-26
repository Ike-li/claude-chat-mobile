// 会话标题搜索纯决策：数据进数据出，不碰 DOM/socket。
// 与 src/sessions/history.js 同语义（两侧不能互相 import，边界闸）。

/** 标题子串匹配（大小写不敏感）。空/空白 query 视为全匹配。 */
export function matchesSessionTitle(title, query) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return true;
  return String(title || '').toLowerCase().includes(q);
}

/** 搜索匹配键：抽屉可见 summary + readHeadMeta 各字段。空串不进。 */
export function sessionTitleSearchKeys({ summary, aiTitle, firstUser, firstCmd } = {}) {
  const keys = [];
  for (const raw of [summary, aiTitle, firstUser, firstCmd]) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s) keys.push(s);
  }
  return keys;
}

/** 任一匹配键命中即可。空 query 全匹配。 */
export function matchesSessionSearch(keys, query) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return true;
  return (Array.isArray(keys) ? keys : []).some(k => matchesSessionTitle(k, q));
}

/** 列表展示标题：优先 SDK summary（与浏览行 / CLI /resume 同源），否则 meta，再否则占位。 */
export function resolveSessionListTitle({ summary, metaTitle } = {}) {
  const s = typeof summary === 'string' ? summary.trim() : '';
  if (s) return s;
  const m = typeof metaTitle === 'string' ? metaTitle.trim() : '';
  if (m) return m.length > 60 ? m.slice(0, 60) : m;
  return '(无标题)';
}

/** 计算「还有 N 个更早的会话」提示用的剩余数。无法计算时返回 null。 */
export function remainingOlderSessionCount(total, visibleCount) {
  const totalNum = Number(total);
  const visibleNum = Number(visibleCount);
  if (!Number.isFinite(totalNum) || !Number.isFinite(visibleNum) || totalNum <= visibleNum) return null;
  return Math.floor(totalNum - visibleNum);
}
