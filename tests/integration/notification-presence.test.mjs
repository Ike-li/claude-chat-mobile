// tests/integration/notification-presence.test.mjs —— client:presence 上报解锁 result 完成通知集成测试
//
// 背景/根因（详见 src/ops/notifications.js hasForegroundApprovedClient 与 src/server/app.js onEvent 里
// hasClients 的计算）：approved 房间"连着 socket"不等于"看得见"——PWA 切后台后 socket 常常还没断（要等
// OS 冻结页面才真正断连），若只按"approved 房间是否有 socket"判定 hasClients，会把"背景里还连着但看不见"
// 误判为"有人在看"，result 完成通知因此被永久吞掉（用户反馈"切后台收不到完成通知"的根因）。前端在
// visibilitychange/pagehide/连接成功时上报 client:presence，服务端记 socket.data.hidden；
// hasForegroundApprovedClient 据此判定"approved 房间里是否还有前台连接"。
//
// 验证手法：本文件不产生真实 claude turn（省 token，符合"不要跑 RUN_CLAUDE_INTEGRATION=1"的要求）——
// app.js onEvent 里那条 hasClients 计算只在一次真实 result 类型 agent:event 到达时才会跑到，而 result
// 只在一次真实 agent turn 完成后才产生（app.js 只导出 {httpServer,io,port}，没有暴露 agents/openInstance
// 之类的内部钩子可以绕开真实 CLI 子进程合成一次 result）。本测试改用"真实运行的 server + 真实 socket.io
// 连接 + 真实（非 mock）的 hasForegroundApprovedClient/notificationForEvent 纯函数"这个更贴近端到端、
// 但不需要真实 agent turn 的验证层级：
//   ①真实验证 client:presence 这个入向事件确实经真实 wire 协议、被服务端真实的 on(socket,'client:presence',…)
//     handler 处理，并把 socket.data.hidden 写到 io.sockets.sockets 里那个真实 Socket 实例上；
//   ②再用真实（未 mock）的 hasForegroundApprovedClient + notificationForEvent 对这份真实房间成员状态
//     做判定，其输入/输出与 app.js onEvent 里的真实决策链完全一致。
// 未覆盖：app.js onEvent 内部那行 `hasClients: hasForegroundApprovedClient(approvedSockets)` 的具体
// wiring 本身没有被一次真实 result 事件穿过——这一点在任务收尾的风险清单里如实说明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { hasForegroundApprovedClient, notificationForEvent } from '../../src/ops/notifications.js';

const sleep = ms => new Promise(res => setTimeout(res, ms));
// 同 config-refresh.test.mjs：显式给非空测试 token，绕开 dotenv 空串回填的既有环境红
// （ccm-integration-tests-env-redness 记忆条目）。
const TOKEN = 'notification-presence-test-token';
let port, dataDir, httpServer, io;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-notification-presence-test-'));

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

  // 覆盖 dotenv 加载的 CF Access 配置（同 config-refresh.test.mjs 套路）：连接走 127.0.0.1 本不会撞
  // isPublicHost，但显式关闭更稳妥、不依赖 host 匹配细节。
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
    // 用 instances 广播作为"已加入 approved 房间、拿到完整重放"的确定性信号
    // （deviceApproved===false 的连接只会收到 device_status:pending，收不到 instances）。
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

// approved 房间里当前所有真实 server 端 Socket 对象——与 app.js onEvent 里的取法完全一致
// （io.sockets.adapter.rooms.get('approved') → 映射 io.sockets.sockets.get(id) → 过滤 undefined）。
function approvedSockets() {
  const ids = io.sockets.adapter.rooms.get('approved');
  if (!ids) return [];
  return [...ids].map(id => io.sockets.sockets.get(id)).filter(Boolean);
}

test.describe('client:presence 上报解锁 result 完成通知（PWA 后台推送）', () => {
  test.before(async () => { await startServer(); });
  test.after(async () => { await cleanup(); });

  test('连接后未上报 presence → socket.data.hidden 为 undefined → 保守按前台算 → result 仍被抑制（回到现状，不误伤）', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances'); // 确认已加入 approved 房间、拿到完整重放
      const sockets = approvedSockets();
      assert.equal(sockets.length, 1, '应恰好一个已批准连接（本机 loopback 自动批准）');
      assert.equal(sockets[0].data?.hidden, undefined, '未上报过 presence 时 socket.data.hidden 应为 undefined');
      assert.equal(hasForegroundApprovedClient(sockets), true);
      const pn = notificationForEvent('result', { durationMs: 1000, isError: false }, { hasClients: hasForegroundApprovedClient(sockets) });
      assert.equal(pn, null, '未上报 presence 时应保守按"有人在看"处理，result 不推送（不因误判后台而重复轰炸）');
    } finally {
      client.disconnect();
    }
  });

  test('emit client:presence {hidden:true}（切后台）→ 服务端真实写入 socket.data.hidden → result 解锁推送', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      client.socket.emit('client:presence', { hidden: true }); // 无 ack，fire-and-forget
      await sleep(150); // 给服务端一个事件循环 tick 落地 socket.data
      const sockets = approvedSockets();
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0].data?.hidden, true, 'client:presence 应把服务端真实 Socket 的 data.hidden 置为 true');
      assert.equal(hasForegroundApprovedClient(sockets), false, '唯一连接已切后台 → 无前台已批准客户端');
      const pn = notificationForEvent('result', { durationMs: 3210, isError: false }, { hasClients: hasForegroundApprovedClient(sockets) });
      assert.ok(pn, 'result 应解锁推送——此前会被"approved 房间还连着"误判吞掉的场景');
      assert.equal(pn.title, '✅ 任务完成');
    } finally {
      client.disconnect();
    }
  });

  test('emit client:presence {hidden:false}（切回前台）→ result 恢复抑制（有人在看，不重复推）', async () => {
    const client = createClient();
    try {
      await client.waitForConnect();
      await client.waitForEvent('instances');
      client.socket.emit('client:presence', { hidden: true });
      await sleep(150);
      client.socket.emit('client:presence', { hidden: false });
      await sleep(150);
      const sockets = approvedSockets();
      assert.equal(sockets[0].data?.hidden, false);
      assert.equal(hasForegroundApprovedClient(sockets), true);
      const pn = notificationForEvent('result', { durationMs: 1000, isError: false }, { hasClients: hasForegroundApprovedClient(sockets) });
      assert.equal(pn, null, '前台可见时 result 不推送（用户自己在 app 内看得到）');
    } finally {
      client.disconnect();
    }
  });

  test('两个已批准连接，一前台一后台 → 仍判定为有前台客户端（result 不推送）', async () => {
    const clientA = createClient();
    const clientB = createClient();
    try {
      await clientA.waitForConnect();
      await clientA.waitForEvent('instances');
      await clientB.waitForConnect();
      await clientB.waitForEvent('instances');
      clientA.socket.emit('client:presence', { hidden: true });  // A 切后台
      clientB.socket.emit('client:presence', { hidden: false }); // B 仍前台
      await sleep(150);
      const sockets = approvedSockets();
      assert.equal(sockets.length, 2);
      assert.equal(hasForegroundApprovedClient(sockets), true, '只要还有一个前台连接，就不该推送');
    } finally {
      clientA.disconnect();
      clientB.disconnect();
    }
  });
});
