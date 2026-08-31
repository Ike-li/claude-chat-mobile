// public/js/app/unread-tracker.js —— R65 未读点：本设备「看过哪个会话到什么时候」的持有者。
// 状态在本模块内（app.js 顶层零新增状态）；判定全走 logic/unread.js 纯函数。
// 存储：localStorage 单键 JSON {baselineTs, seen}；读写全程 try/catch——隐私模式 / 容量满时
// 整个功能静默降级为「无未读点」，绝不影响主流程。
// 语义红线：点=看过即清；「需要你」chip/聚合=答过才清。分层不合并（见 logic/unread.js 头注）。
import { isSessionUnread, markSeenEntry, parseUnreadState, serializeUnreadState } from '../logic/unread.js';

const STORAGE_KEY = 'ccm-unread-v1';
const SEEN_CAP = 500;

export function createUnreadTracker({ storage, now = () => Date.now() } = {}) {
  const store = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  let raw = null;
  try { raw = store?.getItem(STORAGE_KEY) ?? null; } catch { /* 读失败 = 按首装走 */ }
  let state = parseUnreadState(raw, now());
  // 首装即把基线落盘：不落的话每次启动都重置基线，「app 关着时来的新活动」永远不亮。
  try { store?.setItem(STORAGE_KEY, serializeUnreadState(state)); } catch { /* 写失败 = 功能降级 */ }

  function markSeen(sessionId) {
    if (!sessionId) return;
    state = { baselineTs: state.baselineTs, seen: markSeenEntry(state.seen, sessionId, now(), SEEN_CAP) };
    try { store?.setItem(STORAGE_KEY, serializeUnreadState(state)); } catch { /* 同上 */ }
  }

  function isUnread(session, { isViewing = false } = {}) {
    if (!session?.id) return false;
    return isSessionUnread({
      lastUsedAt: session.lastUsedAt,
      seenAt: state.seen[session.id],
      baselineTs: state.baselineTs,
      isViewing,
    });
  }

  return { markSeen, isUnread };
}
