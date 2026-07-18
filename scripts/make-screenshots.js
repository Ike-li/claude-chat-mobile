// make-screenshots.js —— 用视觉 mock UI 重新拍摄 docs/screenshots/ 下的 9 张宣传截图。
// 零外部二进制依赖：Playwright Chromium。en 版走 tests/e2e/mock/scenarios/content.js 的
// test:* 英文场景，zh 版走 scenarios/demo.js 的 demo:* 中文场景（与历史素材的语言分工一致）。
// 用法：node scripts/make-screenshots.js   产物：docs/screenshots/*.png（可用
//       CCM_SCREENSHOT_OUT_DIR 覆盖输出目录，先落临时目录审查再正式覆盖）
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const OUT_DIR = process.env.CCM_SCREENSHOT_OUT_DIR || join(ROOT, 'docs', 'screenshots');
const PORT = process.env.CCM_SHOT_PORT || '3198';
const BASE = `http://127.0.0.1:${PORT}`;
const ANOTHER_WORKSPACE = '/Users/you/code/another-react-project';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
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
      deviceScaleFactor: 2, // 原图 375x812@1x 与页面 width=750/height=1624 声明不符、被放大模糊；改 2x 天然匹配
    });

    const reset = async () => {
      await page.request.post(`${BASE}/__reset`);
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('#btnNew');
      await page.waitForSelector('#btnSessions');
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
    const workspaceRow = (cwd) => page.locator(`#sessionPanel div[data-dir="${cwd}"]`);
    const expandWorkspace = async (cwd) => {
      const row = workspaceRow(cwd);
      const subtree = row.locator('xpath=following-sibling::*[1]');
      const alreadyOpen = await subtree.evaluate(el => el.classList.contains('expanded')).catch(() => false);
      if (!alreadyOpen) await row.locator('button').first().click();
    };
    const openSessionByTitle = async (title) => {
      await page.locator(`button[title="${title}"]`).click();
    };
    const shot = async (name) => {
      await sleep(250); // 动画收尾
      await page.screenshot({ path: join(OUT_DIR, name) });
      console.log('📸', name);
    };

    // 01-stream：流式输出 + Markdown 渲染
    await reset();
    await send('test:stream');
    await waitIdle();
    await shot('01-stream-en.png');

    await reset();
    await send('demo:stream');
    await waitIdle();
    await shot('01-stream-zh.png');

    // 02-tools：工具调用卡片（展开一张）
    await reset();
    await send('test:tool');
    await page.waitForSelector('details.toolcard', { timeout: 15_000 });
    await waitIdle();
    await page.locator('details.toolcard summary').first().click();
    await shot('02-tools-en.png');

    await reset();
    await send('demo:tool');
    await page.waitForSelector('details.toolcard', { timeout: 15_000 });
    await waitIdle();
    await page.locator('details.toolcard summary').first().click();
    await shot('02-tools-zh.png');

    // 03-approval（hero）：危险操作回手机审批，卡片收起、弹窗未处理
    await reset();
    await send('test:tool');
    await waitIdle();
    await send('test:permission');
    await page.waitForSelector('#permModal:not(.hidden)', { timeout: 8_000 });
    await shot('03-approval-en.png');

    await reset();
    await send('demo:tool');
    await waitIdle();
    await send('demo:permission');
    await page.waitForSelector('#permModal:not(.hidden)', { timeout: 8_000 });
    await shot('03-approval-zh.png');

    // 04-workspace：多工作区会话切换抽屉（两个工作区都展开，显示各自会话）
    await reset();
    await send('test:tab');
    await waitIdle();
    await page.click('#btnSessions');
    await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
    await expandWorkspace(ANOTHER_WORKSPACE);
    await shot('04-workspace-en.png');

    // 05-settings：配置面板（模型/权限/思考强度）
    await reset();
    await ensureComposer();
    await page.click('#btnSettings');
    await page.waitForSelector('#settingsSheet:not(.translate-y-full)');
    await shot('05-settings-en.png');

    // 06-console：交互日志，且验证跨会话 trace 隔离（切到第二个工作区会话再开）
    await reset();
    await send('test:tab');
    await waitIdle();
    await page.click('#btnSessions');
    await expandWorkspace(ANOTHER_WORKSPACE);
    await openSessionByTitle('Another App Concurrency');
    await page.waitForSelector('#leftSidebar.-translate-x-full');
    await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 10_000 });
    await page.click('#btnConsole');
    await page.waitForSelector('#consoleModal', { state: 'visible' });
    await shot('06-console-en.png');

    console.log(`✅ 9 张截图已写入 ${OUT_DIR}`);
  } finally {
    await browser.close();
    cleanup();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e); process.exit(1); });
