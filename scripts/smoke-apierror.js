// scripts/smoke-apierror.js —— API 错误透传回归守卫（error 事件 / CLAUDE.md map() 错误分支）
//
// 守卫的不变量：上游报错时，error 事件应**透传上游原文**（SDK 已加 "API Error:" 前缀的
// assistant.message.content），而非 SDK 的归类枚举桶（unknown/rate_limit/…）。
// 2026-06-12 机主报修"不应显示 unknown"，agent.js 据此从 msg.error 改读 message.content；
// 本脚本挡住"修回成显示枚举"的回归。
//
// 自包含、确定性、**零真实 token**：脚本自起一个进程内 mock 上游（对任意请求回 400 + 特征错误体），
// 把 server 的 ANTHROPIC_BASE_URL 指过去——本机 claude 的 API 调用全被 mock 拦截，不触达真实网关，
// 不消耗 token。故它比其他 e2e 都便宜，适合进常规回归集。
//
// 用法：  node scripts/smoke-apierror.js
//   （无需预先起 server、无需 token、无需网关；会临时借用真实 data/ 并在结束时原样还原）
import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { existsSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const APP_PORT = 3217;                       // 高位端口，避开默认 3000 / 冒烟 3100
const MARKER = 'CCM_APIERR_MARKER_上游报文';  // 特征串：出现在 error 事件里 = 上游原文已透传
const ENUMS = ['unknown', 'rate_limit', 'invalid_request', 'server_error', 'authentication_failed', 'billing_error'];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 进程内 mock 上游：对任意路径回 400 + Anthropic 风格错误体（含特征串）。一个 400（不可重试）= 一次命中。
let mockHits = 0;
const mock = http.createServer((req, res) => {
  let buf = ''; req.on('data', c => (buf += c));
  req.on('end', () => {
    mockHits++;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: MARKER } }));
  });
});

// 借用真实 data/ 前先把会话指针与 init 缓存挪开（路径硬编码 join(HERE,'data',...)，不可配），结束原样还原。
const STATE = ['sessions.json', 'init-cache.json'].map(f => {
  const p = join(ROOT, 'data', f);
  const bak = p + '.apierrbak';
  return { p, bak };
});
function stashState() {
  for (const { p, bak } of STATE) if (existsSync(p)) renameSync(p, bak);
}
function restoreState() {
  for (const { p, bak } of STATE) {
    if (existsSync(p)) rmSync(p, { force: true });      // 删测试产生的痕迹
    if (existsSync(bak)) renameSync(bak, p);            // 还原原件
  }
}

let server = null, serverLog = '', workDir = null, cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  try { if (server && !server.killed) server.kill('SIGTERM'); } catch {}
  try { mock.close(); } catch {}
  try { if (workDir) rmSync(workDir, { recursive: true, force: true }); } catch {}
  restoreState();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

function waitHealth(ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${APP_PORT}/health`, r => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
    };
    const retry = () => {
      if (server && server.exitCode !== null) return reject(new Error(`server 提前退出（code ${server.exitCode}）：\n${serverLog.slice(-600)}`));
      if (Date.now() > deadline) return reject(new Error(`server 健康检查超时\n${serverLog.slice(-600)}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function run() {
  // mock 监听随机端口（彻底免端口冲突），把端口塞进 server 的 ANTHROPIC_BASE_URL
  await new Promise(res => mock.listen(0, '127.0.0.1', res));
  const mockPort = mock.address().port;

  stashState();
  workDir = mkdtempSync(join(tmpdir(), 'ccm-apierr-'));

  // 干净子进程 env：剥掉继承的所有 ANTHROPIC_*（防机主真实网关泄入），只留指向 mock 的两项。
  // ANTHROPIC_BASE_URL/AUTH_TOKEN 在 dotenv 前已存在 → server 视为 shell 注入并保留（见 server.js 规整块）。
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_')) delete env[k];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
    ANTHROPIC_AUTH_TOKEN: 'mock-token',
    AUTH_TOKEN: '',                 // 空 → 规整剥除 → 无鉴权、仅 127.0.0.1
    PORT: String(APP_PORT),
    WORK_DIR: workDir,
    STATUS_LINE_CMD: 'off',         // 关 E16，去掉无关副作用（影子 HOME / 脚本执行）
  });
  server = spawn(process.execPath, [join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => (serverLog += d));
  server.stderr.on('data', d => (serverLog += d));

  await waitHealth(15000);
  console.log(`server 就绪 :${APP_PORT}，mock 上游 :${mockPort}\n`);

  const socket = io(`http://127.0.0.1:${APP_PORT}`, { auth: { token: '' }, reconnection: false, timeout: 5000 });
  const events = [];
  socket.on('agent:event', ev => {
    events.push(ev);
    if (!['text_delta', 'thinking_delta'].includes(ev.type)) console.log(`  [${ev.type}] ${JSON.stringify(ev.payload).slice(0, 120)}`);
  });

  await new Promise((res, rej) => {
    socket.on('connect', res);
    socket.on('connect_error', e => rej(new Error(`连接失败：${e.message}`)));
  });
  socket.emit('user:message', { text: '你好' });

  // 等 error 事件（mock 400 不可重试 → 应很快到达）
  const err = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待 error 事件超时（30s）')), 30000);
    const iv = setInterval(() => {
      const hit = events.find(e => e.type === 'error');
      if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit); }
    }, 100);
  });

  const msg = String(err.payload?.message ?? '');
  const isBareEnum = ENUMS.includes(msg.trim()) || /^API 错误：/.test(msg.trim());
  check('mock 上游确被命中（API 调用未触达真实网关）', mockHits > 0, `命中 ${mockHits} 次`);
  check('error 事件透传上游原文（含特征串）', msg.includes(MARKER), JSON.stringify(msg).slice(0, 120));
  check('未回退成 SDK 归类枚举桶（不显示 unknown 等）', !isBareEnum);
  check('error.recoverable === true（会话可继续）', err.payload?.recoverable === true);
  const result = events.find(e => e.type === 'result');
  check('错误轮以 result.isError 收尾（实例未被打死）', !!result && result.payload?.isError === true);

  socket.close();
}

run()
  .catch(e => check('执行异常', false, e.message))
  .finally(async () => {
    cleanup();
    await sleep(200); // 给 server SIGTERM 收尾留点时间
    const passed = results.filter(r => r.ok).length;
    console.log(`\n=== smoke-apierror 结果：${passed}/${results.length} 通过 ===`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });
