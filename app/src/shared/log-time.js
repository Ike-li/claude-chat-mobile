// log-time.js —— 服务端日志行时间戳前缀
// LaunchAgent 只做 stdout 重定向、不加时间戳，排障时无法回答"这行是什么时候打的"，
// 也没法和隧道日志/客户端现象对时。这里包一层 console 给每行加本地 ISO 时间戳（带
// 时区偏移；cloudflared 日志是 UTC，换算差个偏移量）。入口在 server.js 的动态
// import('app.js') 之前安装，覆盖所有模块级与运行期输出。

const WRAPPED = Symbol('ccm-log-time-wrapped');
const METHODS = ['log', 'info', 'warn', 'error'];

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatTimestamp(d) {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function wrapConsole(target, now = () => new Date()) {
  if (target[WRAPPED]) return target;
  for (const m of METHODS) {
    const orig = target[m].bind(target);
    target[m] = (...args) => orig(formatTimestamp(now()), ...args);
  }
  target[WRAPPED] = true;
  return target;
}

export function installLogTimestamps() {
  wrapConsole(console);
}
