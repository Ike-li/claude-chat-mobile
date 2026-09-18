/**
 * demo 站验收：起一个静态 server，用真浏览器打开构建产物，断言它到达「可用」状态。
 *
 * 为什么是浏览器而不是单测：demo-socket.js 的正确性定义就是「能让真前端活起来」——
 * 它每个函数单独看都平凡，错只会错在与前端的接缝上（seq 去重、instanceId 过滤、ack 签名）。
 * 断言 DOM 状态才抓得到这些，单测 shim 的内部函数只会得到一份镜像实现的假绿。
 *
 * Playwright 从主仓 node_modules 借（gh-pages 是孤儿分支、没有 npm 工程）。
 *   node demo/_build/verify.mjs [--headed]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(HERE, '..');
// 站点根而非 demo/：验收要覆盖「从 landing 点进来」这条真实路径，顺带钉住相对路径重写。
const SITE_ROOT = path.resolve(DEMO_DIR, '..');
const PORT = 14311;

// gh-pages 是孤儿分支、没有 npm 工程，Playwright 得从主 worktree 借。
// `git worktree list` 的第一行永远是主 worktree，比按目录名推稳。
const REPO = execFileSync('git', ['worktree', 'list'], { cwd: DEMO_DIR, encoding: 'utf8' })
  .split('\n')[0].split(/\s+/)[0];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

// GitHub Pages 项目站的根是 /<repo>/，**不是**域名根。本地 server 必须照着来：
// 直接把 SITE_ROOT 挂在 / 上会让 /vendor/x 这类漏网的绝对路径命中 gh-pages 根下
// 的同名文件而返回 200，线上却打在组织站根上 404——2026-09-18 的衬线字体就是
// 这么漏过去的（本地全绿、线上两条 404）。加了前缀，本地才和线上等价。
const BASE = '/claude-chat-mobile';

function serve() {
  return new Promise(resolve => {
    const srv = createServer(async (req, res) => {
      let url = decodeURIComponent(req.url.split('?')[0]);
      if (url !== BASE && !url.startsWith(BASE + '/')) {
        res.writeHead(404); res.end('outside project site'); return;
      }
      let rel = url.slice(BASE.length) || '/';
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(SITE_ROOT, rel);
      if (!file.startsWith(SITE_ROOT) || !existsSync(file)) {
        res.writeHead(404); res.end('not found'); return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(500); res.end('err'); }
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

const { chromium } = await import(path.join(REPO, 'node_modules', 'playwright', 'index.mjs'));

const srv = await serve();
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

const errors = [];
const missing = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('response', r => { if (r.status() === 404) missing.push(r.url()); });

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (e) { results.push(['FAIL', name, e.message.split('\n')[0].slice(0, 120)]); }
};

// 先走 landing → demo 这条真实入口，顺带验证相对路径重写（绝对路径在项目站下会 404）。
await check('landing 有 demo 入口且点得进去', async () => {
  await page.goto(`http://127.0.0.1:${PORT}${BASE}/`, { waitUntil: 'domcontentloaded' });
  const link = page.locator('a[href="./demo/"]');
  if (!(await link.count())) throw new Error('landing 上没有 ./demo/ 链接');
  await link.first().click();
  await page.waitForURL(/\/demo\/$/, { timeout: 8000 });
});

await page.waitForTimeout(1500);

// 演示身份：卡片必须出现，否则访问者不知道自己在看脚本回复。
await check('首屏出现演示说明卡', async () => {
  if (!(await page.locator('#demoIntro').count())) throw new Error('#demoIntro 没出现');
  const txt = await page.locator('#demoIntroCard').innerText();
  if (!txt.includes('不会真的调用模型')) throw new Error('说明卡没讲清回复是脚本');
});
await page.screenshot({ path: path.join(HERE, 'verify-intro.png') });
await page.locator('#demoIntroGo').click();
await page.waitForTimeout(300);

await check('连接建立（令牌门不显示）', async () => {
  const gate = page.locator('#authGate');
  if (await gate.count() && !(await gate.first().getAttribute('class') || '').includes('hidden')) {
    throw new Error('authGate 仍然可见 —— 连接没建立');
  }
});

await check('首屏水合（statusline + 模型 pill）', async () => {
  const body = await page.locator('body').innerText();
  if (!body.includes('ctx 18k')) throw new Error('statusline 没渲染');
  if (!body.includes('claude-opus-5')) throw new Error('模型 pill 没渲染');
});

// 移动端 Enter 是换行不是发送（产品有意为之），所以点 #btnSend。
await check('发消息收到流式回复（含工具调用）', async () => {
  await page.locator('#input').fill('帮我看看项目结构');
  await page.locator('#btnSend').click();
  await page.waitForTimeout(5000);
  const body = await page.locator('body').innerText();
  if (!body.includes('后端按域分层')) throw new Error('没等到脚本回复文本');
  if (!body.includes('ls app/src')) throw new Error('工具调用没渲染');
});

await check('审批流：请求 → 批准 → 继续', async () => {
  await page.locator('#input').fill('帮我删掉 node_modules 重装一遍');
  await page.locator('#btnSend').click();
  await page.locator('#permModal').waitFor({ state: 'visible', timeout: 8000 });
  const modal = await page.locator('#permModal').innerText();
  if (!modal.includes('npm ci')) throw new Error('审批卡没显示待批准的命令');
  await page.locator('#permAllow').click();
  await page.waitForTimeout(4000);
  const body = await page.locator('body').innerText();
  if (!body.includes('依赖已重装完成')) throw new Error('批准后没继续播剩下的回合');
});

await check('会话抽屉有列表', async () => {
  await page.locator('#btnSessions').click();
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  if (!body.includes('E2E 分片')) throw new Error('会话列表没渲染');
});

await check('抽屉里四个工作区都在，会话各归各家', async () => {
  const panel = await page.locator('#sessionPanel').innerText();
  for (const p of ['claude-chat-mobile', 'api-gateway', 'personal-blog', 'data-pipeline']) {
    if (!panel.includes(p)) throw new Error('工作区缺失：' + p);
  }
  // 会话必须排在自己工作区下面：api-gateway 的那条不能跑到第一个工作区的段里
  const iApi = panel.indexOf('api-gateway');
  const iBlog = panel.indexOf('personal-blog');
  const iRate = panel.indexOf('IPv6 /64 分桶');
  if (!(iRate > iApi && iRate < iBlog)) throw new Error('会话没归到 api-gateway 段内');
});

// 「新会话开在点的那个工作区」——只改 sessionId 不切工作区的话，
// statusline 的分支会留在上一个项目上，这条就是那个 bug 的探针。
await check('在 api-gateway 行新建会话 → 视图跟着切过去', async () => {
  const plus = page.locator('#sessionPanel button').filter({ hasText: '＋' });
  if (await plus.count() < 2) throw new Error('抽屉里没有每个工作区的 ＋');
  await plus.nth(1).click();
  await page.waitForTimeout(1400);
  const body = await page.locator('body').innerText();
  if (!body.includes('feat/rate-limit')) throw new Error('statusline 没切到 api-gateway 的分支');
});

await check('新会话发言后落进该工作区的列表', async () => {
  await page.locator('#input').fill('限流的分桶键怎么选');
  await page.locator('#btnSend').click();
  await page.waitForTimeout(2500);
  await page.locator('#btnSessions').click();
  await page.waitForTimeout(1200);
  const panel = await page.locator('#sessionPanel').innerText();
  const iNew = panel.indexOf('限流的分桶键怎么选');
  if (iNew === -1) throw new Error('新会话没出现在抽屉里');
  const iApi = panel.indexOf('api-gateway');
  const iBlog = panel.indexOf('personal-blog');
  if (!(iNew > iApi && iNew < iBlog)) throw new Error('新会话没落在 api-gateway 段内');
});

await check('设置面板宿主机行有活数据（非"状态读取中"）', async () => {
  await page.locator('#btnGeneralSettings').click();
  await page.waitForTimeout(1400);
  const l1 = await page.locator('#generalSheetBody').innerText();
  if (l1.includes('状态读取中')) throw new Error('宿主机行仍是占位——service 没喂到');
  if (!/已运行/.test(l1)) throw new Error('缺运行时长');
  if (!/v1\.10\.0/.test(l1)) throw new Error('缺版本号');
  if (!/3 台已信任/.test(l1)) throw new Error('设备数没算出来');
  await page.screenshot({ path: path.join(HERE, 'verify-settings.png') });
});

// 关掉设置面板，回到主界面继续
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// 文件树按 cwd 取，所以这一条同时验证「切了工作区就浏览另一个项目」。
// 此刻视图停在 api-gateway（上面新建会话切过去的），列出来的该是它的树。
await check('文件浏览：列目录 → 下钻 → 读文件', async () => {
  await page.locator('#topContextPill').click();
  await page.waitForTimeout(900);
  await page.locator('#workspaceTabFiles').click();
  await page.waitForTimeout(1200);
  const root = await page.locator('#fileBrowseBody').innerText();
  if (!root.includes('src')) throw new Error('根目录没列出来：' + root.slice(0, 80));
  if (!root.includes('openapi')) throw new Error('列的不是 api-gateway 的树：' + root.slice(0, 80));

  await page.locator('#fileBrowseBody').getByText('openapi', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  const sub = await page.locator('#fileBrowseBody').innerText();
  if (!sub.includes('users.yaml')) throw new Error('下钻没进去：' + sub.slice(0, 80));

  await page.locator('#fileBrowseBody').getByText('users.yaml', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  const content = await page.locator('#fileBrowseBody').innerText();
  if (!content.includes('openapi')) throw new Error('文件内容没读出来：' + content.slice(0, 80));
  await page.screenshot({ path: path.join(HERE, 'verify-files.png') });
});

// 文件浏览是全屏面板、Escape 关不掉，直接重载回干净状态（shim 状态跟着重置到首个工作区）。
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.locator('#demoIntroGo').click().catch(() => {}); // sessionStorage 已记住，通常不再出现

await check('后台任务：进度横幅 → 完成后续播', async () => {
  await page.locator('#input').fill('后台跑一遍全量回归');
  await page.locator('#btnSend').click();
  await page.locator('#taskProgressBanner').waitFor({ state: 'visible', timeout: 10000 });
  const banner = await page.locator('#taskProgressBanner').innerText();
  if (!/lint|单测|集成|覆盖率/.test(banner)) throw new Error('横幅没显示进度：' + banner.slice(0, 80));
  await page.screenshot({ path: path.join(HERE, 'verify-task.png') });
  // 4 步 × 1.1s + 收尾，给足时间等完成通知与后续文本
  await page.waitForTimeout(9000);
  const body = await page.locator('body').innerText();
  if (!body.includes('三档全绿')) throw new Error('任务完成后没继续播剩下的回合');
});

await page.screenshot({ path: path.join(HERE, 'verify-shot.png'), fullPage: false });

// 说明卡的双语与深色模式：都靠 CSS 变量/ccm_lang 跟随产品，没实测过就只是「应该没问题」。
// 思考档位漏一档在界面上看不出异常——那一格只是不存在。逐档钉住。
// 放在最后并先 reload：前面那串面板开关会留下状态，这条要的是干净的初始视图。
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.locator('#demoIntroGo').click().catch(() => {});
await page.waitForTimeout(500);

await check('思考强度档位齐全（含 max 与 ultracode）', async () => {
  await page.locator('#pillDefaults').click();
  await page.waitForTimeout(1200);
  const sheet = await page.locator('#settingsSheetBody').innerText();
  for (const lv of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
    if (!new RegExp('(^|\\s)' + lv + '(\\s|$)', 'm').test(sheet)) throw new Error('缺档位：' + lv);
  }
  if (!sheet.includes('最深入更慢更贵')) throw new Error('max 的副文案没渲染');
  await page.screenshot({ path: path.join(HERE, 'verify-effort.png') });
});

await check('英文偏好下说明卡是英文', async () => {
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => {
    localStorage.setItem('ccm_lang', 'en');
    sessionStorage.removeItem('ccm_demo_intro_seen');
  });
  await p2.goto(`http://127.0.0.1:${PORT}${BASE}/demo/`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1200);
  const txt = await p2.locator('#demoIntroCard').innerText();
  if (!txt.includes('no model is ever called')) throw new Error('英文文案没生效：' + txt.slice(0, 60));
  await p2.close();
});

await check('深色模式下说明卡跟随主题', async () => {
  const p3 = await ctx.newPage();
  await p3.emulateMedia({ colorScheme: 'dark' });
  await p3.addInitScript(() => sessionStorage.removeItem('ccm_demo_intro_seen'));
  await p3.goto(`http://127.0.0.1:${PORT}${BASE}/demo/`, { waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(1200);
  const bg = await p3.locator('#demoIntroCard').evaluate(el => getComputedStyle(el).backgroundColor);
  const m = bg.match(/\d+/g);
  if (!m || Number(m[0]) > 120) throw new Error('深色模式下卡片仍是亮底：' + bg);
  await p3.screenshot({ path: path.join(HERE, 'verify-dark.png') });
  await p3.close();
});

// 【为什么要有这一条】漏网的绝对路径不会让任何功能断言变红——字体加载失败只是回落到
// 系统字体，其余 16 条照样全绿。2026-09-18 css 里的 url(/vendor/…) 就是这么活到线上的：
// 本地 server 当时挂在域名根上，而 gh-pages 根恰好有同名字体，连 404 都不报。
// 现在 server 带了 /claude-chat-mobile 前缀（与线上等价），再把「零 404」钉成断言，
// 这类问题才会在本地就红。必须排在所有操作之后——missing 是全程累积的。
await check('全程零 404（漏网的绝对路径在这里现形）', async () => {
  if (missing.length) {
    const uniq = [...new Set(missing)];
    throw new Error(`${uniq.length} 个资源 404：${uniq.slice(0, 3).join('  ')}`);
  }
});

console.log('\n=== 验收结果 ===');
for (const [s, n, d] of results) console.log(`${s === 'PASS' ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
console.log(`\n=== console 错误 (${errors.length}) ===`);
for (const e of errors.slice(0, 25)) console.log('  ! ' + e.slice(0, 200));
console.log(`\n=== 404 资源 (${missing.length}) ===`);
for (const u of missing.slice(0, 15)) console.log('  ? ' + u);

await browser.close();
srv.close();
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
