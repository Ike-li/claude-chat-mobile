// tests/integration/rate-limit.test.mjs —— 鉴权门口防暴破限速接线集成测试（承接 NFR-03 / docs/design.md）
// 纯函数状态机的单测见 tests/unit/rate-limiter.test.mjs；本文件验证握手中间件的接线：
//   ①正确 token 正常握手不被限速误伤；②失败后 backoff 短锁在时间窗内拦截后续尝试。
// 独立文件 = 独立进程 = 独立 server 单例，不与 auth-token.test.mjs 的失败计数耦合。
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

  // 失败后 backoff 短锁在时间窗内拦截后续尝试：串行连错 token，首次 unauthorized、随后应出现 rate_limited
  test('鉴权失败后 backoff 短锁拦截后续握手（出现 rate_limited）', async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await connectExpectError('wrong-token'));
    }
    const msgs = results.map(r => r.message);
    assert.match(msgs[0], /unauthorized/, `首次失败应为 unauthorized，实际：${msgs[0]}`);
    assert.ok(
      msgs.some(m => /rate_limited/.test(m)),
      `失败后应被限速短锁拦截（出现 rate_limited），实际全部：${JSON.stringify(msgs)}`,
    );
  });

  // socket 侧此前一个重试数字都不给：客户端只知道「连不上」，不知道要等多久，于是盲目重连——
  // 而每次重连都只是撞在刚上的锁上。HTTP 侧一直有 Retry-After 头，握手没有响应头可用，
  // socket.io 的 err.data 是唯一通道。
  test('被限速拒绝时带重试提示（对应 HTTP 的 Retry-After）', async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await connectExpectError('wrong-token'));
    }
    const limited = results.find(r => /rate_limited/.test(r.message));
    assert.ok(limited, `本用例前提是至少出现一次 rate_limited，实际：${JSON.stringify(results.map(r => r.message))}`);
    assert.ok(limited.data, 'rate_limited 必须带 data 负载');
    assert.equal(limited.data.reason, 'rate_limited');
    assert.ok(Number.isFinite(limited.data.retryAfterMs) && limited.data.retryAfterMs > 0,
      `retryAfterMs 应为正数，实际 ${limited.data.retryAfterMs}`);
    assert.ok(Number.isInteger(limited.data.retryAfterSeconds) && limited.data.retryAfterSeconds >= 1,
      'retryAfterSeconds 至少为 1——0 会被读成「立刻可重试」，与锁定的意思相反');
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
