// tests/integration/config-refresh.test.mjs —— config:refresh（CLI 配置刷新按钮）集成测试
// 背景：ensureCliDefaults(cwd) 的结果按 cwd 缓存进 cliDefaultsByCwd，只在启动预取 / session:new /
// session:home 才 force 重读；用户在 CLI 侧改了 ~/.claude/settings.json（或本例更易控的
// .claude/settings.local.json）后，web 端 compose 页默认档摘要不会自动感知。config:refresh 是手动
// 兜底入口：force 重读 + broadcastInstances。
// 验证：①ack {ok:true}；②instances 广播携带强制重读后的最新 defaultPermissionMode（证明真的重读了
// 磁盘，不是吐缓存里的旧值）；③显式传非法/越界 cwd 时回落 viewingCwd，ack 仍 ok。
// 零 token 成本（不起真 claude turn，只读本地 settings.local.json；sdkResolveSettings 不 spawn CLI）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
// 同 metrics-endpoint.test.mjs：显式设一个非空测试 token 而非删空——dotenv 默认不覆盖已存在的非空
// key（config.js 的预清空只针对空串），删空反而会被本机真实 .env 里的 AUTH_TOKEN/CF Access 回填
// （ccm-integration-tests-env-redness 记忆条目）。给真实非空值可绕开这整类既有环境红。
const TOKEN = 'config-refresh-test-token';
let port, dataDir, httpServer, io;

function writeLocalSettings(cwd, obj) {
  const dir = join(cwd, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.local.json'), JSON.stringify(obj), 'utf8');
}

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-config-refresh-test-'));
  writeLocalSettings(dataDir, { permissions: { defaultMode: 'plan' } });

  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = TOKEN;

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  // 覆盖 dotenv 加载的 CF Access 配置（同 auth-token.test.mjs 套路）：连接走 127.0.0.1 本不会撞
  // isPublicHost，但显式关闭更稳妥、不依赖 host 匹配细节。
  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();

  await sleep(500); // 等启动时 ensureCliDefaults(WORK_DIR) 首次读盘落缓存（非 force，见 app.js:2767）
}

function createClient() {
  const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('agent:event', e => events.push(e));

  return {
    socket,
    events,
    waitForConnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (socket.connected) return resolve();
        const timer = setTimeout(() => reject(new Error('connect timeout')), timeout);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
    },
    waitForEvent(type, predicate, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const matches = e => e.type === type && (!predicate || predicate(e));
        const existing = events.find(matches);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        const handler = e => {
          if (matches(e)) { clearTimeout(timer); socket.off('agent:event', handler); resolve(e); }
        };
        socket.on('agent:event', handler);
      });
    },
    emitAck(event, payload, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeout);
        socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
      });
    },
    clearEvents() { events.length = 0; },
    disconnect() { socket.disconnect(); },
  };
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe('config:refresh（CLI 配置刷新按钮）', () => {
  test.before(async () => { await startServer(); });
  test.after(async () => { await cleanup(); });

  test('emit config:refresh 后 ack ok，且 instances 广播携带强制重读后的最新 defaultPermissionMode', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      const firstInstances = await client.waitForEvent('instances');
      assert.equal(firstInstances.payload.defaultPermissionMode, 'plan', '启动时应已从 settings.local.json 读到 plan');

      // 模拟用户在终端侧改了配置：plan → acceptEdits
      writeLocalSettings(dataDir, { permissions: { defaultMode: 'acceptEdits' } });

      client.clearEvents();
      const ack = await client.emitAck('config:refresh', {});
      assert.equal(ack.ok, true, 'ack 应为 { ok: true }');

      const refreshed = await client.waitForEvent('instances', e => e.payload?.defaultPermissionMode === 'acceptEdits');
      assert.equal(refreshed.payload.defaultPermissionMode, 'acceptEdits', 'force 重读后应反映磁盘最新值，不是缓存的旧值 plan');
    } finally {
      client.disconnect();
    }
  });

  test('显式传非法/越界 cwd 时回落当前 viewingCwd，ack 仍 ok', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');

      const ack = await client.emitAck('config:refresh', { cwd: '/definitely/not/whitelisted' });
      assert.equal(ack.ok, true);
    } finally {
      client.disconnect();
    }
  });

  // models 事件由 scout 真起 claude 拉模型清单产出，stub（tests/fixtures/fake-claude.sh）给不了 →
  // CI 上必然 10s 超时。同文件其余两个用例只测 settings 重读与 cwd 回落，不碰 CLI，照常在 CI 跑。
  test('config:refresh 后应触发模型缓存刷新（models 事件或 scout）', process.env.CI
    ? { skip: 'models 事件需真 claude scout 拉模型清单；CI 用的是 tests/fixtures/fake-claude.sh stub' }
    : {}, async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      client.clearEvents();

      const ack = await client.emitAck('config:refresh', {});
      assert.equal(ack.ok, true);

      // models 事件应在数秒内到达（由活跃 agent fetchModels 或 scout 触发）
      // 超时 10s 给 CLI 启动足够时间
      const modelsEvent = await client.waitForEvent('models', null, 10000);
      assert.ok(modelsEvent.payload, 'models 事件应携带 payload');
    } finally {
      client.disconnect();
    }
  });
});
