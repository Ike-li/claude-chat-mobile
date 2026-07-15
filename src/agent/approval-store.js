// approval-store.js —— 服务端持久状态：审批请求台账，单 JSON 文件，原子写（docs/design.md approval_request 表，
// 承接 NFR-16/NFR-17/FR-19/FR-22）。与 sessions.js 同一套模式（防抖异步写 + tmp+rename 原子落盘）。
//
// 存在的理由：canUseTool 挂起的审批此前只活在 AgentSession 的内存 Map 里（Phase 1/3 的刻意简化——
// 见 agent.js pendingPermissions）——进程一死（重启/崩溃）就凭空消失，FR-19"审批记录可查询留存"、
// NFR-16"留存有界可治理"都无从谈起。本模块只是台账（谁批准了什么、何时、结果如何），不是执行门槛——
// 真正的完整性校验/fail-closed 仍在 agent.js 的同步内存路径（见 fingerprint.js 头部注释），本模块的
// 写入失败不应、也不会阻塞审批流程本身（各调用点仅捕获日志，不向上抛）。
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { createSerialWriter } from '../shared/serial-writer.js';

// 优先级同 sessions.js：CCM_APPROVAL_STORE_FILE（仅测试）> CCM_DATA_DIR > data/ 默认。
const FILE = process.env.CCM_APPROVAL_STORE_FILE
  || join(process.env.CCM_DATA_DIR || join(import.meta.dirname, '..', '..', 'data'), 'approval-requests.json');

const EMPTY = () => ({ requests: [] });

function load() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return EMPTY();
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.requests)) {
    return EMPTY();
  }
  return { requests: raw.requests.filter(r => r && typeof r.reqId === 'string') };
}

let state = load();

let _saveSeq = 0;
// BE-012：实际写盘经单写者串行原语——串行不乱序 + 在飞合并 + shutdown fence（防在飞写覆盖同步 flush 的 deny 终态）。
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
}, { onError: e => console.error('[approval-store] 保存失败（审批台账未落盘）:', e?.message || e) });

let _saveTimer = null;
function save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; writer.request(); }, 200);
}

// 进程正常退出时同步 flush（server.js shutdown() 调用），防抖窗口内未落盘的状态不因 process.exit 丢失。
// BE-012：先 fence 作废在飞异步写，防其 rename 后于本同步写落地覆盖回旧（丢失 dispose 时刚写的 deny 终态）。
export function flushSaveSync() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  writer.fence();
  mkdirSync(dirname(FILE), { recursive: true });
  writeOwnerOnlyFile(FILE, JSON.stringify(state, null, 2));
}

// 供 askPermission 调用：canUseTool 收到 op 那一刻登记一条 pending 台账。
export function recordCreated({ reqId, sessionId, tool, args, cwd, fingerprint, risk, createdAt, expiresAt }) {
  state.requests.push({
    reqId, sessionId, tool, args, cwd, fingerprint, risk: risk ?? null,
    createdAt, expiresAt, status: 'pending', decidedBy: null, decidedAt: null
  });
  save();
}

// 供 resolvePermission 调用：终态落定（allow/deny/expired/integrity_mismatch）。找不到对应 reqId 静默忽略
// （防御性——理论上 recordCreated 必先于 recordDecided，但台账是辅助记录，找不到不应影响审批流程本身）。
export function recordDecided(reqId, { status, decidedBy, decidedAt }) {
  const existing = state.requests.find(r => r.reqId === reqId);
  if (!existing) return;
  existing.status = status;
  existing.decidedBy = decidedBy ?? null;
  existing.decidedAt = decidedAt;
  save();
}

// 重启恢复语义（见 docs/design.md §4）：canUseTool 回调随上一进程终止已无法兑现，遗留的 pending
// 一律标记 expired，decidedBy 固定 'system:restart'，绝不能让它们看起来"仍可批准"。返回处置条数。
export function expireAllPending({ decidedBy = 'system:restart', decidedAt } = {}) {
  const at = decidedAt ?? Date.now();
  let count = 0;
  for (const r of state.requests) {
    if (r.status === 'pending') {
      r.status = 'expired';
      r.decidedBy = decidedBy;
      r.decidedAt = at;
      count++;
    }
  }
  if (count > 0) save();
  return count;
}

// NFR-16 留存治理：终态（非 pending）记录按 decidedAt 早于 cutoffTs 的清理。pending 记录永不因保留期
// 被清（无论多久悬置，仍需走 TTL/重启恢复的正常终态化路径，不应被留存治理这条平行逻辑意外收走）。
export function purgeTerminalOlderThan(cutoffTs) {
  const before = state.requests.length;
  state.requests = state.requests.filter(r => r.status === 'pending' || (r.decidedAt ?? 0) >= cutoffTs);
  const purged = before - state.requests.length;
  if (purged > 0) save();
  return purged;
}

export function getAll() {
  return state.requests;
}

export function getByReqId(reqId) {
  return state.requests.find(r => r.reqId === reqId) || null;
}
