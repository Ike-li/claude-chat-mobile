// make-demo-clips.js —— 用视觉 mock UI 录制场景片段为 mp4（介绍视频素材用），make-demo-gif.js 的姊妹脚本。
// 依赖：puppeteer + 系统 ffmpeg(合成 H.264)。零 token：走 visual-mock-server 的 demo:* 中文场景。
// 两种抓帧模式：
//   screencast —— CDP Page.screencast，帧率高但只出 CSS 像素（375×812）
//   screenshot —— Page.captureScreenshot 循环，吃 deviceScaleFactor 出高分辨率（默认，1125×2436@dsf3），~8-12fps
// 用法：node scripts/make-demo-clips.js --out <目录> [--mode screenshot|screencast] [--fps 30] [--dsf 3] [--only stream,approval]
//       产物：<目录>/<name>.mp4 + clips.json（尺寸/帧数/时长元数据）
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const PORT = '3198';
const VIEW_W = 375, VIEW_H = 812;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT_DIR = arg('out', join(tmpdir(), 'ccm-demo-clips'));
const MODE = arg('mode', 'screenshot');
const FPS = Number(arg('fps', '30'));
const DSF = Number(arg('dsf', '3'));
const ONLY = arg('only', '').split(',').filter(Boolean);
const FRAME_MS = 1000 / FPS;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 场景片段注册表：每个片段 = 一次干净会话里的一段交互（命令见 visual-mock-server 的 demo:* 场景）----
const CLIPS = [
  {
    name: 'stream', // 流式逐字回复（中文 markdown + 代码块）
    run: async ({ send, waitIdle }) => {
      await sleep(500);
      await send('demo:stream');
      await waitIdle(20000);
      await sleep(1200);
    }
  },
  {
    name: 'tools', // 工具执行卡片（read/edit/test）+ 展开看过程
    run: async ({ page, send, waitIdle }) => {
      await sleep(500);
      await send('demo:tool');
      await waitIdle(25000);
      await page.waitForSelector('details.toolcard summary').catch(() => {});
      await page.click('details.toolcard summary').catch(() => {});
      await sleep(1600);
    }
  },
  {
    name: 'approval', // HERO：git push 回手机审批（前置 commit 免审批直接过）
    run: async ({ page, send, waitIdle }) => {
      await sleep(500);
      await send('demo:permission');
      await page.waitForSelector('#permModal:not(.hidden)', { timeout: 15000 }).catch(() => {});
      await sleep(2200); // 停在弹窗上看清命令
      await page.click('#permAllow').catch(() => {});
      await page.waitForSelector('#permModal.hidden', { timeout: 8000 }).catch(() => {});
      await waitIdle(15000);
      await sleep(1100);
    }
  },
  {
    name: 'question', // agent 提问发布分支，手机上点选项作答
    run: async ({ page, send, waitIdle }) => {
      await sleep(500);
      await send('demo:question');
      await page.waitForSelector('#questionModal:not(.hidden)', { timeout: 12000 }).catch(() => {});
      await sleep(2000);
      await page.click('#questionOptions button').catch(() => {});
      await page.waitForSelector('#questionModal.hidden', { timeout: 8000 }).catch(() => {});
      await waitIdle(15000);
      await sleep(1500);
    }
  },
  {
    name: 'tabs', // 多仓库并行：回复后拉开工作区抽屉展示多实例状态
    run: async ({ page, send, waitIdle }) => {
      await sleep(500);
      await send('demo:tab');
      await waitIdle(20000);
      await sleep(400);
      await page.click('#btnSessions').catch(() => {});
      await sleep(2400);
      await page.click('#sidebarClose').catch(() => {});
      await sleep(800);
    }
  },
  {
    name: 'statusline', // Web 自有状态栏：token/成本/git 结构化更新
    run: async ({ send, waitIdle }) => {
      await sleep(500);
      await send('demo:statusline');
      await waitIdle(15000);
      await sleep(2000);
    }
  }
];

async function recordClip(page, clip) {
  // 每个片段从干净会话开始
  await fetch(`http://127.0.0.1:${PORT}/__reset`, { method: 'POST' });
  await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#input');
  await sleep(1400); // 等冷启动水合
  await page.evaluate(() => document.getElementById('historyLoadingCard')?.remove());
  await sleep(300);

  const client = await page.createCDPSession();
  const frames = []; // { buf, t }

  const send = async (text) => {
    await page.evaluate((val) => {
      const i = document.getElementById('input');
      i.value = val; i.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await sleep(150);
    await page.click('#btnSend');
  };
  const waitIdle = async (timeout = 15000) => {
    await page.waitForSelector('#activeStatusPill.hidden', { timeout }).catch(() => {});
  };

  let capture; // {stop}
  if (MODE === 'screencast') {
    client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      frames.push({ buf: Buffer.from(data, 'base64'), t: Date.now() });
      try { await client.send('Page.screencastFrameAck', { sessionId }); } catch {}
    });
    await client.send('Page.startScreencast', {
      format: 'png', everyNthFrame: 1, maxWidth: VIEW_W * DSF, maxHeight: VIEW_H * DSF
    });
    capture = { stop: () => client.send('Page.stopScreencast') };
  } else {
    // screenshot 循环：串行 await 自然限速；captureScreenshot 按 deviceScaleFactor 出高分辨率帧
    const flag = { stopped: false };
    const loop = (async () => {
      while (!flag.stopped) {
        try {
          const { data } = await client.send('Page.captureScreenshot', {
            format: 'png', optimizeForSpeed: true,
            clip: { x: 0, y: 0, width: VIEW_W, height: VIEW_H, scale: DSF } // scale 拿高分辨率（不带 clip 只出 CSS 像素）
          });
          frames.push({ buf: Buffer.from(data, 'base64'), t: Date.now() });
        } catch { break; }
      }
    })();
    capture = { stop: async () => { flag.stopped = true; await loop; } };
  }

  await clip.run({ page, send, waitIdle });
  await capture.stop();
  await client.detach().catch(() => {});
  await sleep(150);
  if (!frames.length) throw new Error(`片段 ${clip.name} 未捕获到任何帧`);

  // 重采样到固定帧率（取每个时刻最近的已变化帧），末帧多停 0.6s
  const t0 = frames[0].t, tEnd = frames[frames.length - 1].t;
  const picked = [];
  for (let t = t0; t <= tEnd; t += FRAME_MS) {
    let f = frames[0];
    for (const fr of frames) { if (fr.t <= t) f = fr; else break; }
    picked.push(f.buf);
  }
  for (let i = 0; i < FPS * 0.6; i++) picked.push(frames[frames.length - 1].buf);
  const rate = (frames.length / ((tEnd - t0) / 1000)).toFixed(1);
  console.log(`   （实际抓帧 ${frames.length} 张 ≈ ${rate}fps）`);
  return picked;
}

function encodeMp4(name, pngBufs) {
  const tmp = mkdtempSync(join(tmpdir(), `ccm-clip-${name}-`));
  try {
    pngBufs.forEach((buf, i) => writeFileSync(join(tmp, `f_${String(i).padStart(5, '0')}.png`), buf));
    const out = join(OUT_DIR, `${name}.mp4`);
    const res = spawnSync('ffmpeg', [
      '-y', '-framerate', String(FPS), '-i', join(tmp, 'f_%05d.png'),
      '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2', // yuv420p 要求偶数边
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      out
    ], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`ffmpeg 失败(${name}): ${(res.stderr || '').slice(-800)}`);
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function probe(file) {
  const res = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames', '-show_entries', 'format=duration',
    '-of', 'json', file
  ], { encoding: 'utf8' });
  try {
    const j = JSON.parse(res.stdout);
    return {
      width: j.streams?.[0]?.width, height: j.streams?.[0]?.height,
      frames: Number(j.streams?.[0]?.nb_frames), durationSec: Number(j.format?.duration)
    };
  } catch { return {}; }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`📡 启动 mock server (PORT=${PORT})...`);
  const mock = spawn('node', ['scripts/visual-mock-server.js'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT }
  });
  const cleanup = () => { try { mock.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);
  await sleep(1600);

  const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const meta = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: VIEW_W, height: VIEW_H, isMobile: true, hasTouch: true, deviceScaleFactor: DSF });

    const wanted = ONLY.length ? CLIPS.filter(c => ONLY.includes(c.name)) : CLIPS;
    for (const clip of wanted) {
      console.log(`🎬 录制 ${clip.name} (${MODE})...`);
      const picked = await recordClip(page, clip);
      console.log(`🧩 编码 ${clip.name} (${picked.length} 帧 @${FPS}fps)...`);
      const file = encodeMp4(clip.name, picked);
      const info = probe(file);
      meta.push({ name: clip.name, file, fps: FPS, mode: MODE, ...info });
      console.log(`✅ ${file}  ${info.width}x${info.height}  ${info.durationSec?.toFixed(1)}s`);
    }
    writeFileSync(join(OUT_DIR, 'clips.json'), JSON.stringify(meta, null, 2));
    console.log(`📄 元数据写入 ${join(OUT_DIR, 'clips.json')}`);
  } finally {
    await browser.close();
    cleanup();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
