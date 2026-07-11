// test/integration/aborted-state.test.mjs —— 已中止独立状态端到端集成测试（P1-4）
// 状态机纯函数逻辑见 test/instance-latches.test.mjs（零 token）；本文件验证真实链路：
// 用户中止一个真正在跑的轮次后，instances 事件里对应实例的 state 确实变为 'aborted'
// （而非此前回落的 idle，让"我自己叫停"和"什么都没发生"在 UI 上不可区分）。
// 需真实 claude agent turn，默认跳过，本机设 RUN_CLAUDE_INTEGRATION=1 运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
let port, dataDir, httpServer, io;

// 注：不能靠 delete AUTH_TOKEN 假装"无鉴权"——机主本机 .env 若已配置真实 AUTH_TOKEN/CF Access，
// server.js 顶层 dotenv.config() 会在 delete 后重新从 .env 注入（变量变回"不存在"触发重新注入），
// 导致测试客户端因未带正确 token 被拒连接、卡死等 init 超时（本次实测踩过）。改用与其余集成测试
// 一致、已验证工作的模式：显式设一个测试专用 AUTH_TOKEN，客户端显式携带同一 token。
async function startServer(authToken = 'aborted-state-test-token') {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-aborted-state-test-'));
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
  const cfAccess = await import('../../cf-access.js');
  cfAccess.initCfAccess();
  await sleep(500);
}

function createClient(authToken = 'aborted-state-test-token') {
  const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: authToken }, transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('agent:event', (envelope) => events.push(envelope));
  return {
    socket, events,
    waitFor(predicate, timeout = 20000) {
      return new Promise((resolve, reject) => {
        const existing = events.find(predicate);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error('超时未收到满足条件的事件')), timeout);
        const handler = (envelope) => {
          if (predicate(envelope)) { clearTimeout(timer); socket.off('agent:event', handler); resolve(envelope); }
        };
        socket.on('agent:event', handler);
      });
    },
    disconnect() { socket.disconnect(); },
  };
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe(
  '已中止独立状态（P1-4）',
  (process.env.CI || !process.env.RUN_CLAUDE_INTEGRATION) ? { skip: '默认/CI 跳过——需真 claude agent turn(慢/耗 token/不稳);本机设 RUN_CLAUDE_INTEGRATION=1 运行' } : {},
  () => {
    test.before(async () => { await startServer(); });
    test.after(async () => { await cleanup(); });

    test('用户中止在途轮次 → instances 事件的 state 变为 aborted（非回落 idle）', async () => {
      const client = createClient();
      // 连接时是"空首页"（无 live 实例、viewingInstanceId=null），init 事件只在真正驱动 SDK 后才到达
      // （懒创建：openInstance 由第一条 user:message 触发）——不能在发消息前等 init，先等 instances 快照即可。
      await client.waitFor(e => e.type === 'instances');

      // 要求输出较长文本，确保有窗口在说完之前发起中止
      client.socket.emit('user:message', { text: '从 1 数到 200，每个数字单独一行，不要用任何工具，只输出数字。' });
      const initEv = await client.waitFor(e => e.type === 'init', 20000);
      const instanceId = initEv.instanceId;
      assert.ok(instanceId, 'init 信封应带 instanceId');
      await client.waitFor(e => e.type === 'text_delta');

      client.socket.emit('user:interrupt', { instanceId });
      await client.waitFor(e => e.type === 'system' && e.payload?.kind === 'interrupted', 10000);

      const abortedEv = await client.waitFor(
        e => e.type === 'instances' && e.payload.instances?.find(i => i.instanceId === instanceId)?.state === 'aborted',
        10000,
      );
      const inst = abortedEv.payload.instances.find(i => i.instanceId === instanceId);
      assert.equal(inst.state, 'aborted', '中止后 instances 中该实例状态应为 aborted');

      client.disconnect();
    });
  },
);
