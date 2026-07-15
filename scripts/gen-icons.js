// scripts/gen-icons.js —— 从 icon.svg 派生 PWA maskable 图标 + apple-touch-icon。
//
// 为什么不能直接给现有 icon 打 maskable 标：public/icons/icon.svg 是满幅圆角深底 + 右上绿点，
// Android/iOS 的圆形/圆角遮罩会裁掉圆角与绿点。maskable 规范要求内容落在中心直径 80% 的 safe-zone 内，
// 故此处「背景铺满整幅（无圆角）+ 内容缩到中心 72%（四周留 ~14% padding > 规范 10%）」。
//
// 依赖 Playwright Chromium（与 tests/e2e 共用同一浏览器工具链）栅格化 SVG→PNG。
// 用法：node scripts/gen-icons.js
// 产物：public/icons/{icon-maskable-192,icon-maskable-512,apple-touch-icon-180}.png（需生成后提交）
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const HERE = import.meta.dirname;
const ICONS = join(HERE, '..', 'public', 'icons');

// safe-zone 构图：满幅深底（与 icon.svg 同色 #0f172a、无圆角）+ 原图形内容整体缩到中心 72% 居中。
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0f172a"/>
  <g transform="translate(256 256) scale(0.72) translate(-256 -256)">
    <rect x="56" y="56" width="400" height="400" rx="64" fill="#1e293b"/>
    <text x="120" y="330" font-family="Menlo, monospace" font-size="220" font-weight="700" fill="#38bdf8">›_</text>
    <circle cx="400" cy="140" r="28" fill="#22c55e"/>
  </g>
</svg>`;

async function renderPng(browser, svg, size, outName) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(
    `<!doctype html><html><body style="margin:0;padding:0;line-height:0">${sized}</body></html>`,
    { waitUntil: 'networkidle' }
  );
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(join(ICONS, outName), buf);
  await page.close();
  console.log(`✔ ${outName} (${size}×${size}, ${buf.length}B)`);
}

const browser = await chromium.launch({ headless: true });
try {
  // maskable：Android 自适应图标（192/512）
  await renderPng(browser, maskableSvg, 192, 'icon-maskable-192.png');
  await renderPng(browser, maskableSvg, 512, 'icon-maskable-512.png');
  // apple-touch-icon：iOS 自加圆角遮罩，复用同一 safe-zone 构图（内容居中不被裁），180 为 Apple 推荐尺寸
  await renderPng(browser, maskableSvg, 180, 'apple-touch-icon-180.png');
} finally {
  await browser.close();
}
console.log('✅ 图标生成完成');
