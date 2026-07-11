// test/integration/device-revoke-symmetry.test.mjs —— CLI 吊销对称断连集成测试（SEC-03）
//
// 背景：Web 侧 user:denyDevice 会立即 disconnectDeviceSockets（发 device_status:denied + 断开）；
// 但 trusted-devices.json 的文件监听器此前只处理「新批准」方向（deviceApproved===false → 解锁），
// CLI 执行 device.js deny（本质是 devices.js#denyDevice 写文件删信任记录）不会主动断开已连接的
// approved socket——CLI 吊销与 Web 吊销行为不对称。
//
// 复用 devices.js 的 approveDevice/denyDevice（scripts/device.js CLI 命令的底层实现）模拟真实 CLI
// 操作（非 mock，同一份生产代码路径）。走真实 LAN 网卡 IP 触发 TOFU（isLocal=false 时 deviceApproved
// 才真正受信任表控制、走 trustBasis='device-token' 分支——同 SEC-01 测试的手法，无 LAN 网卡时跳过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
let port, dataDir, httpServer, io, devicesModule;

function getLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}
const LAN_IP = getLanIp();

async function startServer(authToken = 'secret-token') {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-device-revoke-test-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR', 'WEB_STATUSLINE',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = authToken; // host 绑 0.0.0.0，LAN IP 可达

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../cf-access.js');
  cfAccess.initCfAccess();
  devicesModule = await import('../../devices.js');
  await sleep(500);
}

function connectAndCollect(url, auth) {
  const socket = ioClient(url, { auth, transports: ['websocket'], reconnection: false });
  const events = [];
  let disconnected = false;
  socket.on('agent:event', (envelope) => events.push(envelope));
  socket.on('disconnect', () => { disconnected = true; });
  return {
    socket, events,
    get disconnected() { return disconnected; },
    // predicate 可选：device_status 会先后收到不同 payload.status（pending→approved），仅按 type 匹配
    // 会命中数组里更早收到的旧事件——需要能精确等待"下一个满足条件的"事件，而非"曾经收到过"。
    waitForType(type, timeout = 5000, predicate = () => true) {
      return new Promise((resolve, reject) => {
        const existing = events.find(e => e.type === type && predicate(e));
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`超时未收到事件类型：${type}`)), timeout);
        const handler = (envelope) => {
          if (envelope.type === type && predicate(envelope)) { clearTimeout(timer); socket.off('agent:event', handler); resolve(envelope); }
        };
        socket.on('agent:event', handler);
      });
    },
    waitForDisconnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (disconnected) return resolve();
        const timer = setTimeout(() => reject(new Error('超时未断开连接')), timeout);
        socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe(
  'CLI 吊销对称断连（SEC-03）',
  process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : (LAN_IP ? {} : { skip: '本机无可用 LAN 网卡，无法真实触发 device-token 信任分支，跳过' }),
  () => {
    test.before(async () => { await startServer('secret-token'); });
    test.after(async () => { await cleanup(); });

    test('CLI denyDevice 吊销已批准设备 → 已连接 socket 应被断连（此前只有 Web 侧会断连）', async () => {
      const token = `revoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // ① 走真实 LAN IP + 全新 deviceToken 连接 → TOFU pending（deviceApproved=false）
      const client = connectAndCollect(`http://${LAN_IP}:${port}`, { token: 'secret-token', deviceToken: token });
      const pendingStatus = await client.waitForType('device_status', 5000, e => e.payload.status === 'pending');
      assert.equal(pendingStatus.payload.status, 'pending', '新设备应处于待审批态');

      // ② 模拟 CLI 批准（devices.js#approveDevice，scripts/device.js approve 的底层实现）→ 文件 watch 触发解锁
      devicesModule.approveDevice(token);
      const approvedStatus = await client.waitForType('device_status', 3000, e => e.payload.status === 'approved');
      assert.equal(approvedStatus.payload.status, 'approved', 'CLI 批准后应自动解锁（既有行为，回归确认未破坏）');
      assert.equal(client.disconnected, false, '批准不应断开连接');

      // ③ 模拟 CLI 吊销（devices.js#denyDevice，scripts/device.js deny 的底层实现）→ 文件 watch 应检测并断连
      devicesModule.denyDevice(token);
      await client.waitForDisconnect(3000);
      assert.equal(client.disconnected, true, 'CLI 吊销后已连接的 approved socket 应被断开（SEC-03 对称修复）');
    });

    test('trustBasis=bypass（isLocal/CF Access）的连接不受信任表吊销影响（防误伤本机连接）', async () => {
      // 本机 127.0.0.1 连接，isLocal=true → 直接批准，trustBasis='bypass'，与信任表无关
      const local = connectAndCollect(`http://127.0.0.1:${port}`, { token: 'secret-token' });
      await sleep(300); // 无需等特定事件，仅需确认连上且存活
      assert.equal(local.socket.connected, true, '本机连接应正常建立');

      // 即便信任表发生变化（吊销一个不相关的 token），本机连接也不应被误断
      devicesModule.denyDevice(`unrelated-token-${Date.now()}`);
      await sleep(500);
      assert.equal(local.socket.connected, true, '吊销无关 token 不应影响 trustBasis=bypass 的本机连接');
      local.socket.disconnect();
    });
  },
);
