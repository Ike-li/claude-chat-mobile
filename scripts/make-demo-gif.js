// make-demo-gif.js —— 用视觉 mock UI 录制一段移动端 demo GIF（文档用）。
// 零外部二进制依赖：Playwright Chromium(CDP screencast 截 PNG 帧) + pngjs(解码) + gifenc(纯 JS 编码)。
// 流程：启动 mock → 流式回答 → 工具卡片 → 手机端批准「git push」(hero) → 结束。
// 用法：node scripts/make-demo-gif.js   产物：docs/demo.gif
/* global document -- page.evaluate 回调在浏览器上下文执行 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import pngjs from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const { PNG } = pngjs;
const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const OUT = process.env.CCM_DEMO_GIF_OUT || join(ROOT, 'docs', 'demo.gif');
const PORT = process.env.CCM_DEMO_PORT || '3199';
const FPS = 8;                  // 输出帧率
const FRAME_MS = Math.round(1000 / FPS);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('📡 启动 mock server (PORT=' + PORT + ')...');
  const mock = spawn('node', ['tests/e2e/mock/server.js'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT }
  });
  const cleanup = () => { try { mock.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);

  await sleep(1600);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#input');

    // ---- CDP 截帧（PNG，按变化推帧）----
    const client = await page.context().newCDPSession(page);
    const frames = []; // { buf, t }
    client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      frames.push({ buf: Buffer.from(data, 'base64'), t: Date.now() });
      try { await client.send('Page.screencastFrameAck', { sessionId }); } catch {}
    });

    const send = async (text) => {
      await page.evaluate((val) => {
        const i = document.getElementById('input');
        i.value = val; i.dispatchEvent(new Event('input', { bubbles: true }));
      }, text);
      await sleep(150);
      await page.click('#btnSend');
    };
    const waitIdle = async () => {
      await page.waitForSelector('#activeStatusPill.hidden', { timeout: 15000 }).catch(() => {});
    };

    await sleep(1400);                        // 等冷启动水合
    await page.evaluate(() => document.getElementById('historyLoadingCard')?.remove()); // 开场落在干净空对话
    await sleep(300);
    await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 280, maxHeight: 600 });
    console.log('🎬 录制中...');

    await sleep(600);                         // 起手：就绪空对话停一拍

    // 1) 流式回答
    await send('test:stream');
    await waitIdle();
    await sleep(900);

    // 2) 工具卡片 + 展开一张
    await send('test:tool');
    await waitIdle();
    await page.waitForSelector('details.toolcard summary').catch(() => {});
    await page.click('details.toolcard summary').catch(() => {});
    await sleep(1200);

    // 3) HERO：手机端批准 git push
    await send('test:permission');
    await page.waitForSelector('#permModal:not(.hidden)', { timeout: 8000 }).catch(() => {});
    await sleep(1800);                        // 停在弹窗上让人看清命令
    await page.click('#permAllow').catch(() => {});
    await page.waitForSelector('#permModal.hidden', { timeout: 8000 }).catch(() => {});
    await waitIdle();
    await sleep(900);                         // 收尾停一拍

    await client.send('Page.stopScreencast');
    await sleep(150);
    console.log(`📸 捕获 ${frames.length} 原始帧，重采样到 ${FPS}fps...`);
    if (!frames.length) throw new Error('未捕获到任何帧');

    // ---- 重采样到固定帧率（取每个时刻最近的已变化帧）----
    const t0 = frames[0].t, tEnd = frames[frames.length - 1].t;
    const picked = [];
    for (let t = t0; t <= tEnd; t += FRAME_MS) {
      let f = frames[0];
      for (const fr of frames) { if (fr.t <= t) f = fr; else break; }
      picked.push(f.buf);
    }
    // 末帧多停 ~0.8s
    for (let i = 0; i < FPS * 0.8; i++) picked.push(frames[frames.length - 1].buf);
    console.log(`🧩 编码 ${picked.length} 帧 GIF...`);

    // ---- 编码 ----
    const enc = GIFEncoder();
    let W = 0, H = 0;
    for (const buf of picked) {
      const png = PNG.sync.read(buf);
      W = png.width; H = png.height;
      const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      enc.writeFrame(index, W, H, { palette, delay: FRAME_MS });
    }
    enc.finish();
    const bytes = enc.bytes();
    writeFileSync(OUT, bytes);
    const kb = (bytes.length / 1024).toFixed(0);
    console.log(`✅ 写出 ${OUT}  (${W}x${H}, ${picked.length} 帧, ${kb} KB)`);
  } finally {
    await browser.close();
    cleanup();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
