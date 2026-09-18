// logic/attachments.js —— 粘贴图片 · data URL · MIME 猜测 · 附件 chip
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';

// UX-020：同名附件序号；可选大小。
export function formatAttachmentChipLabel(name, occurrence = 1, sizeBytes) {
  const base = (name != null && String(name).trim()) ? String(name).trim() : t('附件');
  const n = Math.max(1, Number(occurrence) || 1);
  let label = n > 1 ? `${base} (${n})` : base;
  if (sizeBytes != null && Number.isFinite(Number(sizeBytes))) {
    const b = Number(sizeBytes);
    let sizeStr;
    if (b < 1024) sizeStr = `${b}B`;
    else if (b < 1024 * 1024) sizeStr = `${Math.max(1, Math.round(b / 1024))}KB`;
    else sizeStr = `${(b / (1024 * 1024)).toFixed(1)}MB`;
    label += ` · ${sizeStr}`;
  }
  return label;
}

// 从 paste 事件的 clipboardData 里挑出 image/* 文件（桌面 Chrome 截图/复制图 → Ctrl/Cmd+V）。
// 返回 File 数组；纯文本/无图返回 []——调用方应保留默认粘贴文字行为。
// 只做数据筛选，不读盘/不转 base64（那是 app.js 附件托盘的既有路径）。
export function pickPasteImageFiles(clipboardData) {
  const items = clipboardData?.items;
  if (!items || typeof items.length !== 'number') return [];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || it.kind !== 'file') continue;
    const type = String(it.type || '');
    if (!type.startsWith('image/')) continue;
    const file = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
    if (file) out.push(file);
  }
  return out;
}

// 发送前托盘点预览：把附件的完整 base64 拼成 <img src> 可用的 data URI。
// 仅 image/* + 非空 data；否则 null（调用方不弹灯箱，避免把 PDF/二进制当图打开）。
export function attachmentDataUrl(att) {
  if (!att || typeof att !== 'object') return null;
  const mime = String(att.mimeType || '');
  const data = att.data;
  if (!mime.startsWith('image/')) return null;
  if (typeof data !== 'string' || !data) return null;
  return `data:${mime};base64,${data}`;
}

// E18 附件预览：历史消息的附件只有文件名（transcript 不落 mimeType），按扩展名猜 image/*。
// 非图片扩展名 → null（调用方按「不可预览」处理，不把任意字节当图打开）。SVG 在 <img> 上下文不执行脚本，安全。
const IMAGE_MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', svg: 'image/svg+xml',
};
export function guessImageMime(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? (IMAGE_MIME_BY_EXT[m[1].toLowerCase()] || null) : null;
}
