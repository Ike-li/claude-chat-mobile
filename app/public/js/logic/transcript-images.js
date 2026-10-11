// logic/transcript-images.js —— 会话图片（工具截图、用户贴图）引用 → 缩略图格子的纯决策
//
// 事件与历史条目里只带引用（{ref, mediaType, bytes, tooLarge?}），图本身由 app/transcript-images.js
// 经鉴权的 image:get 按需取。这里只做数据→数据：哪些引用画格子、取回的载荷能不能拼成 data URL、失败写什么。
// 红线同 logic.js：不碰 DOM / window / socket / 应用可变状态；唯一宿主外 import 是 ../i18n.js。

import { t } from '../i18n.js';

// 与后端 app/src/shared/transcript-image.js 的 IMAGE_MEDIA_TYPES 必须相等（边界闸禁止互相 import，
// 由 single-source-of-truth.test.mjs 钉住）。后端已经滤过一遍，这里是 data: URL 拼接前的第二道：
// svg 进 data: URL 能带脚本，不能只信对端。
export const TRANSCRIPT_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TYPE_SET = new Set(TRANSCRIPT_IMAGE_TYPES);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// 引用列表 → 格子。超上限（后端标 tooLarge）直接占位、不发请求；白名单外与畸形条目不画。
export function planTranscriptImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const img of images) {
    if (!img || typeof img.ref !== 'string' || !img.ref || !TYPE_SET.has(img.mediaType)) continue;
    const bytes = Number.isFinite(img.bytes) ? img.bytes : 0;
    out.push({ ref: img.ref, mediaType: img.mediaType, bytes, state: img.tooLarge ? 'too_large' : 'pending' });
  }
  return out;
}

// image:get 的 ack → data URL；任何一项不合规都返回 null（调用方显示「图片无法加载」）。
export function transcriptImageDataUrl(res) {
  if (!res || res.ok !== true || !TYPE_SET.has(res.mediaType)) return null;
  if (typeof res.data !== 'string' || !BASE64_RE.test(res.data)) return null;
  return `data:${res.mediaType};base64,${res.data}`;
}

export function transcriptImageFailureText(code, bytes) {
  if (code === 'too_large' && Number.isFinite(bytes) && bytes > 0) {
    return `${t('图片过大（')}${(bytes / (1024 * 1024)).toFixed(1)}${t('MB），未加载')}`;
  }
  return t('图片无法加载');
}
