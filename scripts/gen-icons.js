// scripts/gen-icons.js —— 从 public/icons/icon.svg 派生全部 PWA / 通知 / apple-touch 位图。
//
// 源：icon.svg（any 构图：圆角底 + 主图形）。
// maskable：Android/iOS 遮罩会裁边——背景铺满无圆角，内容缩到中心 72%（四周 ~14% > 规范 10% safe-zone）。
//
// 依赖 Playwright Chromium（与 tests/e2e 共用）栅格化 SVG→PNG。
// 用法：node scripts/gen-icons.js
// 产物（均提交）：
//   icon-192.png / icon-512.png（purpose:any）
//   icon-maskable-192.png / icon-maskable-512.png（purpose:maskable）
//   apple-touch-icon-180.png
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const HERE = import.meta.dirname;
const ICONS = join(HERE, '..', 'public', 'icons');
const SRC = join(ICONS, 'icon.svg');

const BG = '#AE5238';

/** 从 any 构图抽出「主图形」层（去掉外层圆角底），供 maskable 缩放。 */
function extractMark(svg) {
  // 去掉 XML 声明与最外层 <svg>…</svg>，再去掉第一块满幅圆角 rect（背景）
  let body = svg
    .replace(/<\?xml[^>]*\?>/i, '')
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim();
  body = body.replace(
    /<rect\b[^>]*\bwidth="512"[^>]*\bheight="512"[^>]*\/?>/i,
    ''
  ).trim();
  return body;
}

function buildAnySvg(srcSvg) {
  // 直接用源文件（保留注释与圆角底）
  return srcSvg.trim();
}

function buildMaskableSvg(markInner) {
  // 满幅无圆角底 + 内容居中 72%
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BG}"/>
  <g transform="translate(256 256) scale(0.72) translate(-256 -256)">
    ${markInner}
  </g>
</svg>`;
}

async function renderPng(browser, svg, size, outName) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  const sized = svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head>
     <body style="margin:0;padding:0;line-height:0;background:transparent">${sized}</body></html>`,
    { waitUntil: 'load' }
  );
  // 图形为 path/rect（无 <text>），无需等字体
  const buf = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: false,
  });
  writeFileSync(join(ICONS, outName), buf);
  await page.close();
  console.log(`✔ ${outName} (${size}×${size}, ${buf.length}B)`);
}

const srcSvg = readFileSync(SRC, 'utf8');
const anySvg = buildAnySvg(srcSvg);
const mark = extractMark(srcSvg);
if (!mark || !/text|path|circle|rect/i.test(mark)) {
  console.error('icon.svg 解析主图形失败——请保留满幅 512 背景 rect + 内容层');
  process.exit(1);
}
const maskableSvg = buildMaskableSvg(mark);

const browser = await chromium.launch({ headless: true });
try {
  // purpose:any
  await renderPng(browser, anySvg, 192, 'icon-192.png');
  await renderPng(browser, anySvg, 512, 'icon-512.png');
  // purpose:maskable + apple-touch（iOS 自加圆角，同样要 safe-zone）
  await renderPng(browser, maskableSvg, 192, 'icon-maskable-192.png');
  await renderPng(browser, maskableSvg, 512, 'icon-maskable-512.png');
  await renderPng(browser, maskableSvg, 180, 'apple-touch-icon-180.png');
} finally {
  await browser.close();
}
console.log('✅ 图标生成完成（any 192/512 · maskable 192/512 · apple-touch 180）');
