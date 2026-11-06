// 会话标题的展示与通知身份纯决策：数据进数据出，不碰 DOM/socket。
import { t } from '../i18n.js';

// 会话标题的展示形态。服务端给无标题会话写死占位「(无标题)」——通知层与 cross-side-parity 认这个字面量，
// 不在那边改——于是前端 `s.title || t(...)` 的兜底永远走不到，英文界面上照样是「(无标题)」（验收 O42）。
// emptyLabel 由调用方给：抽屉里没存过的新会话叫「新会话」，首页叫「无标题会话」，两处本来就不同。
const SERVER_UNTITLED = '(无标题)';
export function displaySessionTitle(title, emptyLabel) {
  const s = typeof title === 'string' ? title.trim() : '';
  if (s === SERVER_UNTITLED) return t('无标题会话');
  return s || emptyLabel;
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

/** 计算「还有 N 个更早的会话」提示用的剩余数。无法计算时返回 null。
 *  pinnedCount：服务端 session:list 补回的「稍后再看」行（被分页挤出本页、手动标过未读），它们也画在列表里，
 *  不减掉会多报（验收 AC-04-13：73 个会话、50 + 1 行可见，提示写 23、实际藏 22）。服务端保证它们不在本页。 */
export function remainingOlderSessionCount(total, visibleCount, pinnedCount = 0) {
  const totalNum = Number(total);
  const visibleNum = Number(visibleCount) + (Number(pinnedCount) || 0);
  if (!Number.isFinite(totalNum) || !Number.isFinite(visibleNum) || totalNum <= visibleNum) return null;
  return Math.floor(totalNum - visibleNum);
}
