// tests/integration/device-approval-isolation.test.mjs —— 待审批设备下行隔离集成测试（SEC-01）
//
// 背景：`on()` 上行闸门早已对 deviceApproved===false 的 socket fail-closed（丢弃业务事件），但敏感的
// 下行广播（instances/mirror_state/history_append/status_line/session_log/permission_mode/effort_mode/
// 主事件流）此前一律 io.emit（全员广播），待审批 socket 能被动收到——纵深防御的第二道 TOFU 对下行观察类
// 事件形同虚设。修复：approved socket join 'approved' room，敏感广播改 io.to('approved').emit。
//
// 关键点：deviceApproved=false 只在「非公网 Host + 非本机(isLocal=false) + AUTH_TOKEN 正确 + 设备指纹未过
// TOFU」时才会真正出现（isLocal 会话直接跳过 TOFU）。故本测试连真实 LAN 网卡 IP（同手机连同一 WiFi 的路径），
// 而非 mock deviceApproved——这是真实触发该分支的唯一方式，无可用 LAN 网卡时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { networkInterfaces } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
let port, dataDir, httpServer, io;

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
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-device-isolation-test-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR', 'WEB_STATUSLINE',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = authToken; // host 会绑 0.0.0.0（见 server.js host 逻辑），LAN IP 才可达

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await sleep(500);
}

function connectAndCollect(url, auth) {
  const socket = ioClient(url, { auth, transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('agent:event', (envelope) => events.push(envelope));
  return {
    socket, events,
    waitForType(type, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const existing = events.find(e => e.type === type);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`超时未收到事件类型：${type}`)), timeout);
        const handler = (envelope) => {
          if (envelope.type === type) { clearTimeout(timer); socket.off('agent:event', handler); resolve(envelope); }
        };
        socket.on('agent:event', handler);
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
  '待审批设备下行隔离（SEC-01）',
  process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : (LAN_IP ? {} : { skip: '本机无可用 LAN 网卡，无法真实触发 TOFU pending 分支，跳过' }),
  () => {
    test.before(async () => { await startServer('secret-token'); });
    test.after(async () => { await cleanup(); });

    test('待审批 socket 只收 device_status，不收敏感广播（approved socket 正常收到）', async () => {
      // 待审批：走真实 LAN IP（isLocal=false）+ 正确 token + 全新未信任 deviceToken → TOFU pending
      const pendingToken = `pending-dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const pending = connectAndCollect(`http://${LAN_IP}:${port}`, { token: 'secret-token', deviceToken: pendingToken });
      const pendingStatus = await pending.waitForType('device_status');
      assert.equal(pendingStatus.payload.status, 'pending', '新设备应处于待审批态');

      // 已批准：走 127.0.0.1（isLocal=true，直接 approved，绕过 TOFU）——触发连接后 300ms 的 status_line 广播
      const approved = connectAndCollect(`http://127.0.0.1:${port}`, { token: 'secret-token' });
      const approvedStatusLine = await approved.waitForType('status_line', 3000);
      assert.ok(approvedStatusLine, 'approved socket 应正常收到 status_line 广播');

      // 给 pending socket 足够时间去（错误地）接收同一次广播
      await sleep(800);

      const leaked = pending.events.filter(e => e.type !== 'device_status');
      assert.deepEqual(leaked, [], `待审批 socket 不应收到除 device_status 外的任何事件，实际泄露：${JSON.stringify(leaked.map(e => e.type))}`);

      pending.socket.disconnect();
      approved.socket.disconnect();
    });
  },
);
