// sessions.js —— 服务端唯一持久状态：会话元数据，单 JSON 文件，原子写。
// 只存元数据（id/title/cwd/model/permissionMode/effort/时间戳），永不存消息内容——内容事实源是 claude 自己的 session。
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { createSerialWriter } from '../shared/serial-writer.js';

// #14：锚定模块目录而非 process.cwd()，从任何目录启动 server 都读写同一份状态。
// CCM_SESSIONS_FILE 覆盖路径——仅测试用，让单测指向临时文件、永不碰真实 data/sessions.json（防 npm test 污染生产状态）。
// 次优先 CCM_DATA_DIR（server.js/devices.js 同款）：E2E 设一个 CCM_DATA_DIR 即把 sessions 连同其余状态文件
// 一并重定向到临时根，无需逐个设环境变量。优先级：CCM_SESSIONS_FILE > CCM_DATA_DIR/sessions.json > data/sessions.json。
const FILE = process.env.CCM_SESSIONS_FILE
  || join(process.env.CCM_DATA_DIR || join(import.meta.dirname, '..', '..', 'data'), 'sessions.json');

// 台阶2：当前会话指针由全局单指针 currentSessionId 升为 currentByCwd（每工作目录一个）。
// hiddenSessionIds（FR-20 两级删除 L1，承接 docs/design.md）：session:list 的数据源是直接扫
// ~/.claude/projects/<cwd>/ 的 transcript 文件（history.js#listSessionsPage，"不依赖 sessions.json
// 注册表"），本模块原本的会话记录只是体验增强（标题缓存/指针），并非列表的真实数据源——故 L1"删产品
// 可见引用、transcript 保留"不能只删这里的指针了事，必须有一份独立的隐藏名单，由 listSessionsPage
// 消费过滤。sessionId 全局唯一（UUID），故用一个扁平集合、不分 cwd。
const EMPTY = () => ({ currentByCwd: {}, sessions: [], hiddenSessionIds: [] });

// #5：不仅兜住 parse 抛错，还校验形状——损坏/手改成 {} 的文件不能让后续 .find 崩进程
function load() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return EMPTY();
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) {
    return EMPTY();
  }
  // 台阶2 结构 currentByCwd: {[cwd]:sessionId}。向后兼容台阶1 旧格式的全局 currentSessionId——
  // 它无 cwd 归属信息，无法迁移到某个 cwd，直接丢弃（指针仅是体验增强，丢失只是下次列表手选）。
  const currentByCwd = (raw.currentByCwd && typeof raw.currentByCwd === 'object' && !Array.isArray(raw.currentByCwd))
    ? Object.fromEntries(Object.entries(raw.currentByCwd).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
    : {};
  return {
    currentByCwd,
    sessions: raw.sessions.filter(s => s && typeof s.id === 'string'),
    // 向后兼容：旧文件没有这个字段，缺省空数组（等价于"从未删过"）。
    hiddenSessionIds: Array.isArray(raw.hiddenSessionIds) ? raw.hiddenSessionIds.filter(id => typeof id === 'string') : []
  };
}

let state = load();

// B4：防抖异步写——切 tab 热路径不再阻塞事件循环；200ms 内多次调用只落一次盘。
// BE-012：防抖窗后的实际写盘经单写者串行原语（createSerialWriter）——串行不乱序 + 在飞合并 + shutdown fence，
// 消除「两次异步写 rename 乱序把新态覆盖回旧」与「在飞写覆盖同步 flush」两个数据完整性窗口。
let _saveSeq = 0;
const writer = createSerialWriter(async (shouldCommit) => {
  await mkdir(dirname(FILE), { recursive: true });
  // 原子写：先写 .tmp 再 rename，防写到一半崩溃产生损坏文件。tmp 唯一名（pid+自增序）避免并发覆盖对方 tmp。
  const tmp = `${FILE}.${process.pid}.${++_saveSeq}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    if (!shouldCommit()) { await unlink(tmp).catch(() => {}); return; } // BE-012：已被 flushSaveSync fence → 不覆盖同步权威写
    await rename(tmp, FILE);
  } catch (e) {
    try { await unlink(tmp); } catch { /* tmp 可能未生成 */ }
    throw e;
  }
}, { onError: e => console.error('[sessions] 保存失败（状态未落盘，cost/会话指针可能丢失）:', e?.message || e) });

let _saveTimer = null;
function save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; writer.request(); }, 200);
}

// 进程正常退出时同步 flush（由 server.js shutdown() 调用），保证干净退出状态不丢。
// BE-012：先 fence 作废任何在飞异步写（防其 rename 后于本同步写落地、把终态覆盖回旧），再同步权威写。
export function flushSaveSync() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  writer.fence();
  mkdirSync(dirname(FILE), { recursive: true });
  writeOwnerOnlyFile(FILE, JSON.stringify(state, null, 2));
}

export function getState() {
  return state;
}

// 台阶2：当前会话指针按 cwd 取/设。getCurrent 无记录返回 null；setCurrent 传 null 即清除该 cwd 的指针。
export function getCurrent(cwd) {
  return state.currentByCwd[cwd] ?? null;
}

export function setCurrent(cwd, sessionId) {
  if (sessionId) state.currentByCwd[cwd] = sessionId;
  else delete state.currentByCwd[cwd];
  save();
}

// 新会话首次拿到 session_id 时登记；已存在则刷新 model/effort/permissionMode。
// lastUsedAt：仅新建时写；已有条目【不】在 upsert 时刷新——对齐「最后消息时间」
// （resume/init 重登记不得把会话顶新）。消息活动走 touchSessionActivity。
export function upsertSession({ id, title, cwd, model, effort, permissionMode }) {
  const existing = state.sessions.find(s => s.id === id);
  if (existing) {
    if (model) existing.model = model;
    // effort/permissionMode：init 事件到达时同步持久化（与 model 对称），resume 时可恢复
    if (effort !== undefined) existing.effort = effort;
    if (permissionMode !== undefined) existing.permissionMode = permissionMode;
    // /clear 场景：条目先以占位标题登记，该会话首条消息到达后回填；不覆盖已有真实标题
    if (title && existing.title === '新会话') existing.title = String(title).slice(0, 40);
  } else {
    const now = Date.now();
    state.sessions.unshift({
      id,
      title: (title || '新会话').slice(0, 40),
      cwd,
      // 记录会话实际使用的模型名：CLI resume 会把模型恢复为规范化裸名（如 claude-fable-5），
      // 部分网关只认带后缀的名字（如 claude-fable-5[1m]）——resume 时需显式回传此值
      model: model || null,
      // 思考强度与权限档持久化：web 端续接会话时恢复（CLI 不存，是 web 端增强）
      effort: effort ?? null,
      permissionMode: permissionMode || null,
      createdAt: now,
      lastUsedAt: now
    });
  }
  state.currentByCwd[cwd] = id; // 台阶2：该 cwd 的当前会话指向新 id
  save();
}

// 用户/助手消息活动时间：默认 now；可注入 transcript 消息 timestamp（ms）。
// 单调不回退：at < 已有 lastUsedAt 时忽略（防乱序/重放把时间拨旧）。
export function touchSessionActivity(id, at = Date.now()) {
  if (!id || typeof id !== 'string') return;
  const ms = typeof at === 'number' ? at : Number(at);
  if (!Number.isFinite(ms)) return;
  const existing = state.sessions.find(s => s.id === id);
  if (!existing) return;
  if (typeof existing.lastUsedAt === 'number' && ms < existing.lastUsedAt) return;
  existing.lastUsedAt = ms;
  save();
}

export function getSession(id) {
  if (!id) return null;
  return state.sessions.find(s => s.id === id) || null;
}

export function updateSessionCost(id, cost) {
  const existing = state.sessions.find(s => s.id === id);
  if (existing && typeof cost === 'number') {
    existing.cost = cost;
    save();
  }
}

// 运行时切档时持久化（权限档/思考强度），与 model 的 upsert 对称
export function updateSessionPrefs(id, prefs) {
  const existing = state.sessions.find(s => s.id === id);
  if (!existing) return;
  if (prefs.permissionMode !== undefined) existing.permissionMode = prefs.permissionMode;
  if (prefs.effort !== undefined) existing.effort = prefs.effort;
  save();
}

// 注：原 defaultModelForCwd（空首页"该 cwd 默认模型"推断）已删（A1，2026-06-22）。新会话模型 = 终端
// ANTHROPIC_* env 默认、服务端不可知；"最近会话 model" 只是推断（上次可能 /model 覆盖、env 默认可能已变），
// 不算真值。空首页改显「不指定」、首条消息后由 init.model 校正——拿不到真值就不显、不猜。

// ---- 两级删除 L1（FR-20，承接 docs/design.md）----
export function hideSession(id) {
  if (typeof id !== 'string' || !id) return;
  if (!state.hiddenSessionIds.includes(id)) {
    state.hiddenSessionIds.push(id);
    save();
  }
}

// L2 真删文件后调用：隐藏名单不需要再为一个已经不存在的文件长期占位（避免无界增长）。
export function unhideSession(id) {
  const idx = state.hiddenSessionIds.indexOf(id);
  if (idx !== -1) {
    state.hiddenSessionIds.splice(idx, 1);
    save();
  }
}

export function isHidden(id) {
  return state.hiddenSessionIds.includes(id);
}

export function getHiddenIds() {
  return state.hiddenSessionIds;
}
