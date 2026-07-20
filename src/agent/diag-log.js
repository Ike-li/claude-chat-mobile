// diag-log.js —— 镜像/排队/停止三个状态机子系统的结构化诊断时间线
// 与 interaction-log.js 同构但独立：那边是"说了什么"的一句话文本日志，这边是"内部状态机
// 做了什么"的结构化事件，容量各自隔离——排队重试风暴不该挤掉真实对话记录。
// 恒开、无 env 开关：埋点本身克制（离散状态转换而非轮询/心跳），量级与 interactionLog 同一
// 数量级；容量上限从第一天写死，不留"能被打开却没有可见性/无自动上限"的口子（DEBUG_SDK_MESSAGES 教训）。
import { provisionalKey } from './interaction-log.js';

export const MAX_ENTRIES_PER_SESSION = 100;
export const MAX_SESSIONS = 200;
export const MAX_DETAIL_CHARS = 1000;

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
    if (buffers.size >= MAX_SESSIONS) {
      buffers.delete(buffers.keys().next().value);
    }
    buffers.set(sessionKey, []);
  }
  const buf = buffers.get(sessionKey);
  const entry = { ts: Date.now(), subsystem, event, detail: safeDetail(detail) };
  buf.push(entry);
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
  if (!buffers.has(sessionId) && buffers.size >= MAX_SESSIONS) {
    buffers.delete(buffers.keys().next().value);
  }
  buffers.set(sessionId, merged);
}

export { provisionalKey };
