// diag-log.js —— 镜像/排队/停止三个状态机子系统的结构化诊断时间线
// 与 interaction-log.js 同构但独立：那边是"说了什么"的一句话文本日志，这边是"内部状态机
// 做了什么"的结构化事件，容量各自隔离——排队重试风暴不该挤掉真实对话记录。
// 恒开、无 env 开关：埋点本身克制（离散状态转换而非轮询/心跳），量级与 interactionLog 同一
// 数量级；容量上限从第一天写死，不留"能被打开却没有可见性/无自动上限"的口子（DEBUG_SDK_MESSAGES 教训）。
import { provisionalKey } from './interaction-log.js';
import { setCapped } from '../shared/bounded-map.js';

export const MAX_ENTRIES_PER_SESSION = 100;
export const MAX_SESSIONS = 200;
export const MAX_DETAIL_CHARS = 1000;

// 心跳类埋点：周期性、无状态转换语义，只回答"轮询还活着吗"。catchup/tick 每 2.5s 一条，几分钟就把
// 100 条环形缓冲刷满，把真正有诊断价值的状态转换记录全挤出去——2026-07-26 查 pendingTurns 卡死时，
// 现场 14:07 的 queue/turn_settled 就是这么丢的，根因因此没能闭环。
// 对策不是删埋点（"还在轮询"本身有价值），而是让它只挤自己人：心跳独立限额，绝不占事件级配额。
export const MAX_HEARTBEAT_ENTRIES = 5;
const HEARTBEAT_KEYS = new Set(['catchup/tick']);
const isHeartbeat = (subsystem, event) => HEARTBEAT_KEYS.has(`${subsystem}/${event}`);

const buffers = new Map(); // sessionKey → entry[]
let logCallback = null;

export function setCallback(cb) {
  logCallback = cb;
}

export function getDiagLogs(sessionKey) {
  if (!sessionKey) return [];
  return buffers.get(sessionKey) || [];
}

function safeDetail(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  let json;
  try { json = JSON.stringify(d); } catch { json = '"(unserializable)"'; }
  if (json.length <= MAX_DETAIL_CHARS) return d;
  return { _truncated: true, _preview: json.slice(0, MAX_DETAIL_CHARS) };
}

export function record(sessionKey, subsystem, event, detail = {}) {
  if (!sessionKey) return; // 无法关联到任何会话/实例——诚实丢弃，不造假 key
  if (!buffers.has(sessionKey)) {
    // 防无界增长：会话数超上限时 FIFO 淘汰最旧会话缓冲（与 interactionLog 同精神）
    setCapped(buffers, sessionKey, [], MAX_SESSIONS);
  }
  const buf = buffers.get(sessionKey);
  const entry = { ts: Date.now(), subsystem, event, detail: safeDetail(detail) };
  buf.push(entry);
  // 心跳超额时先挤同类最旧的（保留最近 MAX_HEARTBEAT_ENTRIES 条），再走统一上限——这样满是心跳的
  // 缓冲不会把事件级记录挤没。非心跳事件仍照旧走 FIFO 上限，行为不变。
  if (isHeartbeat(subsystem, event)) {
    let extra = buf.reduce((n, e) => n + (isHeartbeat(e.subsystem, e.event) ? 1 : 0), 0) - MAX_HEARTBEAT_ENTRIES;
    for (let i = 0; i < buf.length && extra > 0; ) {
      if (isHeartbeat(buf[i].subsystem, buf[i].event)) { buf.splice(i, 1); extra--; } else i++;
    }
  }
  if (buf.length > MAX_ENTRIES_PER_SESSION) buf.shift();
  if (typeof logCallback === 'function') {
    try {
      logCallback(sessionKey, entry);
    } catch (e) {
      console.error('[diag-log] 流式回调失败:', e.message);
    }
  }
}

// 把 provisional 缓冲并入真实 sessionId（不重放 callback——直播时已按 provisional 键广播过）。
// 顺序：provisional 在前（时间更早）+ 已有真 session 缓冲在后；超上限截尾。与
// interaction-log.js#rebindSessionLogs 完全同构，两模块 key 语义共用同一套约定。
export function rebindDiagLogs(fromKey, sessionId) {
  if (!fromKey || !sessionId || fromKey === sessionId) return;
  const pending = buffers.get(fromKey);
  if (!pending || !pending.length) {
    buffers.delete(fromKey);
    return;
  }
  buffers.delete(fromKey);
  const existing = buffers.get(sessionId) || [];
  let merged = pending.concat(existing);
  if (merged.length > MAX_ENTRIES_PER_SESSION) merged = merged.slice(merged.length - MAX_ENTRIES_PER_SESSION);
  setCapped(buffers, sessionId, merged, MAX_SESSIONS);
}

export { provisionalKey };
