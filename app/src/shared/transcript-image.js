// transcript-image.js —— 会话里的图片块：哪些能显示、引用怎么造怎么解、取图载荷怎么验。
//
// 两类图片都落在 transcript 里，形态相同（{type:'image', source:{type:'base64', media_type, data}}）：
//   · 工具结果里的截图（浏览器 / Chrome / computer use、Read 读图片）：tool_result.content[] 里的块；
//   · 用户贴进对话的图（终端 / 桌面端粘贴）：user message content[] 里的块。
// 事件与历史条目里【只带引用】（{ref, mediaType, bytes}），图本身由前端经鉴权的 image:get 按需取：
// 截图中位 ~100KB、最大见过 ~670KB（base64），内联进 agent:event 会撑爆环形缓冲与手机上的历史加载。
//
// 放 src/shared：live（agent/）、历史（sessions/history.js）、按引用读盘（sessions/transcript-images.js）
// 三处共用同一套判据——任何一处自己另写，列表里说「有图」和取图时说「没有」就会对不上。

// 只认这四种：浏览器 <img> 普遍能解、且没有脚本面（svg 能带脚本，不放）。
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEDIA_TYPE_SET = new Set(IMAGE_MEDIA_TYPES);
// 单张上限（解码后字节）。实测本机 1187 张会话图最大 ~500KB，留 4 倍余量；超限的列出来但不传，前端显示占位。
// 取图是一条 ack 整张回传，上限同时决定了这条消息最大多大。
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// 引用里的 id 段：toolUseId（toolu_…）与 uuid 都落在这个字符集里；冒号是分隔符，不得出现在段内。
const REF_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;
const REF_INDEX_RE = /^(0|[1-9]\d{0,3})$/;

export function base64DecodedBytes(data) {
  if (typeof data !== 'string' || !data) return 0;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - pad;
}

function isImageBlock(b) {
  return b && typeof b === 'object' && b.type === 'image';
}

// 第 n 个图片块（n 按全部图片块计数，被拒的也占位），原样返回、不做校验——校验交给 checkImagePayload。
export function nthImageBlock(content, n) {
  if (!Array.isArray(content)) return null;
  let i = 0;
  for (const b of content) {
    if (!isImageBlock(b)) continue;
    if (i++ !== n) continue;
    const src = b.source;
    if (!src || src.type !== 'base64') return null;
    return { mediaType: src.media_type, data: src.data };
  }
  return null;
}

// content 里可显示的图片 → 引用列表。makeRef(n) 由调用方给（工具结果 / 用户消息两种寻址）。
// 序号 n 是「第几个图片块」而不是「第几个可显示的」：取图时 nthImageBlock 按同一口径回找，
// 白名单将来改了，已经发出去的引用也不会指错块。
export function imageRefsOf(content, makeRef) {
  if (!Array.isArray(content)) return [];
  const out = [];
  let n = -1;
  for (const b of content) {
    if (!isImageBlock(b)) continue;
    n++;
    const src = b.source;
    if (!src || src.type !== 'base64' || typeof src.data !== 'string') continue;
    if (!MEDIA_TYPE_SET.has(src.media_type)) continue;
    const bytes = base64DecodedBytes(src.data);
    const ref = { ref: makeRef(n), mediaType: src.media_type, bytes };
    if (bytes > IMAGE_MAX_BYTES) ref.tooLarge = true;
    out.push(ref);
  }
  return out;
}

// 引用文法：t:<toolUseId>:<n>[:<子代理那次 Agent 调用的 toolUseId>] · u:<消息 uuid>:<n>
// 子代理段只是「主 transcript 里找不到时去哪个子代理文件找」的提示，不是授权依据；
// 字符集不合法就丢掉提示（旧格式 sidechain 的挂靠值可能是 'sidechain' 之外的杂值），不让整条引用作废。
export function toolImageRef(toolUseId, n, agentToolUseId = null) {
  return typeof agentToolUseId === 'string' && REF_ID_RE.test(agentToolUseId)
    ? `t:${toolUseId}:${n}:${agentToolUseId}`
    : `t:${toolUseId}:${n}`;
}
export function userImageRef(uuid, n) {
  return `u:${uuid}:${n}`;
}

export function parseImageRef(ref) {
  if (typeof ref !== 'string' || ref.length > 300) return null;
  const parts = ref.split(':');
  const [kind, id, index, agent] = parts;
  if (kind === 't') {
    if (parts.length !== 3 && parts.length !== 4) return null;
    if (parts.length === 4 && !REF_ID_RE.test(agent)) return null;
  } else if (kind === 'u') {
    if (parts.length !== 3) return null;
  } else {
    return null;
  }
  if (!REF_ID_RE.test(id) || !REF_INDEX_RE.test(index)) return null;
  return { kind: kind === 't' ? 'tool' : 'user', id, index: Number(index), agent: parts.length === 4 ? agent : null };
}

// 取图回传前的最后一道：白名单、上限、base64 字符集（data 会被前端拼进 data: URL）。
export function checkImagePayload({ mediaType, data } = {}) {
  if (!MEDIA_TYPE_SET.has(mediaType)) return { ok: false, code: 'unsupported' };
  if (typeof data !== 'string' || !BASE64_RE.test(data)) return { ok: false, code: 'malformed' };
  const bytes = base64DecodedBytes(data);
  if (bytes > IMAGE_MAX_BYTES) return { ok: false, code: 'too_large', bytes };
  return { ok: true, bytes };
}

// 有图的工具结果，摘要只取文字部分：图已经单独显示，再把「base64 数据已省略」的 JSON 骨架塞进摘要
// 只会挤掉 600 字截断额度。全是文字块就拼成纯文本；还有别的结构化块就保留数组（交给原摘要口径）。
export function stripImageBlocks(content) {
  if (!Array.isArray(content)) return content;
  const rest = content.filter(b => !isImageBlock(b));
  if (rest.every(b => b && b.type === 'text' && typeof b.text === 'string')) return rest.map(b => b.text).join('\n');
  return rest;
}
