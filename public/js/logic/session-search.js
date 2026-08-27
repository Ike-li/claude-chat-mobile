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

// 系统通知横幅身份。与 src/ops/notifications.js 同语义（两侧不能互相 import，边界闸）：
// 事件 · 项目目录尾段 · 会话短标题。占位「新会话」不加——那等于没说是哪条。
const NOTIFY_SESSION_TITLE_CAP = 40;
const NOTIFY_TITLE_PLACEHOLDERS = new Set(['新会话', '(无标题)', 'New session']);

export function sanitizeNotifySessionTitle(raw) {
  if (typeof raw !== 'string') return '';
  const one = raw.replace(/\s+/g, ' ').trim();
  if (!one || NOTIFY_TITLE_PLACEHOLDERS.has(one)) return '';
  return one.length > NOTIFY_SESSION_TITLE_CAP ? `${one.slice(0, NOTIFY_SESSION_TITLE_CAP)}…` : one;
}

function projectFromCwd(cwd) {
  const s = String(cwd || '').replace(/[/\\]+$/, '');
  if (!s) return '';
  return s.split(/[/\\]/).pop() || '';
}

export function formatNotifyIdentity(eventTitle, { cwd, sessionTitle } = {}) {
  const parts = [];
  if (eventTitle) parts.push(eventTitle);
  const proj = projectFromCwd(cwd);
  if (proj) parts.push(proj);
  const sess = sanitizeNotifySessionTitle(sessionTitle);
  if (sess) parts.push(sess);
  return parts.join(' · ');
}

export function notifySessionTag(sessionId) {
  return (typeof sessionId === 'string' && sessionId) ? `ccm-${sessionId}` : 'ccm-push';
}

// 抽屉缓存（SDK summary，和用户看见的行同源）优先；否则 instances 广播的 firstMessage 截断。
export function lookupNotifySessionTitle({ sessionId, cwd, sessionsCache, instances } = {}) {
  if (!sessionId) return '';
  const cached = cwd && sessionsCache?.get?.(cwd)?.sessions?.find(s => s.id === sessionId)?.title;
  const fromCache = sanitizeNotifySessionTitle(cached);
  if (fromCache) return fromCache;
  const inst = (instances || []).find(x => x.sessionId === sessionId)?.title;
  return sanitizeNotifySessionTitle(inst);
}

// cwd 聚合态（notifyStateChanges）分不出是哪条会话：同目录多条 live 都 done/error 时
// find(cwd+state) 会命中插入序更早的那条。只标项目，sessionId 显式 null（否则 notify 包装会掉进当前查看会话）。
export function otherWorkspaceNotifyOpts(cwd) {
  const project = projectFromCwd(cwd);
  return {
    cwd: cwd || null,
    sessionId: null,
    tag: project ? `ccm-cwd-${project}` : 'ccm-push',
  };
}

/** 计算「还有 N 个更早的会话」提示用的剩余数。无法计算时返回 null。 */
export function remainingOlderSessionCount(total, visibleCount) {
  const totalNum = Number(total);
  const visibleNum = Number(visibleCount);
  if (!Number.isFinite(totalNum) || !Number.isFinite(visibleNum) || totalNum <= visibleNum) return null;
  return Math.floor(totalNum - visibleNum);
}
