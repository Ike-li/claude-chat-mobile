// interaction-log.js —— 可选交互日志
// 环境变量 LOG_INTERACTIONS=1 开启 → 记录每跳内容（user:message/user_message/text_delta/result）
// 自动截断长负载（1500 字符），避免日志膨胀；完整内容在环形缓冲/文件系统，此处只摘要。
// 用途：调试"为什么 claude 没执行我要的"、审计对话内容（公网部署合规需求）
import { sanitize } from './sanitizer.js';

const MAX_PAYLOAD_CHARS = 1500;
const MAX_SESSIONS = 200; // sessionBuffers 会话数上限——防常驻 server 长跑下历史会话日志缓冲无界累积（FIFO 淘汰最旧）

// 全局开关：LOG_INTERACTIONS=1 开启（启动时决定，运行中不可改）
export const enabled = process.env.LOG_INTERACTIONS === '1';

// Web 端专属会话日志内存缓冲与流式回调
const sessionBuffers = new Map();
let logCallback = null;

export function setCallback(cb) {
  logCallback = cb;
}

export function getSessionLogs(sessionId) {
  if (!sessionId) return [];
  return sessionBuffers.get(sessionId) || [];
}

export function addSessionLog(sessionId, type, text, model) {
  if (!sessionId) return;
  if (!sessionBuffers.has(sessionId)) {
    // 防无界增长：会话数超上限时 FIFO 淘汰最旧会话缓冲（Map 保插入序；与 history/sessions 缓存同精神）
    if (sessionBuffers.size >= MAX_SESSIONS) {
      sessionBuffers.delete(sessionBuffers.keys().next().value);
    }
    sessionBuffers.set(sessionId, []);
  }
  const buffer = sessionBuffers.get(sessionId);
  const entry = {
    ts: Date.now(),
    type,
    text
  };
  if (model) entry.model = model;  // 模型 ID 独立字段（前端渲染独立 chip）；空则不带字段、不渲染
  buffer.push(entry);
  if (buffer.length > 100) {
    buffer.shift();
  }
  if (typeof logCallback === 'function') {
    try {
      logCallback(sessionId, entry);
    } catch (e) {
      console.error('[interact] 流式回调失败:', e.message);
    }
  }
}

function fmt(text) {
  const t = (text || '').trim();
  if (!t) return '(empty)';
  const sanitized = sanitize(t);  // 新增：先脱敏再截断
  const collapsed = sanitized.replace(/\n/g, '\\n');
  if (collapsed.length <= MAX_PAYLOAD_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_PAYLOAD_CHARS)}… (+${collapsed.length - MAX_PAYLOAD_CHARS} chars)`;
}

// 四跳：client → server → agent → SDK → agent → server → client
// client → server
export function userMessageIn(sessionId, text, model) {
  const f = fmt(text);
  addSessionLog(sessionId, 'user_in', f, model);
  if (!enabled) return;
  console.log(`[interact] [user→srv] session=${sessionId}${model ? ` model=${model}` : ''} ← ${f}`);
}

// server → client（user_message 广播，已入缓冲）
export function userMessageOut(sessionId, text, model) {
  const f = fmt(text);
  addSessionLog(sessionId, 'user_out', f, model);
  if (!enabled) return;
  console.log(`[interact] [srv→cli] session=${sessionId}${model ? ` model=${model}` : ''} → user_message: ${f}`);
}

// agent → SDK（send 调用）
export function agentSend(sessionId, text, model) {
  const f = fmt(text);
  const m = model || 'default';
  addSessionLog(sessionId, 'agent_send', f, m);  // model 走独立 badge 字段，text 不再前缀 model=
  if (!enabled) return;
  console.log(`[interact] [agt→SDK] session=${sessionId} model=${m} → ${f}`);
}

// SDK → agent（result 最终文本）
export function agentResult(sessionId, text, model) {
  const f = fmt(text);
  addSessionLog(sessionId, 'agent_result', f, model);
  if (!enabled) return;
  console.log(`[interact] [SDK→agt] session=${sessionId}${model ? ` model=${model}` : ''} ← result: ${f}`);
}

// text_delta 流式片段（可选，量大时关闭；调试时开启看流式细节）
export function textDelta(sessionId, delta) {
  if (!enabled) return;
  // 默认不记 delta（太多），只记 result；若需要看流式细节，取消下行注释
  // console.log(`[interact] [SDK→agt] session=${sessionId} ← delta: ${fmt(delta)}`);
}
