// make-demo-clips.js —— 用 ccm 视觉 mock UI 录制多段高分辨率手机演示片段（宣传视频素材）。
// 收编自主仓 scripts/make-demo-clips.js（已随宣传层从 dev 移除，见主仓 f995000）；
// demo:* 中文场景也已从 dev 拆除（00c5b01），所以录制必须对着一个**含 demo 场景的历史检出**跑：
//   git -C <ccm主仓> worktree add --detach <rigDir> 00c5b01^   # demo 场景拆除前最后一个 commit
//   cd <rigDir> && npm ci                                       # rig 自己的依赖（mock server 需要）
// 用法：
//   CCM_REPO_DIR=<rigDir> [CCM_CLIPS_OUT_DIR=clips] node tools/make-demo-clips.js
// 产物：OUT_DIR 下多段 .mp4 + clips.json（含 demo 六段 + 加长/点选/排队/附件/子 agent 等）
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
    const waitIdle = async (timeout = 25_000) => {
      await page.waitForSelector('#streamLiveStatus', { state: 'detached', timeout }).catch(() => {});
    };

    // 后台高频截帧循环 + 期间跑 action()；结束后按固定 FPS 重采样、ffmpeg 编码 mp4。
    const recordClip = async (name, action, { holdSec = 0.6 } = {}) => {
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

      if (!frames.length) throw new Error(`无帧: ${name}`);
      const t0 = frames[0].t, tEnd = frames[frames.length - 1].t;
      const picked = [];
      for (let t = t0; t <= tEnd; t += FRAME_MS) {
        let f = frames[0];
        for (const fr of frames) { if (fr.t <= t) f = fr; else break; }
        picked.push(f.buf);
      }
      for (let i = 0; i < FPS * holdSec; i++) picked.push(frames[frames.length - 1].buf);

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

    // —— 原有 6 段（保留文件名兼容 timeline）——

    // 1) stream —— 中文流式回答
    await reset();
    await recordClip('stream', async () => {
      await send('demo:stream');
      await waitIdle();
      await sleep(800);
    }, { holdSec: 1.0 });

    // 2) tools —— 工具卡片展开
    await reset();
    await recordClip('tools', async () => {
      await send('demo:tool');
      await page.waitForSelector('details.toolcard', { timeout: 15_000 });
      await page.locator('details.toolcard summary').first().click();
      await waitIdle();
      await sleep(900);
    }, { holdSec: 1.0 });

    // 3) approval —— 定格待审批（HERO）
    await reset();
    await recordClip('approval', async () => {
      await send('demo:permission');
      await page.waitForSelector('#permModal:not(.hidden)', { timeout: 8_000 });
      await sleep(2200);
    }, { holdSec: 1.2 });

    // 4) question —— 定格选择题
    await reset();
    await recordClip('question', async () => {
      await send('demo:question');
      await page.waitForSelector('#questionModal:not(.hidden)', { timeout: 8_000 });
      await sleep(2200);
    }, { holdSec: 1.2 });

    // 5) tabs —— 会话抽屉 / 多工作区
    await reset();
    await recordClip('tabs', async () => {
      await send('demo:tab');
      await waitIdle();
      await page.click('#btnSessions');
      await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
      await sleep(1600);
    }, { holdSec: 1.0 });

    // 6) statusline —— 状态行展开
    await reset();
    await recordClip('statusline', async () => {
      await send('demo:statusline');
      await waitIdle();
      await page.locator('#cliStatusWrap summary').click().catch(() => {});
      await sleep(1400);
    }, { holdSec: 1.0 });

    // —— 加长 / 动作版（朋友圈完整版用）——

    // 7) stream_long —— 更长流式（test 场景，画面时间更久）
    await reset();
    await recordClip('stream_long', async () => {
      await send('test:stream-long');
      await waitIdle(40_000);
      await sleep(600);
    }, { holdSec: 0.8 });

    // 8) approval_tap —— 审批出现后点允许
    await reset();
    await recordClip('approval_tap', async () => {
      await send('demo:permission');
      await page.waitForSelector('#permModal:not(.hidden)', { timeout: 8_000 });
      await sleep(900);
      // 常见 id：#permAllow / [data-testid=perm-allow] / 文案「允许」
      const allow = page.locator('#permAllow, [data-testid="perm-allow"], #permModal button:has-text("允许")').first();
      if (await allow.count()) {
        await allow.click();
        await sleep(1200);
      } else {
        await sleep(1500);
      }
      await waitIdle(15_000).catch(() => {});
      await sleep(600);
    }, { holdSec: 1.0 });

    // 9) question_tap —— 选择题点选一项
    await reset();
    await recordClip('question_tap', async () => {
      await send('demo:question');
      await page.waitForSelector('#questionModal:not(.hidden)', { timeout: 8_000 });
      await sleep(800);
      const opt = page.locator('#questionModal button, #questionModal [role="button"], #questionModal label').first();
      if (await opt.count()) {
        await opt.click();
        await sleep(1000);
      } else {
        await sleep(1500);
      }
      await waitIdle(15_000).catch(() => {});
      await sleep(500);
    }, { holdSec: 1.0 });

    // 10) tools_scroll —— 工具过程多停一会
    await reset();
    await recordClip('tools_scroll', async () => {
      await send('demo:tool');
      await page.waitForSelector('details.toolcard', { timeout: 15_000 });
      const cards = page.locator('details.toolcard summary');
      const n = await cards.count();
      for (let i = 0; i < Math.min(n, 3); i++) {
        await cards.nth(i).click().catch(() => {});
        await sleep(700);
      }
      await waitIdle();
      await sleep(800);
    }, { holdSec: 1.0 });

    // 11) tabs_dwell —— 抽屉停留更久
    await reset();
    await recordClip('tabs_dwell', async () => {
      await send('demo:tab');
      await waitIdle();
      await page.click('#btnSessions');
      await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
      await sleep(2200);
      // 再关开一次增加动态
      await page.click('#btnSessions').catch(() => {});
      await sleep(600);
      await page.click('#btnSessions').catch(() => {});
      await sleep(1000);
    }, { holdSec: 1.0 });

    // 12) queue —— 排队可见（若 mock 支持）
    await reset();
    await recordClip('queue', async () => {
      await send('test:queued-hold');
      await sleep(800);
      await send('please queue this while busy');
      await sleep(2000);
      await page.locator('.queued-indicator, [data-testid="queued-cancel"]').first().waitFor({ timeout: 8_000 }).catch(() => {});
      await sleep(1500);
    }, { holdSec: 1.0 });

    // 13) attach —— 附件预览相关 mock
    await reset();
    await recordClip('attach', async () => {
      await send('test:attach-preview');
      await waitIdle(20_000);
      await sleep(1200);
      // 尝试点缩略图
      await page.locator('[data-testid="attachment-thumb"], .attachment-thumb, img[alt*="attach"]').first().click({ timeout: 3_000 }).catch(() => {});
      await sleep(1000);
    }, { holdSec: 1.0 });

    // 14) subagent —— 子 agent 卡片
    await reset();
    await recordClip('subagent', async () => {
      await send('test:subagent');
      await page.waitForSelector('[data-testid="subagent-card"], details.subagent-card', { timeout: 15_000 }).catch(() => {});
      await waitIdle(25_000);
      await sleep(800);
    }, { holdSec: 1.0 });

    // 15) file_changes —— 文件变更汇总感
    await reset();
    await recordClip('file_changes', async () => {
      await send('test:file-changes');
      await waitIdle(20_000);
      await sleep(1000);
    }, { holdSec: 1.0 });

    // 16) composer —— 输入框/新会话空态动一下（斜杠感：输入 /）
    await reset();
    await recordClip('composer', async () => {
      await ensureComposer();
      await page.fill('#input', '/');
      await sleep(900);
      await page.fill('#input', '/help');
      await sleep(800);
      await page.fill('#input', '');
      await sleep(400);
      await page.fill('#input', '看一下登录页的布局');
      await sleep(1000);
    }, { holdSec: 0.8 });

    // —— 非聊天壳层 UI（朋友圈 v3：首页 / 抽屉 / 配置 / 日志 / 文件）——

    // 17) home —— 启动首页 / 最近工作区（不发消息）
    await reset();
    await recordClip('home', async () => {
      await page.click('#btnHome').catch(() => {});
      await sleep(1800);
      // 若有最近会话区域，轻滚一下
      await page.mouse.wheel(0, 200).catch(() => {});
      await sleep(1000);
      await page.mouse.wheel(0, -120).catch(() => {});
      await sleep(800);
    }, { holdSec: 1.2 });

    // 18) sessions —— 工作区/会话抽屉
    await reset();
    await recordClip('sessions', async () => {
      await page.click('#btnSessions');
      await page.waitForSelector('#leftSidebar:not(.-translate-x-full)', { timeout: 5_000 }).catch(() => {});
      await sleep(1200);
      await page.locator('#leftSidebar').evaluate(el => { el.scrollTop = 120; }).catch(() => {});
      await sleep(1000);
      await page.locator('#leftSidebar').evaluate(el => { el.scrollTop = 0; }).catch(() => {});
      await sleep(900);
    }, { holdSec: 1.0 });

    // 19) sessions_switch —— 抽屉内再动一动（多仓感）
    await reset();
    await recordClip('sessions_switch', async () => {
      await send('demo:tab');
      await waitIdle();
      await page.click('#btnSessions');
      await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
      await sleep(800);
      // 点列表里非当前的一行（若有）
      const rows = page.locator('#leftSidebar button, #leftSidebar [data-testid], #leftSidebar .session-row, #leftSidebar li');
      const n = await rows.count().catch(() => 0);
      if (n > 1) {
        await rows.nth(Math.min(1, n - 1)).click().catch(() => {});
        await sleep(1000);
      }
      await page.click('#btnSessions').catch(() => {});
      await sleep(500);
      await page.click('#btnSessions').catch(() => {});
      await sleep(1000);
    }, { holdSec: 1.0 });

    // 20) settings —— 配置面板
    await reset();
    await recordClip('settings', async () => {
      await ensureComposer();
      await page.click('#btnSettings');
      await page.waitForSelector('#settingsSheet:not(.translate-y-full), #settingsSheet.sheet-open', { timeout: 5_000 }).catch(() => {});
      // 多数实现用 translate-y-full 关闭；打开时 class 去掉
      await sleep(800);
      await page.locator('#settingsSheetBody, #settingsSheet').evaluate(el => { el.scrollTop = 180; }).catch(() => {});
      await sleep(1200);
      await page.locator('#settingsSheetBody, #settingsSheet').evaluate(el => { el.scrollTop = 360; }).catch(() => {});
      await sleep(1200);
      await page.locator('#settingsSheetBody, #settingsSheet').evaluate(el => { el.scrollTop = 0; }).catch(() => {});
      await sleep(800);
    }, { holdSec: 1.0 });

    // 21) console —— 会话日志（先有一点输出再开）
    await reset();
    await recordClip('console', async () => {
      await send('demo:stream');
      await sleep(1500);
      await page.click('#btnConsole');
      await page.waitForSelector('#consoleModal:not(.hidden), #consoleLogArea', { timeout: 5_000 }).catch(() => {});
      await sleep(2000);
      await page.locator('#consoleLogArea').evaluate(el => { el.scrollTop = el.scrollHeight; }).catch(() => {});
      await sleep(1000);
    }, { holdSec: 1.0 });

    // 22) files —— 顶部 pill 打开工作区文件浏览
    await reset();
    await recordClip('files', async () => {
      await ensureComposer();
      // 进入会话上下文后 topContextPill 才显
      await send('demo:stream');
      await waitIdle(15_000).catch(() => {});
      await sleep(400);
      const pill = page.locator('#topContextPill');
      if (await pill.count() && await pill.isVisible().catch(() => false)) {
        await pill.click();
      } else {
        // 兜底：任意「浏览项目文件」入口
        await page.getByTitle(/浏览项目文件|文件/).first().click({ timeout: 3_000 }).catch(() => {});
      }
      await page.waitForSelector('#fileBrowseModal:not(.hidden), #fileBrowseBody', { timeout: 6_000 }).catch(() => {});
      await sleep(1800);
      await page.locator('#fileBrowseBody').evaluate(el => { el.scrollTop = 100; }).catch(() => {});
      await sleep(1000);
    }, { holdSec: 1.2 });

    // 23) files_nav —— 文件列表点一层（若有目录行）
    await reset();
    await recordClip('files_nav', async () => {
      await ensureComposer();
      await send('demo:stream');
      await waitIdle(15_000).catch(() => {});
      const pill = page.locator('#topContextPill');
      if (await pill.isVisible().catch(() => false)) await pill.click();
      else await page.getByTitle(/浏览项目文件|文件/).first().click({ timeout: 3_000 }).catch(() => {});
      await page.waitForSelector('#fileBrowseBody', { timeout: 6_000 }).catch(() => {});
      await sleep(800);
      const row = page.locator('#fileBrowseBody button, #fileBrowseBody [role="button"], #fileBrowseBody .file-row, #fileBrowseBody li').first();
      if (await row.count()) {
        await row.click().catch(() => {});
        await sleep(1200);
        await page.click('#fileBrowseBack').catch(() => {});
        await sleep(800);
      } else {
        await sleep(1500);
      }
    }, { holdSec: 1.0 });

    writeFileSync(join(OUT_DIR, 'clips.json'), JSON.stringify(clipsMeta, null, 2));
    console.log(`✅ ${clipsMeta.length} 段 clip 已写入 ${OUT_DIR}`);
  } finally {
    await browser.close();
    cleanup();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
