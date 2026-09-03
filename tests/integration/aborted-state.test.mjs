// tests/integration/aborted-state.test.mjs —— 已中止独立状态端到端集成测试（P1-4）
// 状态机纯函数逻辑见 tests/unit/instance-latches.test.mjs（零 token）；本文件验证真实链路：
// 用户中止一个真正在跑的轮次后，instances 事件里对应实例的 state 确实变为 'aborted'
// （而非此前回落的 idle，让"我自己叫停"和"什么都没发生"在 UI 上不可区分）。
// 需真实 claude agent turn，默认跳过，本机设 RUN_CLAUDE_INTEGRATION=1 运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { waitForServerReady } from './_spawn-server.mjs';

let port, dataDir, httpServer, io;

// 注：不能靠 delete AUTH_TOKEN 假装"无鉴权"——机主本机 .env 若已配置真实 AUTH_TOKEN/CF Access，
// app/server.js 顶层 dotenv.config() 会在 delete 后重新从 .env 注入（变量变回"不存在"触发重新注入），
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

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await waitForServerReady(port, authToken);
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

    // 任务「全新会话首轮点停止后不跳回主页」的核实性验证（TDD 第一步，非该任务的最终修复本身）。
    // 疑点：新会话首发的 sessionId 尚未由 SDK init 返回时就点停止，agent.js#interrupt() 的 catch 分支
    // （q.interrupt() 抛错 且 pendingTurns>0）会走 settleForce()，其内部 this.abort?.abort() 会强杀子
    // 进程——consume() 的 for-await 循环随之结束，实例被置 disposed=true 并触发 onExit()（server 侧
    // 从 agents Map 删除该 instanceId + reselectViewingAfter → viewingInstanceId 变 null）。这比"同一
    // 实例只是 sessionId 仍为空"更严重：实例本身消失会让前端下一次 bindView 走到从未被
    // _pendingFirstSend 早退保护过的分支，才是"跳回主页/空表面"更深层的可能根因。
    // 本测试验证核心结论：sessionId 未知（未见 init）时中断，该 instanceId 是否仍存活、能否续接下一条
    // 消息正常完成一轮并拿到 sessionId——而不是被 dispose 导致 server 判它 stale。
    test('新会话首轮 sessionId 未到（init 未见）即中断 → 实例仍存活可续用，第二条消息能正常完成', async () => {
      const client = createClient();
      await client.waitFor(e => e.type === 'instances');

      client.socket.emit('user:message', { text: '你好' });
      // user_message 由 agent.js#send() 同步 emit（早于 CLI 子进程真正启动完成、吐出 init），借它的
      // instanceId 尽早发起中断，抢在 sessionId 落地前——真实验证需要这条竞速，而非假设其结论。
      const umEv = await client.waitFor(e => e.type === 'user_message', 10000);
      const instanceId = umEv.instanceId;
      assert.ok(instanceId, 'user_message 信封应带 instanceId');
      // 如实记录本次真实运行是否命中了"sessionId 尚未知"的目标窗口（诊断信息，不做强断言——计时窗口
      // 本身若被断言死，会把环境快慢变成 flaky 源；核心断言在下面"中断后仍可续用"）。
      const sawInitBeforeInterrupt = client.events.some(e => e.type === 'init' && e.instanceId === instanceId);

      client.socket.emit('user:interrupt', { instanceId });
      await client.waitFor(e => e.type === 'system' && e.payload?.kind === 'interrupted', 15000);

      // 核心断言①：中断后该 instanceId 应仍可接受新消息——若已被 dispose，resolveInstanceTarget 会判
      // 它 stale，ack 会带 {ok:false, error:'stale_instance', stale:true}（见 app/src/server/app.js user:message 处理器）。
      const ack = await new Promise(resolve => {
        client.socket.emit('user:message', { text: '1+1 等于几？只回答阿拉伯数字', instanceId }, resolve);
      });
      assert.notEqual(ack?.ok, false, `第二条消息应被同一实例接受（未被 dispose）；ack=${JSON.stringify(ack)}`);
      assert.equal(ack?.instanceId, instanceId, '应仍在同一实例上处理，而非懒开了新实例');

      // 核心断言②：这一轮应能正常跑完并拿到 sessionId（agent.js 在 emit('init')/'result' 前已赋值 this.sessionId）。
      const resultEv = await client.waitFor(e => e.type === 'result' && e.instanceId === instanceId, 30000);
      assert.ok(resultEv.sessionId, '中断后续完成的这一轮，其 result 信封应带上已获得的 sessionId');

      console.log(`[interrupt-before-init verify] sawInitBeforeInterrupt=${sawInitBeforeInterrupt}`);
      client.disconnect();
    });
  },
);
