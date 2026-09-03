// tests/integration/rate-limit.test.mjs —— 鉴权门口防暴破限速接线集成测试（承接 NFR-03）
// 纯函数状态机的单测见 tests/unit/rate-limiter.test.mjs；本文件只验握手中间件的【接线】：
//   ①正确 token 不被限速误伤；②退避短锁期内仍报 unauthorized；③真令牌错误不带重试提示。
// 独立文件 = 独立进程 = 独立 server 单例，不与 auth-token.test.mjs 的失败计数耦合。
//
// 【为什么这里不覆盖「达阈值长锁 → rate_limited + retryAfter」】制造它需要 8 次【真】失败，
// 而每两次之间必须等过退避（锁内尝试不计数）：500+1000+2000+4000+8000+16000+30000 = 61.5 秒。
// 一条一分钟的集成用例不值得，且它验的是状态机而非接线。那条契约由单测用注入时钟覆盖：
// rate-limiter.test.mjs 的 authRejection/gateCheck 组，与 server-http.test.mjs 的
// 「连续失败锁定 → 429」（rateLimit.now 可注入，直接快进到阈值）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { waitForServerReady } from './_spawn-server.mjs';

let port, dataDir, httpServer, io;

async function startServer(authToken = 'secret-token') {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-ratelimit-test-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = authToken;

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../src/auth/cf-access.js');
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

  // 退避短锁期内被拦下的那些尝试，对客户端【仍然是 unauthorized】。
  //
  // 这条用例此前断言的恰好相反（名字就叫「出现 rate_limited」），把一个真实缺陷当契约钉住了：
  // 用户只输错一次令牌，紧接着的第二次握手（浏览器侧由 pageshow 的 200ms 重连发出）撞进那把
  // 500ms 退避锁，屏幕上就是「登录尝试过多，请 1 秒后再试」——行动指引从「重输令牌」被错换成
  // 「等一下」，于是用户等一秒再点，又撞一次。2026-09-02 在机主本机 127.0.0.1 实测复现。
  // 判据收敛到 rate-limiter.js 的 gateCheck：未达阈值的退避锁 = cooldown（仍是令牌不对），
  // 只有 failCount 达 threshold 的长锁才配叫 rate_limited。
  test('退避短锁期内仍报 unauthorized（只错一次不是「尝试过多」）', async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await connectExpectError('wrong-token'));
    }
    const msgs = results.map(r => r.message);
    // 第 1 次是真做了 token 校验并失败（backoff）；第 2、3 次是撞进退避锁没校验（cooldown）。
    // 两者对客户端的含义相同：你的令牌不对。
    assert.deepEqual(msgs, ['unauthorized', 'unauthorized', 'unauthorized'],
      `退避期内不得升级成 rate_limited，实际：${JSON.stringify(msgs)}`);
    for (const [i, r] of results.entries()) {
      assert.equal(r.data?.retryAfterMs, undefined,
        `第 ${i + 1} 次不该带 retryAfterMs——给了就等于暗示「等等就能进」，而真正的问题是令牌不对`);
    }
  });

  // 反向：单纯的令牌错误不该带重试提示，否则等于暗示「等等就能进」，而它真正的问题是令牌不对。
  test('unauthorized 不带重试提示（不误导成「等一会儿就能进」）', async () => {
    // 先等过上一条留下的短锁，确保这一次真的走到 token 校验而不是被门拦下
    await new Promise(r => setTimeout(r, 1200));
    const first = await connectExpectError('another-wrong-token');
    assert.match(first.message, /unauthorized/, `应为 unauthorized，实际：${first.message}`);
    assert.equal(first.data?.retryAfterMs, undefined, 'unauthorized 不该带 retryAfterMs');
  });
});
