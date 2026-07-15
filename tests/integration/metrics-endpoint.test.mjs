// tests/integration/metrics-endpoint.test.mjs —— /metrics 端点集成测试（docs/design.md，承接 NFR-15）
// 验证：①鉴权保护（"不开无鉴权数据端点"）；②返回结构（指标最小集 + 状态分类）；③StateProbe 分类
// 随连接状态变化。零 token 成本（不起真 claude turn），走"可靠集成"档。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
const TOKEN = 'metrics-test-token';
let port, dataDir, httpServer, io;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-metrics-test-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = TOKEN;

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await sleep(500);
}

async function get(path, token) {
  const headers = token ? { 'x-auth-token': token } : {};
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe('/metrics 端点（NFR-15）', process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : {}, () => {
  test.before(async () => { await startServer(); });
  test.after(async () => { await cleanup(); });

  test('鉴权保护：无 token → 401，不泄露运行数据', async () => {
    const { status } = await get('/metrics');
    assert.equal(status, 401);
  });

  test('带正确 token → 200 + 指标最小集结构完整', async () => {
    const { status, body } = await get('/metrics', TOKEN);
    assert.equal(status, 200);
    // 指标最小集 5 项（docs/design.md）
    for (const k of ['activeSessions', 'events', 'catchUpHits', 'catchUpReloads', 'rateLimitLockouts', 'pushSuccess', 'pushFailure']) {
      assert.equal(typeof body.metrics[k], 'number', `metrics.${k} 应为数字`);
    }
    // 状态分类（StateProbe）
    assert.ok('state' in body); // null 或四类之一
    for (const k of ['failed', 'awaiting', 'notifyFailed', 'mobileClients']) {
      assert.equal(typeof body.states[k], 'number', `states.${k} 应为数字`);
    }
    assert.equal(typeof body.timestamp, 'number');
  });

  test('无移动端连接时 state=mobile_offline（后端产出的四类之一）', async () => {
    // before 里 startServer 后无客户端连接 → approved room 空 → mobileClients=0
    const { body } = await get('/metrics', TOKEN);
    assert.equal(body.states.mobileClients, 0);
    assert.equal(body.state, 'mobile_offline');
  });

  test('有已批准移动端连接后 state 不再是 mobile_offline，mobileClients 反映连接数', async () => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
    await new Promise(resolve => socket.once('connect', resolve));
    await sleep(200); // 等 join approved room（本机 isLocal → 直接批准）

    const { body } = await get('/metrics', TOKEN);
    assert.ok(body.states.mobileClients >= 1, `应至少 1 个已连接移动端，实际 ${body.states.mobileClients}`);
    assert.notEqual(body.state, 'mobile_offline'); // 有连接了，不再是移动离线
    assert.equal(typeof body.metrics.events, 'number');

    socket.disconnect();
  });
});
