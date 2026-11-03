// audit.js —— 服务端持久状态：最小安全审计记录，单 JSON 文件，环形上限，原子写。
// 写入模式同 sessions.js/approval-store.js（防抖异步 + tmp+rename 原子落盘）。
//
// 范围收敛到三类"web 特有安全动作"——鉴权（限速锁定）、设备（批准/拒绝/吊销）、
// 审批（完整性校验失败、重启批量失效、留存治理清理本身）。刻意不覆盖：①审批的常规 allow/deny——
// 那是 approval_request 表自己的职责（含完整 op），本表若逐条重复记录会让环形上限更快被日常噪音
// 挤满、反而冲掉真正稀有的异常信号；②纯运维性日志（推送失败、workdirs 热加载、scout 超时等）——
// 不是"安全动作"，维持现状 console.warn/error 即可，不必叠加一套平行判定体系（呼应瘦中转原则）。
//
// meta 字段约束（"meta 无敏感正文"）：只放事实性元数据（工具名、计数、cwd 尾段等），
// 不放命令原文/文件内容/凭证——调用点自行遵守，本模块不做内容过滤（同 WorkdirScopeGuard
// 的显式抉择：防线在写入点自律，不在这里做黑名单式内容审查）。
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { createSerialWriter } from '../shared/serial-writer.js';
import { dataFile } from '../shared/data-dir.js';

const FILE = process.env.CCM_AUDIT_FILE || dataFile('audit-records.json');

// 环形上限，可配（默认 5000）。
const CAP = Number(process.env.AUDIT_RECORD_CAP) > 0 ? Number(process.env.AUDIT_RECORD_CAP) : 5000;

const EMPTY = () => ({ records: [] });

function load() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return EMPTY();
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.records)) {
    return EMPTY();
  }
  return { records: raw.records.filter(r => r && typeof r.id === 'string') };
}

let state = load();
let _seq = 0;

let _saveSeq = 0;
// BE-012：实际写盘经单写者串行原语——串行不乱序 + 在飞合并 + shutdown fence（防在飞写覆盖同步 flush）。
const writer = createSerialWriter(async (shouldCommit) => {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.${++_saveSeq}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    if (!shouldCommit()) { await unlink(tmp).catch(() => {}); return; } // BE-012：已被 flushSaveSync fence → 不覆盖同步权威写
    await rename(tmp, FILE);
  } catch (e) {
    try { await unlink(tmp); } catch { /* tmp 可能未生成 */ }
    throw e;
  }
}, { onError: e => console.error('[audit] 保存失败（审计记录未落盘）:', e?.message || e) });

let _saveTimer = null;
function save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; writer.request(); }, 200);
}

// BE-012：先 fence 作废在飞异步写，防其 rename 后于本同步写落地覆盖回旧，再同步权威写。
export function flushSaveSync() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  writer.fence();
  mkdirSync(dirname(FILE), { recursive: true });
  writeOwnerOnlyFile(FILE, JSON.stringify(state, null, 2));
}

// 环形上限在写入时立即生效（而非留给独立的留存治理任务）——写入频率本就低（安全动作而非消息流），
// 没有理由让上限之外的清理逻辑来做这件事，写入即治理最简单可靠。
// ts 可选覆盖：对齐 ops/ 域内其它模块（如 cli-hooks-bridge.js 的 capturedAt/ackedAt）已有的
// 「可选时钟覆盖参数、默认 Date.now()」惯例，供测试精确构造时间边界（同步调用背靠背时 ts 可能
// 相同，_seq 递增仍保证 id 唯一）。生产调用点不传，行为不变。
//
// 合并（2026-11-01）：与窗口内某条完全相同（actor、action、target、outcome、meta 逐字段相等）时不另起一条，
// 只在那条上记 repeat（总次数）与 lastTs。一个周期性触发的拒绝（抽屉每 12 秒轮询一个已删掉的文件夹）
// 曾以每小时 300 条的速度把上限里真正稀有的记录轮转掉。窗口从首条算起而不是滑动：持续的刷屏每分钟仍落一条
// 新记录，排在最新处，看得出它还在发生。
const MERGE_WINDOW_MS = 60_000;
const sameEvent = (r) => JSON.stringify([r.actor, r.action, r.target, r.outcome, r.meta]);

export function recordAudit({ actor, action, target, outcome, meta, ts = Date.now() } = {}) {
  const fields = {
    actor: actor ? { deviceId: actor.deviceId ?? null, via: actor.via ?? null } : { deviceId: null, via: null },
    action, target: target ?? null, outcome: outcome ?? null, meta: meta ?? null
  };
  const key = sameEvent(fields);
  for (let i = state.records.length - 1; i >= 0 && state.records[i].ts > ts - MERGE_WINDOW_MS; i--) {
    const prev = state.records[i];
    if (sameEvent(prev) !== key) continue;
    prev.repeat = (prev.repeat ?? 1) + 1;
    prev.lastTs = ts;
    save();
    return prev;
  }
  const record = { id: `audit_${ts}_${++_seq}`, ts, ...fields };
  state.records.push(record);
  if (state.records.length > CAP) state.records = state.records.slice(-CAP); // 轮转最旧
  save();
  return record;
}

export function listRecent({ limit = 100, action, since } = {}) {
  let rows = state.records;
  if (action) rows = rows.filter(r => r.action === action);
  if (typeof since === 'number') rows = rows.filter(r => r.ts >= since);
  return rows.slice(-limit).reverse(); // 最新在前
}

export function getAll() {
  return state.records;
}

export function capacity() {
  return CAP;
}
