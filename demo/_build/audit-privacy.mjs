/**
 * 发布前隐私审查：跑一遍真实操作，记录 demo 站的**全部**出站请求与本地存储写入。
 *
 * 静态 grep 只能证明「源码里没有敏感串」，证明不了「运行时不会把东西发出去」。
 * 这份脚本回答的是后者：有没有非同源请求、存了什么、SW 装没装。
 *
 *   node demo/_build/audit-privacy.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, '..', '..');
const PORT = 14313;
const REPO = execFileSync('git', ['worktree', 'list'], { cwd: HERE, encoding: 'utf8' })
  .split('\n')[0].split(/\s+/)[0];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
// 同 verify.mjs：项目站的根是 /<repo>/，挂在 / 上会让漏网的绝对路径假绿。
const BASE = '/claude-chat-mobile';
const srv = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url !== BASE && !url.startsWith(BASE + '/')) { res.writeHead(404); res.end(); return; }
  let rel = url.slice(BASE.length) || '/';
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(SITE_ROOT, rel);
  if (!f.startsWith(SITE_ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(await readFile(f));
});
await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

const { chromium } = await import(path.join(REPO, 'node_modules', 'playwright', 'index.mjs'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

const ORIGIN = `http://127.0.0.1:${PORT}${BASE}`;
const reqs = [];
page.on('request', r => reqs.push({ method: r.method(), url: r.url(), type: r.resourceType(), post: r.postData() }));

await page.goto(`${ORIGIN}/demo/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('#demoIntroGo').click().catch(() => {});

// 走一遍会碰到数据的路径：发言（含一段假敏感文本）、开设置、浏览文件
await page.locator('#input').fill('这是一段用户输入 SECRET-CANARY-7391 用来验证不会外发');
await page.locator('#btnSend').click();
await page.waitForTimeout(3500);
await page.locator('#btnSessions').click().catch(() => {});
await page.waitForTimeout(700);
await page.locator('#btnGeneralSettings').click().catch(() => {});
await page.waitForTimeout(1500);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.locator('#topContextPill').click().catch(() => {});
await page.waitForTimeout(600);
await page.locator('#workspaceTabFiles').click().catch(() => {});
await page.waitForTimeout(1200);

// ---- 1. 出站请求：非同源的一律要人工过目
const external = reqs.filter(r => !r.url.startsWith(ORIGIN));
console.log(`\n=== 出站请求总数 ${reqs.length}，非同源 ${external.length} ===`);
for (const r of external) console.log(`  ! ${r.method} ${r.url}`);
if (!external.length) console.log('  ✓ 全部同源，零第三方请求');

// ---- 2. 带 body 的请求：有没有把用户输入 POST 出去
const withBody = reqs.filter(r => r.post);
console.log(`\n=== 带 body 的请求 ${withBody.length} ===`);
for (const r of withBody) console.log(`  ! ${r.method} ${r.url} :: ${String(r.post).slice(0, 160)}`);
if (!withBody.length) console.log('  ✓ 没有任何请求携带 body');

// ---- 3. canary 有没有出现在任何请求里
const leaked = reqs.filter(r => (r.url + (r.post || '')).includes('SECRET-CANARY-7391'));
console.log(`\n=== canary 泄漏检查 ===`);
console.log(leaked.length ? `  ! 用户输入出现在 ${leaked.length} 个请求里` : '  ✓ 用户输入没有出现在任何请求中');

// ---- 4. 本地存储
const storage = await page.evaluate(() => ({
  local: Object.fromEntries(Object.entries(localStorage).map(([k, v]) => [k, String(v).slice(0, 120)])),
  session: Object.fromEntries(Object.entries(sessionStorage).map(([k, v]) => [k, String(v).slice(0, 120)])),
  cookies: document.cookie,
  sw: navigator.serviceWorker ? 'API 可用' : 'API 不可用',
}));
console.log('\n=== localStorage ===');
for (const [k, v] of Object.entries(storage.local)) console.log(`  ${k} = ${v}`);
if (!Object.keys(storage.local).length) console.log('  (空)');
console.log('=== sessionStorage ===');
for (const [k, v] of Object.entries(storage.session)) console.log(`  ${k} = ${v}`);
if (!Object.keys(storage.session).length) console.log('  (空)');
console.log(`=== cookie === ${storage.cookies || '(空)'}`);

const regs = await page.evaluate(async () => {
  if (!navigator.serviceWorker) return 'API 不可用';
  const rs = await navigator.serviceWorker.getRegistrations();
  return rs.length ? rs.map(r => r.scope).join(', ') : '未注册任何 SW';
});
console.log(`=== Service Worker === ${regs}`);

await browser.close();
srv.close();
