// make-demo-clips.js —— 用 ccm 视觉 mock UI 录制 6 段高分辨率手机演示片段（宣传视频素材）。
// 收编自主仓 scripts/make-demo-clips.js（已随宣传层从 dev 移除，见主仓 f995000）；
// demo:* 中文场景也已从 dev 拆除（00c5b01），所以录制必须对着一个**含 demo 场景的历史检出**跑：
//   git -C <ccm主仓> worktree add --detach <rigDir> 00c5b01^   # demo 场景拆除前最后一个 commit
//   cd <rigDir> && npm ci                                       # rig 自己的依赖（mock server 需要）
// 用法：
//   CCM_REPO_DIR=<rigDir> [CCM_CLIPS_OUT_DIR=clips] node tools/make-demo-clips.js
// 产物：OUT_DIR 下 stream/tools/approval/question/tabs/statusline 共 6 个 .mp4 + clips.json
// 依赖：本目录 `npm i`（@playwright/test 提供 Chromium）+ 系统 ffmpeg。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const REPO = process.env.CCM_REPO_DIR;
if (!REPO || !existsSync(join(REPO, 'tests/e2e/mock/scenarios/demo.js'))) {
  console.error('❌ 需要 CCM_REPO_DIR 指向含 demo:* mock 场景的 ccm 检出（demo 场景已从 dev 拆除）。');
  console.error('   git -C <ccm主仓> worktree add --detach <rigDir> 00c5b01^ && cd <rigDir> && npm ci');
  process.exit(1);
}
const OUT_DIR = process.env.CCM_CLIPS_OUT_DIR || join(process.cwd(), 'clips');
const PORT = process.env.CCM_CLIPS_PORT || '3196';
const BASE = `http://127.0.0.1:${PORT}`;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('📡 启动 mock server (PORT=' + PORT + ')...');
  const mock = spawn('node', ['tests/e2e/mock/server.js'], {
    cwd: REPO, stdio: 'ignore', env: { ...process.env, PORT }
  });
  const cleanup = () => { try { mock.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);
  await sleep(1600);

  const browser = await chromium.launch({ headless: true });
  const clipsMeta = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3, // 375x812 -> 1125x2436 高分辨率
    });

    const reset = async () => {
      await page.request.post(`${BASE}/__reset`);
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('#btnNew');
      await page.waitForSelector('#connDot.bg-success', { timeout: 10_000 }).catch(() => {});
    };
    const ensureComposer = async () => {
      if (await page.locator('#input').isVisible()) return;
      await page.click('#btnNew');
      await page.waitForSelector('#input');
    };
    const send = async (text) => {
      await ensureComposer();
      await page.fill('#input', text);
      await page.click('#btnSend');
    };
    const waitIdle = async () => {
      await page.waitForSelector('#streamLiveStatus', { state: 'detached', timeout: 20_000 }).catch(() => {});
    };

    // 后台高频截帧循环 + 期间跑 action()；结束后按固定 FPS 重采样、ffmpeg 编码 mp4。
    const recordClip = async (name, action) => {
      const frames = [];
      let stop = false;
      const loop = (async () => {
        while (!stop) {
          const buf = await page.screenshot({ type: 'png' }).catch(() => null);
          if (buf) frames.push({ buf, t: Date.now() });
        }
      })();
      try {
        await action();
      } finally {
        stop = true;
        await loop;
      }

      const t0 = frames[0].t, tEnd = frames[frames.length - 1].t;
      const picked = [];
      for (let t = t0; t <= tEnd; t += FRAME_MS) {
        let f = frames[0];
        for (const fr of frames) { if (fr.t <= t) f = fr; else break; }
        picked.push(f.buf);
      }
      for (let i = 0; i < FPS * 0.6; i++) picked.push(frames[frames.length - 1].buf); // 收尾多停 0.6s

      const frameDir = join(OUT_DIR, `_frames_${name}`);
      mkdirSync(frameDir, { recursive: true });
      picked.forEach((buf, i) => writeFileSync(join(frameDir, `f${String(i).padStart(5, '0')}.png`), buf));
      const outFile = join(OUT_DIR, `${name}.mp4`);
      // 1125(=375*3) 是奇数，H.264 要求宽高偶数；缩到 1124x2436，AR 不变。
      // -g/-keyint_min 强制每秒一个关键帧：静止画面居多的片段 seek 时才不冻结。
      const r = spawnSync('ffmpeg', [
        '-y', '-v', 'error', '-framerate', String(FPS), '-i', join(frameDir, 'f%05d.png'),
        '-vf', 'scale=1124:2436', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-g', String(FPS), '-keyint_min', String(FPS), outFile
      ], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`ffmpeg 编码失败(${name}): ${r.stderr}`);
      rmSync(frameDir, { recursive: true, force: true });

      const durationSec = +(picked.length / FPS).toFixed(6);
      clipsMeta.push({ name, file: outFile, fps: FPS, mode: 'screenshot', width: 1124, height: 2436, frames: picked.length, durationSec });
      console.log(`🎬 ${name}.mp4 · ${picked.length} 帧 · ${durationSec.toFixed(2)}s`);
    };

    // 1) stream —— 终端等价：中文流式回答
    await reset();
    await recordClip('stream', async () => {
      await send('demo:stream');
      await waitIdle();
      await sleep(600);
    });

    // 2) tools —— 工具可见：展开一张工具卡片看过程
    await reset();
    await recordClip('tools', async () => {
      await send('demo:tool');
      await page.waitForSelector('details.toolcard', { timeout: 15_000 });
      await page.locator('details.toolcard summary').first().click();
      await waitIdle();
      await sleep(600);
    });

    // 3) approval（HERO）—— 手机审批：定格在待处理弹窗，不点允许/拒绝
    await reset();
    await recordClip('approval', async () => {
      await send('demo:permission');
      await page.waitForSelector('#permModal:not(.hidden)', { timeout: 8_000 });
      await sleep(1800);
    });

    // 4) question —— 随时作答：定格在待选问题
    await reset();
    await recordClip('question', async () => {
      await send('demo:question');
      await page.waitForSelector('#questionModal:not(.hidden)', { timeout: 8_000 });
      await sleep(1800);
    });

    // 5) tabs —— 多仓库并行：文字介绍后展开会话抽屉看两个工作区
    await reset();
    await recordClip('tabs', async () => {
      await send('demo:tab');
      await waitIdle();
      await page.click('#btnSessions');
      await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
      await sleep(1200);
    });

    // 6) statusline —— 心里有数：展开 CLI 密集态状态行
    await reset();
    await recordClip('statusline', async () => {
      await send('demo:statusline');
      await waitIdle();
      await page.locator('#cliStatusWrap summary').click();
      await sleep(1000);
    });

    writeFileSync(join(OUT_DIR, 'clips.json'), JSON.stringify(clipsMeta, null, 2));
    console.log(`✅ ${clipsMeta.length} 段 clip 已写入 ${OUT_DIR}`);
  } finally {
    await browser.close();
    cleanup();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
