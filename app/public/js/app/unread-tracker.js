// public/js/app/unread-tracker.js —— R65 未读点：本设备「看过哪个会话到什么时候」的持有者。
// 状态在本模块内（app.js 顶层零新增状态）；判定全走 logic/unread.js 纯函数。
// 存储：localStorage 单键 JSON {baselineTs, seen, manual}；读写全程 try/catch——隐私模式 / 容量满时
// 整个功能静默降级为「无未读点」，绝不影响主流程。
// 语义红线：点=看过即清；「需要你」chip/聚合=答过才清。分层不合并（见 logic/unread.js 头注）。
//
// 两个「记已看」入口刻意分开（2026-09-02 手动未读）：
//   markSeen    —— 离场侧（bindView 切走旧会话）：只记「看到此刻」，不动手动标记；
//   markEntered —— 入场侧（bindView 进入真实会话）：看过 + 手动标记作废，是手动未读唯一的自动清除点。
// 合成一个会让「正看着时长按标为未读」在离开的瞬间被离场记录清掉，标记形同虚设。
import { isSessionUnread, markSeenEntry, setManualUnreadEntry, parseUnreadState, serializeUnreadState } from '../logic/unread.js';

const STORAGE_KEY = 'ccm-unread-v1';
const SEEN_CAP = 500;
const MANUAL_CAP = 100;

export function createUnreadTracker({ storage, now = () => Date.now() } = {}) {
  const store = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  let raw = null;
  try { raw = store?.getItem(STORAGE_KEY) ?? null; } catch { /* 读失败 = 按首装走 */ }
  let state = parseUnreadState(raw, now());

  function persist() {
    try { store?.setItem(STORAGE_KEY, serializeUnreadState(state)); } catch { /* 写失败 = 功能降级 */ }
  }
  // 首装即把基线落盘：不落的话每次启动都重置基线，「app 关着时来的新活动」永远不亮。
  persist();

  function markSeen(sessionId) {
    if (!sessionId) return;
    state = { ...state, seen: markSeenEntry(state.seen, sessionId, now(), SEEN_CAP) };
    persist();
  }

  function markEntered(sessionId) {
    if (!sessionId) return;
    const ts = now();
    state = {
      ...state,
      seen: markSeenEntry(state.seen, sessionId, ts, SEEN_CAP),
      manual: setManualUnreadEntry(state.manual, sessionId, false),
    };
    persist();
  }

  // 长按「标为未读 / 标为已读」。标为已读要同时记 seen——只删手动标记的话，时间判据（lastUsedAt > seenAt）
  // 仍会让它亮，用户看到的就是「点了没反应」。
  function setManualUnread(sessionId, on) {
    if (!sessionId) return;
    const ts = now();
    state = {
      ...state,
      manual: setManualUnreadEntry(state.manual, sessionId, Boolean(on), ts, MANUAL_CAP),
      seen: on ? state.seen : markSeenEntry(state.seen, sessionId, ts, SEEN_CAP),
    };
    persist();
  }

  function isUnread(session, { isViewing = false } = {}) {
    if (!session?.id) return false;
    return isSessionUnread({
      lastUsedAt: session.lastUsedAt,
      seenAt: state.seen[session.id],
      baselineTs: state.baselineTs,
      isViewing,
      manual: Boolean(state.manual[session.id]),
    });
  }

  // 正看着的会话 isUnread 恒 false（红线），长按菜单要知道它「是否已标过」得单独问。
  function isManualUnread(sessionId) {
    return Boolean(sessionId && state.manual[sessionId]);
  }

  return { markSeen, markEntered, setManualUnread, isManualUnread, isUnread };
}
