// sessions.js —— 服务端唯一持久状态（ADR-005）：会话元数据，单 JSON 文件，原子写。
// 只存元数据（id/title/cwd/model/时间戳），永不存消息内容——内容事实源是 claude 自己的 session。
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeOwnerOnlyFile } from './file-security.js';

// #14：锚定模块目录而非 process.cwd()，从任何目录启动 server 都读写同一份状态。
// CCM_SESSIONS_FILE 覆盖路径——仅测试用，让单测指向临时文件、永不碰真实 data/sessions.json（防 npm test 污染生产状态）。
// 次优先 CCM_DATA_DIR（server.js/devices.js 同款）：E2E 设一个 CCM_DATA_DIR 即把 sessions 连同其余状态文件
// 一并重定向到临时根，无需逐个设环境变量。优先级：CCM_SESSIONS_FILE > CCM_DATA_DIR/sessions.json > data/sessions.json。
const FILE = process.env.CCM_SESSIONS_FILE
  || join(process.env.CCM_DATA_DIR || join(import.meta.dirname, 'data'), 'sessions.json');

// 台阶2（ADR-010）：当前会话指针由全局单指针 currentSessionId 升为 currentByCwd（每工作目录一个）。
const EMPTY = () => ({ currentByCwd: {}, sessions: [] });

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
    sessions: raw.sessions.filter(s => s && typeof s.id === 'string')
  };
}

let state = load();

// B4：防抖异步写——切 tab 热路径不再阻塞事件循环；200ms 内多次调用只落一次盘。
let _saveTimer = null;

function save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveAsync().catch(e => console.error('[sessions] 保存失败（状态未落盘，cost/会话指针可能丢失）:', e?.message || e));
  }, 200);
}

let _saveSeq = 0;
async function _saveAsync() {
  await mkdir(dirname(FILE), { recursive: true });
  // 原子写：先写 .tmp 再 rename，防写到一半崩溃产生损坏文件。
  // S4：tmp 用唯一名（pid+自增序）——万一两次 _saveAsync 的 await 重叠（写盘>防抖窗）也不互相覆盖对方 tmp；
  // rename 仍原子，终态完整。失败则清掉本次唯一 tmp，避免唯一名残留堆积（固定名会被下次覆盖、唯一名不会）。
  const tmp = `${FILE}.${process.pid}.${++_saveSeq}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, FILE);
  } catch (e) {
    try { await unlink(tmp); } catch { /* tmp 可能未生成 */ }
    throw e;
  }
}

// 进程正常退出时同步 flush（由 server.js shutdown() 调用），保证干净退出状态不丢。
export function flushSaveSync() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
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

// 新会话首次拿到 session_id 时登记；已存在则刷新 lastUsedAt 与 model
export function upsertSession({ id, title, cwd, model }) {
  const existing = state.sessions.find(s => s.id === id);
  if (existing) {
    existing.lastUsedAt = Date.now();
    if (model) existing.model = model;
    // /clear 场景：条目先以占位标题登记，该会话首条消息到达后回填；不覆盖已有真实标题
    if (title && existing.title === '新会话') existing.title = String(title).slice(0, 40);
  } else {
    state.sessions.unshift({
      id,
      title: (title || '新会话').slice(0, 40),
      cwd,
      // 记录会话实际使用的模型名：CLI resume 会把模型恢复为规范化裸名（如 claude-fable-5），
      // 部分网关只认带后缀的名字（如 claude-fable-5[1m]）——resume 时需显式回传此值
      model: model || null,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    });
  }
  state.currentByCwd[cwd] = id; // 台阶2：该 cwd 的当前会话指向新 id
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

// 注：原 defaultModelForCwd（空首页"该 cwd 默认模型"推断）已删（A1，2026-06-22）。新会话模型 = 终端
// ANTHROPIC_* env 默认、服务端不可知；"最近会话 model" 只是推断（上次可能 /model 覆盖、env 默认可能已变），
// 不算真值。空首页改显「不指定」、首条消息后由 init.model 校正——拿不到真值就不显、不猜。见 docs/event-contract.md。
