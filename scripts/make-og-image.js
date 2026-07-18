// make-og-image.js —— 从 docs/index.html 真实 hero 区域截取社交分享卡 docs/og-image.jpg。
// 不是独立设计稿：直接对线上落地页的 <header class="hero"> 定向截图（暗色配色走页面自带的
// prefers-color-scheme:dark token），保证文案、手机截图与 index.html 正文永远同步。
// 用法：node scripts/make-og-image.js   产物：docs/og-image.jpg
import express from 'express';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const DOCS = join(ROOT, 'docs');
const OUT = process.env.CCM_OG_IMAGE_OUT || join(DOCS, 'og-image.jpg');
const PORT = process.env.CCM_OG_PORT || '3197';

async function main() {
  const app = express();
  app.use(express.static(DOCS));
  const server = await new Promise((resolve) => {
    const s = app.listen(Number(PORT), '127.0.0.1', () => resolve(s));
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 2,
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('header.hero img');

    await page.locator('header.hero').screenshot({ path: OUT, type: 'jpeg', quality: 92 });
    console.log(`✅ 写出 ${OUT}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
