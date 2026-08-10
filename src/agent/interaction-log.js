// interaction-log.js —— 可选交互日志
// 环境变量 LOG_INTERACTIONS=1 开启 → 记录每跳内容（user:message/user_message/text_delta/result）
// 自动截断长负载（1500 字符），避免日志膨胀；完整内容在环形缓冲/文件系统，此处只摘要。
// 用途：调试"为什么 claude 没执行我要的"、审计对话内容（公网部署合规需求）
import { sanitize } from '../shared/sanitizer.js';
import { setCapped } from '../shared/bounded-map.js';

const MAX_PAYLOAD_CHARS = 1500;
const MAX_SESSIONS = 200; // sessionBuffers 会话数上限——防常驻 server 长跑下历史会话日志缓冲无界累积（FIFO 淘汰最旧）

// 全局开关：LOG_INTERACTIONS=1 开启（启动时决定，运行中不可改）
export const enabled = process.env.LOG_INTERACTIONS === '1';

// Web 端专属会话日志内存缓冲与流式回调
const sessionBuffers = new Map();
let logCallback = null;

// 这四类各有专属 console 输出（带 [user→srv] 这类方向标记，见文件下方四个包装函数），
// 在 addSessionLog 里再打一次就是双份。其余类型（sys_info 等）没有包装函数，
// 此前只进内存缓冲、永不落盘 —— 见 addSessionLog 末尾的补写。
// ★ 新增带专属 console 的包装函数时，类型要同步加进来，否则该类型会双倍刷屏（日志里肉眼可见）。
const CONSOLE_BY_WRAPPER = new Set(['user_in', 'user_out', 'agent_send', 'agent_result']);

export function setCallback(cb) {
  logCallback = cb;
}

export function getSessionLogs(sessionId) {
  if (!sessionId) return [];
  return sessionBuffers.get(sessionId) || [];
}

// FRESH 新会话首轮：SDK init 前 sessionId 仍为 null。若直接丢弃，user_in/user_out/agent_send
// 整段首跳蒸发，交互日志最该看的「我发了什么 / 送进 SDK 的是什么」反而空。
// 约定：尚无 sessionId 时用 provisionalKey(instanceId) 作缓冲键；init 拿到真 id 后 rebind 合并。
export function provisionalKey(instanceId) {
  if (!instanceId) return null;
  return `inst:${instanceId}`;
}

// 把 provisional 缓冲并入真实 sessionId（不重放 callback——直播时已按 provisional 键广播过）。
// 顺序：provisional 在前（时间更早）+ 已有真 session 缓冲在后；超 100 截尾。
export function rebindSessionLogs(fromKey, sessionId) {
  if (!fromKey || !sessionId || fromKey === sessionId) return;
  const pending = sessionBuffers.get(fromKey);
  if (!pending || !pending.length) {
    sessionBuffers.delete(fromKey);
    return;
  }
  sessionBuffers.delete(fromKey);
  const existing = sessionBuffers.get(sessionId) || [];
  let merged = pending.concat(existing);
  if (merged.length > 100) merged = merged.slice(merged.length - 100);
  // 会话数 cap：目标键若是新会话也要占位（pending 迁走后 size 可能仍超）
  setCapped(sessionBuffers, sessionId, merged, MAX_SESSIONS);
}

export function addSessionLog(sessionId, type, text, meta) {
  if (!sessionId) return;
  if (!sessionBuffers.has(sessionId)) {
    // 防无界增长：会话数超上限时 FIFO 淘汰最旧会话缓冲（Map 保插入序；与 history/sessions 缓存同精神）
    setCapped(sessionBuffers, sessionId, [], MAX_SESSIONS);
  }
  const buffer = sessionBuffers.get(sessionId);
  const entry = {
    ts: Date.now(),
    type,
    text
  };
  // meta 兼容两形态：字符串 = 模型 ID（旧调用）；对象 = {model, effort, permissionMode}——
  // 各作为独立 chip 数据源（前端 appendLogEntry 渲染），空字段不带、不渲染。
  if (typeof meta === 'string') {
    if (meta) entry.model = meta;
  } else if (meta && typeof meta === 'object') {
    if (meta.model) entry.model = meta.model;
    if (meta.effort) entry.effort = meta.effort;
    if (meta.permissionMode) entry.permissionMode = meta.permissionMode;
  }
  buffer.push(entry);
  if (buffer.length > 100) {
    buffer.shift();
  }
  // A 通道补写：sessionBuffers 是纯内存（100 条/会话、200 会话 FIFO），**重启即失**。
  // 对话主干由四个包装函数各自落盘，而 sys_info 这类系统事件（会话启动/连接/拿到 ID）此前
  // 一条都不落 —— 排障时文件里只有对话、没有状态转换时间点，只能拿半边。
  //
  // ★ 必须走 fmt()，与四个包装函数同口径（sanitize 脱敏 + 1500 字符截断 + 换行折叠）。
  // 别以为「系统事件不含正文」就能省：app.js:1498 把 firstMessage（= 用户第一条消息**全文**，
  // 见 agent.js:615）拼进了 sys_info。实测原样落盘会写出 3184 字节一行、含明文
  // `sk-ant-api03-…`、且带真实换行——而同一份内容经 userMessageOut 落的那份是脱敏且截断的。
  // 这个日志文件长期留存并轮转归档，公网部署下明文密钥落盘是不可接受的。
  // 换行折叠同样必需：installLogTimestamps 按「每次 console 调用」加前缀，不是每个物理行，
  // 真实换行会摊出既无时间戳也无 [interact] 标记的裸行。
  //
  // 刻意不受 LOG_INTERACTIONS 管辖：那个开关管的是「交互内容」（对话正文，量大、含隐私），
  // 而系统事件是状态转换线、量小（每会话个位数），且**恰恰在关掉交互日志时更需要**——
  // 那时文件里没有对话，至少得留下「会话何时启动、何时拿到 id」。经 fmt() 之后正文风险已收口。
  if (!CONSOLE_BY_WRAPPER.has(type)) {
    // try/catch 对齐本函数既有的 throw-free 契约（见下方 logCallback 的包裹）：
    // 落盘失败绝不能连累已入内存的 entry，更不能让 session_log 广播被跳过。
    try {
      console.log(`[interact] [${type}] session=${sessionId} ${fmt(text)}`);
    } catch { /* 落盘失败不影响内存缓冲与实时广播 */ }
  }
  if (typeof logCallback === 'function') {
    try {
      logCallback(sessionId, entry);
    } catch (e) {
      console.error('[interact] 流式回调失败:', e.message);
    }
  }
}

// 实时 session_log 广播 payload（server setCallback → agent:event）。
// 必须与缓冲 entry 的 chip 字段对齐：抽屉开着时走流式追加、不经 logs:get；
// 漏掉 model/effort/permissionMode 会导致「直播无 chip、关掉重开又有」的不一致。
// 空字段不带，与 addSessionLog 写入约定一致。
export function sessionLogPayload(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const p = {
    type: entry.type,
    text: entry.text,
    ts: entry.ts,
  };
  if (entry.model) p.model = entry.model;
  if (entry.effort) p.effort = entry.effort;
  if (entry.permissionMode) p.permissionMode = entry.permissionMode;
  return p;
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
// model/effort/permissionMode 走独立 chip 字段（前端 appendLogEntry 渲染），显示「那一刻」的具体模型 ID + 档位。
// client → server
export function userMessageIn(sessionId, text, model, effort, permissionMode) {
  const f = fmt(text);
  addSessionLog(sessionId, 'user_in', f, { model, effort, permissionMode });
  if (!enabled) return;
  console.log(`[interact] [user→srv] session=${sessionId}${model ? ` model=${model}` : ''} ← ${f}`);
}

// server → client（user_message 广播，已入缓冲）
export function userMessageOut(sessionId, text, model, effort, permissionMode) {
  const f = fmt(text);
  addSessionLog(sessionId, 'user_out', f, { model, effort, permissionMode });
  if (!enabled) return;
  console.log(`[interact] [srv→cli] session=${sessionId}${model ? ` model=${model}` : ''} → user_message: ${f}`);
}

// agent → SDK（send 调用）
export function agentSend(sessionId, text, model, effort, permissionMode) {
  const f = fmt(text);
  const m = model || 'default';
  addSessionLog(sessionId, 'agent_send', f, { model: m, effort, permissionMode });  // model/effort/permission 走独立字段，text 不再前缀
  if (!enabled) return;
  console.log(`[interact] [agt→SDK] session=${sessionId} model=${m}${effort ? ` effort=${effort}` : ''}${permissionMode ? ` perm=${permissionMode}` : ''} → ${f}`);
}

// SDK → agent（result 最终文本）
export function agentResult(sessionId, text, model, effort, permissionMode) {
  const f = fmt(text);
  addSessionLog(sessionId, 'agent_result', f, { model, effort, permissionMode });
  if (!enabled) return;
  console.log(`[interact] [SDK→agt] session=${sessionId}${model ? ` model=${model}` : ''} ← result: ${f}`);
}

// text_delta 流式片段（可选，量大时关闭；调试时开启看流式细节）
export function textDelta(_sessionId, _delta) {
  if (!enabled) return;
  // 默认不记 delta（太多），只记 result；若需要看流式细节，取消下行注释
  // console.log(`[interact] [SDK→agt] session=${sessionId} ← delta: ${fmt(delta)}`);
}
