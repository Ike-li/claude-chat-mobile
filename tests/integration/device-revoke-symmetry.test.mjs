// tests/integration/device-revoke-symmetry.test.mjs —— CLI 吊销对称断连集成测试（SEC-03）
//
// 背景：Web 侧 user:denyDevice 会立即 disconnectDeviceSockets（发 device_status:denied + 断开）；
// 但 trusted-devices.json 的文件监听器此前只处理「新批准」方向（deviceApproved===false → 解锁），
// CLI 执行 device.js deny（本质是 devices.js#denyDevice 写文件删信任记录）不会主动断开已连接的
// approved socket——CLI 吊销与 Web 吊销行为不对称。
//
// 复用 devices.js 的 approveDevice/denyDevice（scripts/device.js CLI 命令的底层实现）模拟真实 CLI
// 操作（非 mock，同一份生产代码路径）。走真实 LAN 网卡 IP 触发 TOFU（isLocal=false 时 deviceApproved
// 才真正受信任表控制、走 trustBasis='device-token' 分支——同 SEC-01 测试的手法，无 LAN 网卡时跳过）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { reserveFreePort, waitForServerReady } from './_spawn-server.mjs';

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
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CCM_TRUSTED_DEVICES_FILE', 'CCM_PENDING_DEVICES_FILE', 'WEB_STATUSLINE',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(await reserveFreePort());
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = authToken; // host 绑 0.0.0.0，LAN IP 可达

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();
  devicesModule = await import('../../app/src/auth/devices.js');
  await waitForServerReady(port, authToken);
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
  (LAN_IP ? {} : { skip: '本机无可用 LAN 网卡，无法真实触发 device-token 信任分支，跳过' }),
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

      // FR-19 最小审计记录（承接 Phase 4）：CLI 批准/吊销都应各留一条 audit_record（via=cli）。
      const AU = await import('../../app/src/ops/audit.js');
      const approved = AU.listRecent({ limit: 100, action: 'device_approved' });
      const revoked = AU.listRecent({ limit: 100, action: 'device_revoked' });
      assert.ok(approved.some(r => r.target === token && r.actor.via === 'cli'), `应有本 token 的 CLI 批准审计，实际：${JSON.stringify(approved)}`);
      assert.ok(revoked.some(r => r.target === token && r.actor.via === 'cli'), `应有本 token 的 CLI 吊销审计，实际：${JSON.stringify(revoked)}`);
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

    // user:approveDevice 有「目标必须在待审批列表里」的纵深防御（app.js:2695），user:denyDevice
    // 此前没有同款守卫——它接受任意 deviceId 直接调用 denyDevice()，而 denyDevice 对【已信任】
    // 的 token 同样生效（从 trustedDevices 里删除）。已批准的客户端每次握手都会带上自己完整的
    // deviceToken（socket.handshake.auth.deviceToken），于是可以拿 user:denyDevice 传自己的
    // deviceId 自吊销——绕开了 user:revokeTrustedDevice 那条路径专门加的 self 守卫
    // （decideRevokeByShortId 的 requesterToken 检查）。
    // 寻址已改成 shortId（DEVICE-03：待审广播不带全量 token）。这里传的是【合法形态】的 shortId，
    // 走到的才是「只在待审列表里反查」那道守卫；还传旧的 { deviceId } 的话，handler 在缺 shortId 的
    // 入口就 return 了，本用例会变成永远绿。
    test('user:denyDevice 不得允许已信任设备自吊销（须只在待审批列表里反查）', async () => {
      const token = `denydevice-self-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const client = connectAndCollect(`http://${LAN_IP}:${port}`, { token: 'secret-token', deviceToken: token });
      await client.waitForType('device_status', 5000, e => e.payload.status === 'pending');

      devicesModule.approveDevice(token);
      await client.waitForType('device_status', 3000, e => e.payload.status === 'approved');
      assert.equal(devicesModule.isDeviceTrusted(token), true, '前置条件：设备此刻应已受信任');

      client.socket.emit('user:denyDevice', { shortId: devicesModule.shortDeviceId(token) });
      await sleep(500); // 无 ack，等潜在的断连/落盘副作用发生

      assert.equal(devicesModule.isDeviceTrusted(token), true,
        '已信任设备不应能通过 user:denyDevice 传自己的 deviceId 自吊销');
      client.socket.disconnect();
    });
  },
);
