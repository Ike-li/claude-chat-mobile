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

const sleep = ms => new Promise(res => setTimeout(res, ms));
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
  await sleep(500);
}

function connectExpectError(token, timeout = 5000) {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('期望连接错误但未收到')); }, timeout);
    socket.once('connect_error', (err) => { clearTimeout(timer); socket.disconnect(); resolve(err.message); });
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

test.describe('鉴权限速接线集成测试', process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : {}, () => {
  test.before(async () => { await startServer('secret-token'); });
  test.after(async () => { await cleanup(); });

  // 正确 token 的正常握手不被限速误伤（成功清零，为下一测试留干净状态）
  test('正确 token 正常握手成功（限速不误伤）', async () => {
    await connectExpectOk('secret-token');
  });

  // 失败后 backoff 短锁在时间窗内拦截后续尝试：串行连错 token，首次 unauthorized、随后应出现 rate_limited
  test('鉴权失败后 backoff 短锁拦截后续握手（出现 rate_limited）', async () => {
    const msgs = [];
    for (let i = 0; i < 3; i++) {
      msgs.push(await connectExpectError('wrong-token'));
    }
    assert.match(msgs[0], /unauthorized/, `首次失败应为 unauthorized，实际：${msgs[0]}`);
    assert.ok(
      msgs.some(m => /rate_limited/.test(m)),
      `失败后应被限速短锁拦截（出现 rate_limited），实际全部：${JSON.stringify(msgs)}`,
    );
  });
});
