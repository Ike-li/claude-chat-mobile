// tests/integration/rate-limit.test.mjs —— 鉴权门口防暴破限速接线集成测试（承接 NFR-03）
// 纯函数状态机的单测见 tests/unit/rate-limiter.test.mjs；本文件只验握手中间件的【接线】：
//   ①正确 token 不被限速误伤；②退避短锁期内报 cooldown + 毫秒数（令牌没校验，带正确令牌也一样）；
//   ③真令牌错误不带重试提示。
// 独立文件 = 独立进程 = 独立 server 单例，不与 auth-token.test.mjs 的失败计数耦合。
//
// 【为什么这里不覆盖「达阈值长锁 → rate_limited + retryAfter」】制造它需要 8 次【真】失败，
// 而每两次之间必须等过退避（锁内尝试不计数）：500+1000+2000+4000+8000+16000+30000 = 61.5 秒。
// 一条一分钟的集成用例不值得，且它验的是状态机而非接线。那条契约由单测用注入时钟覆盖：
// rate-limiter.test.mjs 的 authRejection/gateCheck 组，与 server-http.test.mjs 的
// 「连续失败锁定 → 429」（rateLimit.now 可注入，直接快进到阈值）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { reserveFreePort, waitForServerReady } from './_spawn-server.mjs';

let port, dataDir, httpServer, io;

async function startServer(authToken = 'secret-token') {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-ratelimit-test-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(await reserveFreePort());
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = authToken;

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await waitForServerReady(port, authToken);
}

// 返回 { message, data }：data 是 socket.io 把服务端 err.data 原样送来的负载，
// 它是 socket 侧对应 HTTP `Retry-After` 头的唯一通道（握手失败没有 HTTP 响应头可用）。
function connectExpectError(token, timeout = 5000) {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('期望连接错误但未收到')); }, timeout);
    socket.once('connect_error', (err) => {
      clearTimeout(timer); socket.disconnect();
      resolve({ message: err.message, data: err.data ?? null });
    });
    socket.once('connect', () => { clearTimeout(timer); socket.disconnect(); reject(new Error('不应连接成功')); });
  });
}

function connectExpectOk(token, timeout = 5000) {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token }, transports: ['websocket'], reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('连接超时')); }, timeout);
    socket.once('connect', () => { clearTimeout(timer); socket.disconnect(); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`不应被拒：${err.message}`)); });
  });
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe('鉴权限速接线集成测试', () => {
  test.before(async () => { await startServer('secret-token'); });
  test.after(async () => { await cleanup(); });

  // 正确 token 的正常握手不被限速误伤（成功清零，为下一测试留干净状态）
  test('正确 token 正常握手成功（限速不误伤）', async () => {
    await connectExpectOk('secret-token');
  });

  // 退避短锁期内被拦下的那些尝试，令牌根本没校验，对客户端说 cooldown + 毫秒数。
  //
  // 这里的契约改过两次。最早断言「出现 rate_limited」：只输错一次令牌，紧接着的第二次握手（浏览器侧由 pageshow 的
  // 200ms 重连发出）撞进 500ms 退避锁，屏幕上就是「登录尝试过多，请 1 秒后再试」（2026-09-02 本机实测）。于是改成
  // 「仍报 unauthorized」，可那又把没校验的令牌说成了错的：输错一次后马上输对，正确令牌也被告知「令牌不对」，客户端
  // 分不出是令牌失效还是被退避（验收 O83，E2 实测窗口 524–544ms）。所以单独一档，前端据此到点自动重试。
  test('退避短锁期内报 cooldown + 毫秒数，不是 unauthorized 也不是 rate_limited', async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await connectExpectError('wrong-token'));
    }
    // 第 1 次是真做了 token 校验并失败（backoff）；第 2、3 次是撞进退避锁没校验（cooldown）。
    assert.deepEqual(results.map(r => r.message), ['unauthorized', 'cooldown', 'cooldown'],
      `实际：${JSON.stringify(results.map(r => r.message))}`);
    assert.equal(results[0].data?.retryAfterMs, undefined, '真校验失败的那一次不该带 retryAfterMs——它的问题是令牌不对');
    for (const r of results.slice(1)) {
      assert.equal(r.data?.reason, 'cooldown');
      assert.ok(r.data?.retryAfterMs > 0 && r.data.retryAfterMs <= 500, `冷却毫秒数应落在首次退避内，实际 ${r.data?.retryAfterMs}`);
      assert.equal(r.data?.retryAfterSeconds, 1);
    }
  });

  test('冷却期内带正确令牌也是 cooldown（没校验），到点再连就进去', async () => {
    await new Promise(r => setTimeout(r, 1200));         // 等过上一条留下的短锁
    const bad = await connectExpectError('wrong-again');
    assert.equal(bad.message, 'unauthorized');
    const early = await connectExpectError('secret-token');
    assert.equal(early.message, 'cooldown', '冷却期内的正确令牌不能被说成「令牌不对」');
    await new Promise(r => setTimeout(r, early.data.retryAfterMs + 50));
    await connectExpectOk('secret-token');
  });

  // 反向：单纯的令牌错误不该带重试提示，否则等于暗示「等等就能进」，而它真正的问题是令牌不对。
  test('unauthorized 不带重试提示（不误导成「等一会儿就能进」）', async () => {
    // 上一条以成功收尾，计数已清零：这一次真的走到 token 校验而不是被门拦下
    const first = await connectExpectError('another-wrong-token');
    assert.match(first.message, /unauthorized/, `应为 unauthorized，实际：${first.message}`);
    assert.equal(first.data?.retryAfterMs, undefined, 'unauthorized 不该带 retryAfterMs');
  });
});
