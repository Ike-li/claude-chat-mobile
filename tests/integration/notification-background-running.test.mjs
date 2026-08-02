// tests/integration/notification-background-running.test.mjs —— presence 跳变触发「后台运行中」提示
// 的判定链集成测试（PWA 切后台锁屏看不到应用还活着，硬边界见 src/server/app.js on(socket,'client:presence',…)
// 调用点注释：做不到锁屏常驻实时指示，这只是有活轮次时补一条"别担心，跑完会通知你"）。
//
// 背景/根因：详见 src/ops/notifications.js shouldNotifyBackgroundRunning 与 src/server/app.js
// on(socket,'client:presence',…) 里对它的调用。该 handler 在 hidden:true 上报时，于真正 mutate
// socket.data.hidden 前后各调一次 hasForegroundApprovedClient，喂 shouldNotifyBackgroundRunning 判定
// 是否发生"approved 房间从有前台变为无前台"的跳变；只有跳变发生【且】此刻确有实例在跑（busy）才推。
//
// 验证手法：与 tests/integration/notification-presence.test.mjs 同一套边界——本文件不产生真实 claude
// turn（省 token，符合"不要跑 RUN_CLAUDE_INTEGRATION=1"的要求）。server.js/app.js 只导出
// {httpServer,io,port}，没有暴露 agents/openInstance 之类的内部钩子可以绕开真实 CLI 子进程合成一个
// "busy 实例"，因此本测试用"真实运行的 server + 真实 socket.io 连接 + 真实（非 mock）的
// hasForegroundApprovedClient/shouldNotifyBackgroundRunning 纯函数"验证判定链本身：
//   ①真实验证 client:presence 上报确实经真实 wire 协议被服务端处理，approved 房间的真实 Socket 对象
//     的 data.hidden 按预期变化（回归保护：新增的"跳变检测"分支不得改变原有 socket.data.hidden 赋值
//     语义，这是任务里明确要求"不动已验证通过的判定逻辑"的部分）；
//   ②再用真实房间成员状态（同 notification-presence.test.mjs 的 approvedSockets() 取法）在跳变前后
//     各调一次真实的 hasForegroundApprovedClient，验证其确实按预期在"唯一连接从前台变后台"时给出
//     true→false，在"同一 socket 重复上报"或"仍有其他前台连接"时不构成跳变；
//   ③hasBusyInstance 无法在无真实 CLI turn 的前提下从真实 agents Map 取得（没有导出钩子），故按
//     shouldNotifyBackgroundRunning 的契约手工提供 true/false 两种取值，验证判定链的组合结果——与
//     notification-presence.test.mjs 对 result 事件的处理方式（该文件同样只验证判定链，未覆盖
//     app.js onEvent 内部 wiring 本身）保持同一诚实边界。
// 未覆盖（如实登记）：src/server/app.js on(socket,'client:presence',…) handler 内部那段"遍历 agents、
// 对 busy 实例调用 pushNotify/ntfyNotify"的具体 wiring，没有被一次真实的"跳变+有 busy 实例"场景穿过——
// 这需要一个真实在跑的 AgentSession 实例，本测试手法无法在不消耗真实 CLI turn 的前提下构造。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { hasForegroundApprovedClient, shouldNotifyBackgroundRunning } from '../../src/ops/notifications.js';

const sleep = ms => new Promise(res => setTimeout(res, ms));
// 同 notification-presence.test.mjs：显式给非空测试 token，绕开 dotenv 空串回填的既有环境红
// （ccm-integration-tests-env-redness 记忆条目）。
const TOKEN = 'notification-bgrun-test-token';
let port, dataDir, httpServer, io;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-notification-bgrun-test-'));

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

  // 覆盖 dotenv 加载的 CF Access 配置（同 notification-presence.test.mjs 套路）：连接走 127.0.0.1 本不会
  // 撞 isPublicHost，但显式关闭更稳妥、不依赖 host 匹配细节。
  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../src/auth/cf-access.js');
  cfAccess.initCfAccess();
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

function createClient() {
  const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('agent:event', e => events.push(e));
  return {
    socket,
    waitForConnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (socket.connected) return resolve();
        const timer = setTimeout(() => reject(new Error('connect timeout')), timeout);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
    },
    // 用 instances 广播作为"已加入 approved 房间、拿到完整重放"的确定性信号（同 notification-presence）。
    waitForEvent(type, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const existing = events.find(e => e.type === type);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        const handler = e => {
          if (e.type === type) { clearTimeout(timer); socket.off('agent:event', handler); resolve(e); }
        };
        socket.on('agent:event', handler);
      });
    },
    disconnect() { socket.disconnect(); },
  };
}

// approved 房间里当前所有真实 server 端 Socket 对象——与 app.js approvedSocketObjects() 取法完全一致。
function approvedSockets() {
  const ids = io.sockets.adapter.rooms.get('approved');
  if (!ids) return [];
  return [...ids].map(id => io.sockets.sockets.get(id)).filter(Boolean);
}

test.describe('presence 跳变触发「后台运行中」提示的判定链（PWA 切后台锁屏可见性）', () => {
  test.before(async () => { await startServer(); });
  test.after(async () => { await cleanup(); });

  test('单一已批准连接：hidden:true 上报前 hasForegroundApprovedClient=true、上报后=false → 构成真实跳变', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances'); // 确认已加入 approved 房间
      const sockets = approvedSockets();
      assert.equal(sockets.length, 1);
      const hadForeground = hasForegroundApprovedClient(sockets);
      assert.equal(hadForeground, true, '未上报过 presence 时应保守按前台算');

      client.socket.emit('client:presence', { hidden: true }); // fire-and-forget，无 ack
      await sleep(150); // 给服务端一个事件循环 tick 落地 socket.data

      const hasForeground = hasForegroundApprovedClient(sockets); // 同一批真实 Socket 对象引用，反映最新状态
      assert.equal(hasForeground, false, '唯一连接切后台后应无前台已批准客户端');

      // 判定链：真实跳变（true→false）+ 有 busy 实例 → 该推；无 busy 实例 → 不该推
      assert.equal(shouldNotifyBackgroundRunning({ hadForeground, hasForeground, hasBusyInstance: true }), true);
      assert.equal(shouldNotifyBackgroundRunning({ hadForeground, hasForeground, hasBusyInstance: false }), false, '没有实例在跑就没必要提醒');
    } finally {
      client.disconnect();
    }
  });

  test('同一 socket 重复上报 hidden:true：第二次上报前房间已无前台，不构成新的跳变（天然节流，无需额外状态机）', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      const sockets = approvedSockets();

      client.socket.emit('client:presence', { hidden: true });
      await sleep(150);
      assert.equal(hasForegroundApprovedClient(sockets), false, '第一次上报后已无前台');

      // 第二次上报前先取快照（对应真实 handler 里 mutate 前的 hadForeground）
      const hadForegroundSecondReport = hasForegroundApprovedClient(sockets);
      client.socket.emit('client:presence', { hidden: true }); // 同一 socket 重复上报（如网络重发/多次心跳）
      await sleep(150);
      const hasForegroundSecondReport = hasForegroundApprovedClient(sockets);

      assert.equal(hadForegroundSecondReport, false, '重复上报前就已经是无前台状态');
      assert.equal(hasForegroundSecondReport, false);
      assert.equal(
        shouldNotifyBackgroundRunning({ hadForeground: hadForegroundSecondReport, hasForeground: hasForegroundSecondReport, hasBusyInstance: true }),
        false,
        '非跳变时刻，即使有 busy 实例也不该重复推'
      );
    } finally {
      client.disconnect();
    }
  });

  test('两个已批准连接，一个切后台、另一个仍前台 → 房间层面未跳变（仍有前台可见），不该推', async () => {
    const clientA = createClient();
    const clientB = createClient();
    try {
      await clientA.waitForConnect();
      await clientA.waitForEvent('instances');
      await clientB.waitForConnect();
      await clientB.waitForEvent('instances');
      const sockets = approvedSockets();
      assert.equal(sockets.length, 2);

      const hadForeground = hasForegroundApprovedClient(sockets);
      assert.equal(hadForeground, true);

      clientA.socket.emit('client:presence', { hidden: true }); // A 切后台，B 仍前台（未上报=保守按前台算）
      await sleep(150);
      const hasForeground = hasForegroundApprovedClient(sockets);
      assert.equal(hasForeground, true, 'B 仍前台，房间层面不构成"无前台"');

      assert.equal(shouldNotifyBackgroundRunning({ hadForeground, hasForeground, hasBusyInstance: true }), false, '未跳变，不该推');
    } finally {
      clientA.disconnect();
      clientB.disconnect();
    }
  });

  test('回归保护：新增的跳变检测分支不改变 hidden:false 分支的既有赋值语义（socket.data.hidden 仍正确落 false）', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      const sockets = approvedSockets();

      client.socket.emit('client:presence', { hidden: true });
      await sleep(150);
      assert.equal(sockets[0].data?.hidden, true);

      client.socket.emit('client:presence', { hidden: false }); // 切回前台
      await sleep(150);
      assert.equal(sockets[0].data?.hidden, false, 'hidden:false 分支应仍正确落地 socket.data.hidden=false（未被新增逻辑破坏）');
      assert.equal(hasForegroundApprovedClient(sockets), true);
    } finally {
      client.disconnect();
    }
  });
});
