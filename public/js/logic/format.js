// logic/format.js —— 基础格式化与转义原语（叶子层：不依赖任何其他 logic 子模块）
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';

// HTML 转义。app.js 多处复用（审批命令、工具参数摘要）+ ansiToHtml 内部。
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// E16：24-bit ANSI 前景色(\x1b[38;2;R;G;Bm)与重置(\x1b[0m/\x1b[m) → span；其他 SGR 吞序列保文本；
// 逐段 esc 后拼接（安全顺序：escape → 着色 → 调用方 DOMPurify），结尾补闭合防未闭合 ANSI。
export function ansiToHtml(s) {
  let out = '', open = 0;
  // eslint-disable-next-line no-control-regex -- 本函数职责就是解析 ANSI 转义序列
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex -- 同上
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) { out += esc(part); continue; }
    const rgb = /^38;2;(\d{1,3});(\d{1,3});(\d{1,3})$/.exec(m[1]);
    if (rgb) { out += `<span style="color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})">`; open++; }
    else if (m[1] === '' || m[1] === '0') { out += '</span>'.repeat(open); open = 0; }
  }
  return out + '</span>'.repeat(open);
}

// E15：将 URL-safe Base64（无填充）的公钥字符串转为 Uint8Array（PushManager.subscribe 要求的格式）。
// 纯逻辑，可在 node:test 中直接验证。
export function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// 连接 RTT 数值段：合法有限非负 number → 整数 ms（≥1000 用 1 位小数 s）。
// 接线层再拼人话前缀「延迟 …」；非法/未知 → ''，接线层据此隐藏，避免断线残留陈旧数字。
export function formatRttMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// 连接 RTT 色阶语义 token：good(<150) / ok(<400) / warn(<1000) / bad(≥1000)。
// 返回语义名而非 Tailwind class；接线层：good/ok → 中性 ink-soft（不与绿点抢色），warn/bad → warning/danger。
// 非法 → ''，与 formatRttMs 对齐（隐藏时不着色）。
export function rttToneClass(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 150) return 'good';
  if (ms < 400) return 'ok';
  if (ms < 1000) return 'warn';
  return 'bad';
}

// 用户气泡长消息折叠决策（纯函数）。
// 移动端痛点：长指令气泡占满屏、想上滑看前面的内容被它顶住。阈值取「实际换行数 + 自动换行估算」
// 偏多的一类——超阈值则建议折叠（DOM 接线在 app.js 渲染 max-height + 展开按钮）。
//
// 行数估算：显式 \n 拆出的段 + 每段按 cols 字符自动换行行数（cols≈手机气泡可容纳字符宽）。
// cols 取 30：实测旧款 iPhone Safari 中文 16px 气泡约 28-32 字符/行，取偏窄值保守触发折叠。
//   返回 { fold: bool, lines: number }
//   fold 仅当超 foldLines（默认 10）行——短指令（一两周行）不折，覆盖原痛点又不过度。
export function userBubbleFold(text, { foldLines = 10, cols = 30 } = {}) {
  const s = String(text ?? '');
  if (!s) return { fold: false, lines: 0 };
  let lines = 0;
  for (const seg of s.split('\n')) {
    lines += seg.length === 0 ? 1 : Math.ceil(seg.length / cols);
  }
  return { fold: lines > foldLines, lines };
}

// ── 服务状态面板（service:status ack → 三段渲染）────────────────────────────
// 与 formatAgo 分工：这里是"运行了多久"（时长），那边是"多久之前"（时点距今）。
export function formatUptime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs} ${t('秒')}`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} ${t('分钟')}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${t('小时')} ${mins % 60} ${t('分')}`;
  return `${Math.floor(hours / 24)} ${t('天')} ${hours % 24} ${t('小时')}`;
}
