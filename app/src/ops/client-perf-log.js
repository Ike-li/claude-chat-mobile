// client-perf-log.js —— 前端性能上报（logs:clientPerf）落服务端日志。
// 手机上的启动分段、打开会话分段、掉帧、点击响应此前只存在手机本地；前端攒成一批经 socket 发来，
// 在这里清洗成一行 JSON，scripts/perf-report.js 读日志按维度出分位值。载荷来自客户端属不可信输入：
// 只留数字、布尔、短字符串，键名、层数、条数、总长都有上限，形状不对返回 null（调用方丢弃）。
import { sanitize } from '../shared/sanitizer.js';

const SCHEMA = 1;
const MAX_DEPTH = 6;
const MAX_ITEMS = 200;
const MAX_KEYS = 40;
const MAX_STRING = 200;
const MAX_LINE = 32 * 1024;
const MAX_NUMBER = 1e9;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

const clampString = v => sanitize(v.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, MAX_STRING));

// undefined = 丢掉这一项
function clean(value, depth) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return Math.round(Math.max(-MAX_NUMBER, Math.min(MAX_NUMBER, value)) * 100) / 100;
  }
  if (typeof value === 'string') return clampString(value);
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map(item => clean(item, depth + 1)).filter(item => item !== undefined);
  }
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (!KEY.test(key)) continue;
    const cleaned = clean(item, depth + 1);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export function formatClientPerfLine(payload, { socketId = null, ua = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.v !== SCHEMA || !Array.isArray(payload.events)) return null;
  const line = JSON.stringify({
    sid: socketId,
    ua: typeof ua === 'string' && ua ? clampString(ua) : null,
    ...clean(payload, 0),
  });
  return line.length > MAX_LINE ? null : line;
}
