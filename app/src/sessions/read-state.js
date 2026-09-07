// read-state.js —— 跨设备共享的「已读位点」（2026-09-03）。
//
// 【为什么要有这个文件】抽屉的未读标记此前全存前端 localStorage：换一台设备，seen 表是空的、所有会话
// 都回落去跟「本设备首次打开 web 的时刻」这个很老的基线比 → 在另一台设备上读过的会话整屏复亮。
// 位点搬到服务端共享后，localStorage 降级为离线缓存。
//
// 【为什么允许新增落盘】docs/hard-rules.md §1「不新增持久化层」的两个必要条件都满足：① claude 侧不存在
// 「未读」这个概念（CLI 没有已读位点）②「用户什么时候在 web 上看过某会话」不可能从 transcript 重建。
// 且它本身就是缓存类：随时可删、损坏即当作没有（下面 load() 的降级路径），删掉最多是一次全部按基线重来。
//
// 【职责边界】本模块只做「多客户端增量归并 + 落盘」，不做未读判定——判定在 app/public/js/logic/unread.js，
// 前后端不得互相 import（tests/gates/check-import-boundaries.js 硬闸），合并语义两侧各写一份。两份不是
// 冗余：前端是「远端权威覆盖本地」，这边是「多客户端增量归并」，方向与 cap 处理都不同。
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { createSerialWriter } from '../shared/serial-writer.js';
import { dataFile } from '../shared/data-dir.js';

// 与 sessions.js 同款优先级：CCM_READ_STATE_FILE（仅测试）> CCM_DATA_DIR/read-state.json > data/read-state.json。
const FILE = process.env.CCM_READ_STATE_FILE || dataFile('read-state.json');

const SEEN_CAP = 500;    // 与前端 unread-tracker.js 的 SEEN_CAP 同值
const MANUAL_CAP = 100;  // 同上 MANUAL_CAP

// n=1 单用户：一份全局位点，不按设备分档。多租户那天要先改 docs/hard-rules.md §2 的立场。
export function createReadStateStore({ file = FILE, now = () => Date.now(), seenCap = SEEN_CAP, manualCap = MANUAL_CAP } = {}) {
  // baselineTs=null 表示「尚未建档」：故意不在 import/启动时就写盘，让基线钉在【第一个客户端真正用到】
  // 的时刻，而不是 server 启动的时刻。
  let state = load(file);

  const writer = createSerialWriter(async (shouldCommit) => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++saveSeq}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      if (!shouldCommit()) { await unlink(tmp).catch(() => {}); return; }
      await rename(tmp, file);
    } catch (e) {
      try { await unlink(tmp); } catch { /* tmp 可能未生成 */ }
      throw e;
    }
  }, { onError: e => console.error('[read-state] 保存失败（已读位点未落盘，换设备可能复现假未读）:', e?.message || e) });

  let saveSeq = 0;
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writer.request(); }, 200);
  }

  // 建档：基线只钉这一次。取 min/max 合并客户端基线都不行——取 min 会把最老那台设备的基线传染给全体
  // （正是这次要修的那个 bug 的放大器），取 max 会吞掉「app 关着时来的新活动」。
  function ensureBaseline() {
    if (state.baselineTs === null) {
      state = { ...state, baselineTs: now() };
      save();
    }
    return state;
  }

  function snapshot() {
    const s = ensureBaseline();
    return { baselineTs: s.baselineTs, seen: { ...s.seen }, manual: { ...s.manual } };
  }

  // 客户端连上时上报本地表 → 归并 → 回权威态。升级时本设备 localStorage 里已有的 seen 表也由这条路
  // 迁移上来（否则升级瞬间用户在本机读过的记录全丢，屏幕上是一整屏假未读）。离线期间攒的位点同理。
  function applyClientState(client) {
    ensureBaseline();
    const seen = mergeLatest(state.seen, client?.seen);
    const manual = mergeLatest(state.manual, client?.manual);
    state = { ...state, seen: capNewest(seen, seenCap), manual: capNewest(manual, manualCap) };
    save();
    return snapshot();
  }

  function markRead(sessionId, at) {
    const ts = normalizeTs(at, now);
    if (!isId(sessionId) || ts === null) return snapshot();
    ensureBaseline();
    if (!((state.seen[sessionId] ?? -Infinity) < ts)) return snapshot(); // 单调不回退：乱序旧 ack 不拨旧位点
    // 顺带清掉已被这笔已读盖过的手动标记。判据是 manual[id] > seen[id]，被盖过的条目已经不影响任何
    // 判定，留着只是随 read:sync 在设备间来回搬；而前端 markEntered 在本地是直接删掉它的（它只发
    // seenAt、不发 manual 字段），这里不清就形成「本地删了、服务端留着、下一趟 hydrate 又合并回本地」
    // 的长期不对称——两台设备时钟偏移时那份复活的旧标记会翻成假未读。
    const manual = { ...state.manual };
    if ((manual[sessionId] ?? Infinity) <= ts) delete manual[sessionId];
    state = { ...state, seen: capNewest({ ...state.seen, [sessionId]: ts }, seenCap), manual };
    save();
    return snapshot();
  }

  // 长按「标为未读 / 标为已读」。标为已读必须【同时记 seen】：只删标记的话，别的设备把它的旧 manual
  // 条目合并回来又会亮（判据是 manual[id] > seen[id]，见前端 isManualUnreadNow）。
  function setManual(sessionId, on, at) {
    const ts = normalizeTs(at, now);
    if (!isId(sessionId) || ts === null) return snapshot();
    ensureBaseline();
    if (on) {
      state = { ...state, manual: capNewest({ ...state.manual, [sessionId]: ts }, manualCap) };
    } else {
      const manual = { ...state.manual };
      delete manual[sessionId];
      // seen 也必须单调不回退。这条路径原先无条件覆盖，于是一个乱序到达的旧「标为已读」会把位点
      // 拨回过去，让此后早已读过的内容重新变成未读——markRead 那侧一直有这道闸，两侧必须同向。
      const seen = (state.seen[sessionId] ?? -Infinity) < ts
        ? capNewest({ ...state.seen, [sessionId]: ts }, seenCap)
        : state.seen;
      state = { ...state, manual, seen };
    }
    save();
    return snapshot();
  }

  // 进程退出时同步 flush（与 sessions.js 对称）：先 fence 作废在飞异步写，再同步权威写。
  function flushSaveSync() {
    clearTimeout(saveTimer);
    saveTimer = null;
    writer.fence();
    if (state.baselineTs === null) return; // 从未建档：不凭空造一个空文件
    mkdirSync(dirname(file), { recursive: true });
    writeOwnerOnlyFile(file, JSON.stringify(state, null, 2));
  }

  return { getState: snapshot, applyClientState, markRead, setManual, flushSaveSync };
}

const EMPTY = () => ({ baselineTs: null, seen: {}, manual: {} });

// 损坏/形状不对一律当作没有——缓存类状态，宁可重新建档也不能让 server 起不来。
function load(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return EMPTY();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.baselineTs !== 'number' || !Number.isFinite(raw.baselineTs)) {
    return EMPTY();
  }
  return { baselineTs: raw.baselineTs, seen: numericMap(raw.seen), manual: numericMap(raw.manual) };
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function normalizeTs(at, now) {
  if (at === undefined) return now();
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

function numericMap(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

// 逐 key 取较晚的时间戳（LWW）：幂等、与合并顺序无关，多客户端并发上报不会互相覆盖。
function mergeLatest(a, b) {
  const out = numericMap(a);
  for (const [k, v] of Object.entries(numericMap(b))) {
    if (!(k in out) || v > out[k]) out[k] = v;
  }
  return out;
}

function capNewest(map, cap) {
  const keys = Object.keys(map);
  if (keys.length <= cap) return map;
  keys.sort((x, y) => map[x] - map[y]);
  for (const k of keys.slice(0, keys.length - cap)) delete map[k];
  return map;
}

// 默认实例：server 全局共用一份（n=1 单用户，见上方工厂头注）。
const store = createReadStateStore();

export const getReadState = store.getState;
export const applyClientReadState = store.applyClientState;
export const markRead = store.markRead;
export const setManualUnread = store.setManual;
export const flushSaveSync = store.flushSaveSync;
