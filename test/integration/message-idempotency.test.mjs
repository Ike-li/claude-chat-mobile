// test/integration/message-idempotency.test.mjs —— user:message 幂等 + ack 端到端集成测试（REL-01）
// 去重纯函数单测见 test/message-dedup.test.mjs（零 token）；本文件验证真实接线：
// 同一 clientMessageId 重复 emit，第二次应被服务端拦截（ack 标 deduped，不重复驱动 agent）。
// 需真实 claude agent turn（懒创建 AgentSession 即会 spawn 真实 claude 子进程），默认跳过，
// 本机设 RUN_CLAUDE_INTEGRATION=1 运行；成本低于 P1-4 的验证（不需等待任何模型文本输出）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
let port, dataDir, httpServer, io;

// 不能靠 delete AUTH_TOKEN 假装"无鉴权"——机主本机 .env 若已配置真实 AUTH_TOKEN/CF Access，
// server.js 顶层 dotenv.config() 会在 delete 后重新从 .env 注入（变量变回"不存在"触发重新注入），
// 致测试客户端未带正确 token 被拒连接（P1-4 aborted-state.test.mjs 已踩过、这里应直接复用教训）。
async function startServer(authToken = 'msg-idempotency-test-token') {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-msg-idempotency-test-'));
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

function createClient(authToken = 'msg-idempotency-test-token') {
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
  'user:message 幂等 + ack（REL-01）',
  (process.env.CI || !process.env.RUN_CLAUDE_INTEGRATION) ? { skip: '默认/CI 跳过——需真 claude agent turn(慢/耗 token/不稳);本机设 RUN_CLAUDE_INTEGRATION=1 运行' } : {},
  () => {
    test.before(async () => { await startServer(); });
    test.after(async () => { await cleanup(); });

    test('同一 clientMessageId 重复发送 → 第二次被去重（ack deduped），不重复驱动 agent', async () => {
      const client = createClient();
      await client.waitFor(e => e.type === 'instances'); // 空首页快照（P1-4 教训：init 事件要等发消息后才到）

      const clientMessageId = `test-dedup-${Date.now()}`;
      const ack1 = await new Promise((resolve, reject) => {
        client.socket.timeout(30000).emit('user:message', { text: '回复"ok"两个字，不要多说', clientMessageId }, (err, res) => {
          if (err) reject(err); else resolve(res);
        });
      });
      assert.equal(ack1.ok, true, '首次发送应被正常接受');
      assert.ok(!ack1.deduped, '首次不应标 deduped');

      // 同一 clientMessageId 立即重发（模拟离线重连后的重复投递）
      const ack2 = await new Promise((resolve, reject) => {
        client.socket.timeout(10000).emit('user:message', { text: '回复"ok"两个字，不要多说', clientMessageId }, (err, res) => {
          if (err) reject(err); else resolve(res);
        });
      });
      assert.equal(ack2.ok, true, '重复消息也应 ack ok（已处理过，非失败）');
      assert.equal(ack2.deduped, true, '重复的 clientMessageId 应被标记 deduped，不重复驱动 agent');

      client.disconnect();
    });

    test('不同 clientMessageId → 均正常处理，互不影响', async () => {
      const client = createClient();
      await client.waitFor(e => e.type === 'instances');

      const ack1 = await new Promise((resolve, reject) => {
        client.socket.timeout(30000).emit('user:message', { text: '回复"1"一个字', clientMessageId: `test-a-${Date.now()}` }, (err, res) => {
          if (err) reject(err); else resolve(res);
        });
      });
      assert.equal(ack1.ok, true);
      assert.ok(!ack1.deduped);

      const ack2 = await new Promise((resolve, reject) => {
        client.socket.timeout(10000).emit('user:message', { text: '回复"2"一个字', instanceId: ack1.instanceId, clientMessageId: `test-b-${Date.now()}` }, (err, res) => {
          if (err) reject(err); else resolve(res);
        });
      });
      assert.equal(ack2.ok, true);
      assert.ok(!ack2.deduped, '不同 clientMessageId 不应被误判为重复');

      client.disconnect();
    });
  },
);
