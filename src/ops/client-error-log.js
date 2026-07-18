// client-error-log.js —— 前端全局 JS 错误上报（logs:clientError）落服务端日志。
// 手机浏览器无 devtools，前端运行期错误此前完全不可见；错误经 socket 上报后在这里
// 校验形状、钳制长度、折叠换行、脱敏，产出适合 console.warn 的单行。载荷来自客户端
// 属不可信输入：非法形状返回 null（调用方丢弃），配 per-socket 限流防错误风暴刷日志。
import { sanitize } from '../shared/sanitizer.js';

const CAPS = { message: 500, source: 300, stack: 1500 };
const clampStr = (v, cap) => (typeof v === 'string' && v ? v.slice(0, cap) : null);

export function formatClientErrorLine(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const message = clampStr(payload.message, CAPS.message);
  if (!message) return null;
  const kind = payload.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error';
  const source = clampStr(payload.source, CAPS.source);
  const line = Number.isFinite(payload.line) ? payload.line : null;
  const col = Number.isFinite(payload.col) ? payload.col : null;
  const stack = clampStr(payload.stack, CAPS.stack);
  let out = `${kind}: ${message}`;
  if (source) out += ` @${source}${line != null ? `:${line}` : ''}${col != null ? `:${col}` : ''}`;
  if (stack) out += ` | ${stack}`;
  return sanitize(out.replace(/\s*\n\s*/g, ' ⏎ '));
}

// per-socket 限流：窗口内最多 max 条，窗口滚动复位。闭包持状态，每个连接各建一个。
export function createSocketErrorLimiter({ max = 10, windowMs = 60000, now = Date.now } = {}) {
  let windowStart = -Infinity;
  let count = 0;
  return {
    allow() {
      const t = now();
      if (t - windowStart >= windowMs) { windowStart = t; count = 0; }
      if (count >= max) return false;
      count += 1;
      return true;
    },
  };
}
