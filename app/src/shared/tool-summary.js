// tool-summary.js —— 工具卡片摘要口径（脱敏 → 序列化 → 截断），live 与历史回显共用。
//
// 合并前 src/agent/agent.js（live 工具卡片）与 src/sessions/history.js（历史回显）各有一份逐字复制的
// 实现，且已经语义分叉：只有 live 侧带循环引用护栏，历史侧遇自引用结构会栈溢出、打断整条消息处理。
// 这里取两版超集，历史侧因此一并获得护栏。
//
// 放 src/shared 而非任一域：两个消费方分处 agent/ 与 sessions/ 两域，留在任一侧都会制造跨域回边
// （history.js 原注释写的「本模块独立实现，避免 history↔agent 循环依赖」正是复制的动机）。
export const TOOL_SUMMARY_CAP = 600; // 工具卡片摘要默认截断；permission_request 永不截断（4a）
export const TOOL_SUMMARY_CAP_BASH = 2000; // Bash/命令类输出用户常要多看几行

// 工具结果摘要的上限按工具名取（display-contracts §5「截断 600 / Bash 2000」）。live 与历史回放共用这一份：
// 历史侧原来一律 600，同一张卡刷新前后变短（验收 O55）。
export function toolResultCap(name) {
  const n = String(name || '');
  if (n === 'Bash' || n === 'bash' || n === 'run_command' || n === 'Shell') return TOOL_SUMMARY_CAP_BASH;
  return TOOL_SUMMARY_CAP;
}

// 长 base64/二进制载荷脱敏（Read 读图片等场景，tool_result 会带回原始字节供模型"看见"图片）：
// 不猜 SDK 具体字段名（同 file-preview.js 的二进制探测思路，防 SDK 版本漂移改字段名致失效）——
// 整串纯 base64 字符集且达到阈值长度才判定；真实代码/路径/命令几乎不可能连续 500+ 字符不含
// 空白或标点，故不会误伤 Edit/Write 预览 diff。脱敏须在 truncate() 之前，否则大 base64 会把
// TOOL_SUMMARY_CAP 截断额度提前占满，挤掉真正有用的字段。
const BASE64_REDACT_MIN_LEN = 500;
// 兼容 URL-safe 变体（-_ 代替 +/）：原正则不匹配它，走摘要路径时后面还有 truncate 兜底看不出来，
// 但 tool:full「展开全文」没有兜底 —— 一个漏判的 base64 图片就是整串原样进 DOM。
const BASE64_ONLY_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function truncate(s, cap = TOOL_SUMMARY_CAP) {
  if (typeof s !== 'string') return '';
  return s.length > cap ? s.slice(0, cap) + ' …（已截断）' : s;
}

export function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// seen：循环引用兜底（raw 结构不受本项目控制，MCP/SDK 工具输出可能自引用）——不加会在遇到循环
// 结构时无限递归直到栈溢出，和裸 JSON.stringify 一样能打断整条正在处理的消息。
// 递归数组必须写成 v => redactBase64(v, seen)：直接把函数传给 map 会让 index 落进 seen 形参。
export function redactBase64(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (value.length >= BASE64_REDACT_MIN_LEN && BASE64_ONLY_RE.test(value)) {
      return `（base64 数据，约 ${Math.ceil(value.length / 1024)}KB，已省略）`;
    }
    return value;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '（循环引用，已省略）';
    seen.add(value);
    if (Array.isArray(value)) return value.map(v => redactBase64(v, seen));
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactBase64(value[k], seen);
    return out;
  }
  return value;
}

// 三步组合：历史回显侧的 histToolSummary 即此函数。live 侧按工具类型用不同 cap，故各调用点自行组合。
export function toolSummary(value, cap = TOOL_SUMMARY_CAP) {
  return truncate(stringify(redactBase64(value)), cap);
}

// ── 桌面端 visualize 工具（show_widget）的完整源码通道 ──────────────────────────────────────────
// 桌面端给会话挂了一个 visualize MCP，模型用它在聊天里画 SVG 图或交互组件；终端 CLI 没有这个工具。
// 它的 input 是 {title, loading_messages, widget_code}，widget_code 是整段 <svg …> 或 HTML 片段，
// 走上面的 toolSummary 会被截到 600 字、只剩半截 SVG，前端只能显示成一行工具调用。
// 这里另出一个字段带完整源码，只对这一个工具名生效，其他工具的事件形状一个字节都不变。
//
// 【HTML 不带 code】交互组件要在桌面端的沙箱 iframe 里跑脚本，CCM 不执行任何模型生成的 HTML，
// 前端只显示标题和提示——源码用不上，就不往事件流和回放缓冲里塞。
// 【上限按字符数】SVG 基本是 ASCII，字符数≈字节数；超限整个不带，前端退回一行工具调用。
// 【为什么是 64K】带 widget 的事件会常驻在两处按【条数】封顶的缓存里：回放环形缓冲（每实例 2000 条）
// 与历史缓存（每会话 2000 条 × LRU 10）。单条上限直接决定常驻内存的量级——256K 时一个满缓冲就能
// 留下约 512MB 源码，再乘实例数 / LRU 就到 GB 级。真实的图约 4.5KB，64K 留足十倍余量。
export const WIDGET_TOOL_NAME = 'mcp__visualize__show_widget';
export const WIDGET_CODE_CAP = 64 * 1024;
const WIDGET_TITLE_CAP = 200;
const SVG_HEAD_RE = /^\s*<svg[\s>/]/i;

export function widgetPayload(name, input) {
  if (name !== WIDGET_TOOL_NAME || !input || typeof input !== 'object') return null;
  const code = input.widget_code;
  if (typeof code !== 'string' || !code.trim()) return null;
  const title = typeof input.title === 'string' ? input.title.slice(0, WIDGET_TITLE_CAP) : '';
  if (!SVG_HEAD_RE.test(code)) return { title, kind: 'html' };
  if (code.length > WIDGET_CODE_CAP) return null;
  return { title, kind: 'svg', code };
}
