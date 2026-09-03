// tool-summary.js —— 工具卡片摘要口径（脱敏 → 序列化 → 截断），live 与历史回显共用。
//
// 合并前 src/agent/agent.js（live 工具卡片）与 src/sessions/history.js（历史回显）各有一份逐字复制的
// 实现，且已经语义分叉：只有 live 侧带循环引用护栏，历史侧遇自引用结构会栈溢出、打断整条消息处理。
// 这里取两版超集，历史侧因此一并获得护栏。
//
// 放 src/shared 而非任一域：两个消费方分处 agent/ 与 sessions/ 两域，留在任一侧都会制造跨域回边
// （history.js 原注释写的「本模块独立实现，避免 history↔agent 循环依赖」正是复制的动机）。
export const TOOL_SUMMARY_CAP = 600; // 工具卡片摘要默认截断；permission_request 永不截断（4a）

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
