// public/js/app/unread-tracker.js —— R65（2026-08-30 需求合稿）未读点：「看过哪个会话到什么时候」的持有者。
// 状态在本模块内（app.js 顶层零新增状态）；判定全走 logic/unread.js 纯函数。
// 语义红线：点=看过即清；「需要你」chip/聚合=答过才清。分层不合并（见 logic/unread.js 头注）。
//
// 存储两层（2026-09-03 起）：
//   · 权威在服务端 data/read-state.json（跨设备共享，socket 的 read:sync / read:mark）；
//   · localStorage 单键 JSON {baselineTs, seen, manual} 降级为离线缓存——读写全程 try/catch，
//     隐私模式 / 容量满时整个功能静默降级为「无未读点」，绝不影响主流程。
// 改造前位点只在本地，换设备后 seen 表为空、全部回落到「本设备首次打开时刻」这个很老的基线，
// 于是在另一台设备上读过的会话整屏复亮——那正是这次要修的症状。
//
// 两个「记已看」入口刻意分开（2026-09-02 手动未读）：
//   markSeen    —— 离场侧（bindView 切走旧会话）：只记「看到此刻」，不动手动标记；
//   markEntered —— 入场侧（bindView 进入真实会话）：看过 + 手动标记作废，是手动未读唯一的自动清除点。
// 合成一个会让「正看着时长按标为未读」在离开的瞬间被离场记录清掉，标记形同虚设。
import {
  isSessionUnread, markSeenEntry, setManualUnreadEntry, parseUnreadState, serializeUnreadState,
  isManualUnreadNow, mergeReadState,
} from '../logic/unread.js';

const STORAGE_KEY = 'ccm-unread-v1';
const SEEN_CAP = 500;
const MANUAL_CAP = 100;

// onChange：写入点的增量上报口（app.js 转成 socket 的 read:mark）。不注入时功能退化为纯本地，
// 离线壳与老接线都照常工作。
export function createUnreadTracker({ storage, now = () => Date.now(), onChange = null } = {}) {
  const store = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  let raw = null;
  try { raw = store?.getItem(STORAGE_KEY) ?? null; } catch { /* 读失败 = 按首装走 */ }
  let state = parseUnreadState(raw, now());

  function persist() {
    try { store?.setItem(STORAGE_KEY, serializeUnreadState(state)); } catch { /* 写失败 = 功能降级 */ }
  }
  // 首装即把基线落盘：不落的话每次启动都重置基线，「app 关着时来的新活动」永远不亮。
  // （连上服务端后这个本地基线会被 hydrate 换成全局基线，见下。）
  persist();

  function emit(payload) {
    try { onChange?.(payload); } catch { /* 上报失败不拖累本地状态 */ }
  }

  // 离场：只在【当前不是手动未读态】时记 seen。新判据是 manual[id] > seen[id]，写下这一笔就等于
  // 当场把刚标的「稍后再看」清掉——旧判据（manual 里有条目即未读）下无害，改判据后就成了红线破口。
  function markSeen(sessionId) {
    if (!sessionId) return;
    if (isManualUnreadNow(state.manual, state.seen, sessionId)) return;
    const ts = now();
    state = { ...state, seen: markSeenEntry(state.seen, sessionId, ts, SEEN_CAP) };
    persist();
    emit({ sessionId, seenAt: ts });
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
    emit({ sessionId, seenAt: ts });
  }

  // 长按「标为未读 / 标为已读」。标为已读要同时记 seen——只删手动标记的话，时间判据（lastUsedAt > seenAt）
  // 仍会让它亮，用户看到的就是「点了没反应」；跨设备下还会被别的设备的旧标记合并回来复活。
  function setManualUnread(sessionId, on) {
    if (!sessionId) return;
    const ts = now();
    state = {
      ...state,
      manual: setManualUnreadEntry(state.manual, sessionId, Boolean(on), ts, MANUAL_CAP),
      seen: on ? state.seen : markSeenEntry(state.seen, sessionId, ts, SEEN_CAP),
    };
    persist();
    emit({ sessionId, manual: Boolean(on), at: ts });
  }

  // 下行同步：服务端权威态并入本地。【不】触发 onChange——那是上行口，回声会绕成写放大。
  // 返回值是「内容真的变了吗」，不是「远端有没有回话」：调用方拿它决定要不要重画会话列表，而
  // session:list 每趟都会捎一份 readState 回来。恒 true 会让每次 SWR revalidate 都重建 DOM 子树，
  // 打掉 shouldRerenderSessionList 的省渲优化（P0-11t/11z 钉的正是这条）。
  function hydrate(remote) {
    const next = mergeReadState(state, remote, { seenCap: SEEN_CAP, manualCap: MANUAL_CAP });
    if (next === state) return false; // 远端无效：本地原样保留，功能降级回每设备独立
    const before = serializeUnreadState(state);
    state = next;
    if (serializeUnreadState(state) === before) return false;
    persist();
    return true;
  }

  // 连上后把本地表整个推给服务端归并：升级前攒的已读记录、离线期间的新记录都靠这一趟迁移上去。
  function snapshot() {
    return { baselineTs: state.baselineTs, seen: { ...state.seen }, manual: { ...state.manual } };
  }

  function isUnread(session, { isViewing = false } = {}) {
    if (!session?.id) return false;
    return isSessionUnread({
      lastUsedAt: session.lastUsedAt,
      seenAt: state.seen[session.id],
      baselineTs: state.baselineTs,
      isViewing,
      manual: isManualUnreadNow(state.manual, state.seen, session.id),
    });
  }

  // 「是否手动标过」的独立查询口，与 isUnread（含时间判据）区分开。2026-09-07 前长按菜单靠它绕开
  // 「正看着的 isUnread 恒 false」；那条短路已按管辖面收窄、菜单改问 isUnread，此口现只剩测试直读内部表。
  function isManualUnread(sessionId) {
    return isManualUnreadNow(state.manual, state.seen, sessionId);
  }

  return { markSeen, markEntered, setManualUnread, isManualUnread, isUnread, hydrate, snapshot };
}
