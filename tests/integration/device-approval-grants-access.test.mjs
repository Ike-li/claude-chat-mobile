// tests/integration/device-approval-grants-access.test.mjs —— 审批之后"真的能用"
//
// 补两条缺口（2026-08-18 审计）：
//
// ① 审批链路此前所有测试都停在「门开了」——收到 device_status:approved、连接没断——却没有
//    任何一条验证「门后能走路」。unlockSocket 除了置 deviceApproved 还要 join('approved')
//    并重放初始态；那一步要是坏了，设备会停在"显示已批准、却什么都干不了"的状态里，
//    而现有测试全部照绿。
//
// ② CLI 审批此前只测到底层 devices.js#approveDevice，`scripts/device.js` 这个命令行本身
//    （参数校验、退出码、写进哪个文件）一行没测。这里直接 spawn 真实 CLI 进程，覆盖那一层。
//
// 「能用」的判据选 session:history：它是"读会话内容"，正是待审设备不该能做、批准后应该能做
// 的事，且对不存在的 sessionId 只回 {messages:[], error:'会话不存在'}——无副作用、零 token、
// 不 spawn claude，因此这条测试能进 CI 常跑，而不是躺在 RUN_CLAUDE_INTEGRATION 后面默认跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { waitForServerReady } from './_spawn-server.mjs';

const REPO = join(import.meta.dirname, '..', '..');
let port, dataDir, httpServer, io;

// 收 ntfy 投递的本地假端点。ntfy 通道的 fetch 是 server 启动时固化的，注入不进 mock——
// 但它打的是普通 HTTP，起一个真端点比改生产代码的可测试性划算得多，顺带把 ntfyRequestInit
// 的 body 编码也一并验了（真实序列化，不是对着纯函数自说自话）。
let ntfyServer = null;
const ntfyHits = [];

async function startNtfyMock() {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      ntfyHits.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"mock"}');
    });
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  ntfyServer = srv;
  return `http://127.0.0.1:${srv.address().port}`;
}

async function waitFor(cond, timeout = 3000, label = '条件') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`超时未满足：${label}`);
}

// 走真实 LAN 网卡 IP 才会落进 TOFU 分支：127.0.0.1 + 本机 Host 会被 shouldBypassDeviceApproval
// 直接放行（trustBasis='bypass'），整道审批根本不发生，测了个寂寞。
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

async function startServer(authToken = 'grant-secret') {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-device-grant-test-'));
  // 清掉可能从外部继承的隔离变量，尤其 CCM_*_DEVICES_FILE：单测 preload 会把它们指向共享目录，
  // 那会让 server 和下面 spawn 的 CLI 读到两份不同的信任表，测出来的"批准生效"是假的。
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CCM_TRUSTED_DEVICES_FILE', 'CCM_PENDING_DEVICES_FILE', 'WEB_STATUSLINE',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = authToken;
  // 打开 ntfy 通道（notify-channels 的 ntfyEnabled = NTFY_URL && NTFY_TOPIC），指向本地假端点。
  // 没有它的话，设备审批推送那段接线在测试里会因 !ntfyEnabled 直接 return，等于没验。
  process.env.NTFY_URL = await startNtfyMock();
  process.env.NTFY_TOPIC = 'ccm-device-approval-test';

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await waitForServerReady(port, authToken);
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (ntfyServer) { ntfyServer.close(); ntfyServer = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

// 真实 CLI 进程——这条测试的一半价值就在于覆盖 scripts/device.js 本身，而不是它底下那个函数。
function runDeviceCli(args) {
  return spawnSync(process.execPath, [join(REPO, 'scripts', 'device.js'), ...args], {
    cwd: REPO,
    env: { ...process.env, CCM_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

function connectAndCollect(url, auth) {
  const socket = ioClient(url, { auth, transports: ['websocket'], reconnection: false });
  const events = [];
  let disconnected = false;
  socket.on('agent:event', envelope => events.push(envelope));
  socket.on('disconnect', () => { disconnected = true; });
  return {
    socket, events,
    get disconnected() { return disconnected; },
    waitForType(type, timeout = 5000, predicate = () => true) {
      return new Promise((resolve, reject) => {
        const existing = events.find(e => e.type === type && predicate(e));
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`超时未收到事件类型：${type}`)), timeout);
        const handler = envelope => {
          if (envelope.type === type && predicate(envelope)) {
            clearTimeout(timer); socket.off('agent:event', handler); resolve(envelope);
          }
        };
        socket.on('agent:event', handler);
      });
    },
  };
}

function emitWithAck(socket, event, payload, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 未收到 ack`)), timeout);
    socket.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
}

test.describe(
  '设备批准后真的能用（不只是收到 approved）',
  (LAN_IP ? {} : { skip: '本机无可用 LAN 网卡，无法真实触发 device-token 信任分支，跳过' }),
  () => {
    test.before(async () => { await startServer(); });
    test.after(async () => { await cleanup(); });

    // 这条必须【第一个】跑：设备审批推送有 5 分钟节流窗口，后面任何一条测试连上新设备都会
    // 把窗口消费掉，届时这里等到的将是空数组，而失败原因看起来会像"推送根本没接上"。
    test('新设备入列 → 推一条通知，且 ID/IP 都不在正文里（离线唤醒）', async () => {
      const token = `notify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const client = connectAndCollect(`http://${LAN_IP}:${port}`, { token: 'grant-secret', deviceToken: token });
      await client.waitForType('device_status', 5000, e => e.payload.status === 'pending');

      // 推送是 fire-and-forget（绝不阻断握手），所以要等它自己落地
      await waitFor(() => ntfyHits.length > 0, 3000, 'ntfy 收到设备审批通知');

      const hit = JSON.parse(ntfyHits[0]);
      assert.match(hit.title, /新设备请求接入/, `标题应说明发生了什么：${hit.title}`);
      assert.equal(hit.priority, 5, '与工具审批同级：不处理那台设备就一直用不了');
      assert.deepEqual(hit.tags, ['closed_lock_with_key']);

      // SEC-04：ntfy 明文经第三方，而 ID/IP 恰是审批要核对的东西——核对回 app 内做
      const dumped = JSON.stringify(hit);
      assert.ok(!dumped.includes(token), `通知不得含设备 ID：${dumped}`);
      assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(hit.message), `通知正文不得含 IP：${hit.message}`);

      client.socket.disconnect();
    });

    test('真实 CLI approve → socket 即时解锁、收到初始态重放、鉴权事件从被拒变可用', async () => {
      const token = `grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const client = connectAndCollect(`http://${LAN_IP}:${port}`, { token: 'grant-secret', deviceToken: token });

      // ① 新设备落进 TOFU 待审
      const pending = await client.waitForType('device_status', 5000, e => e.payload.status === 'pending');
      assert.equal(pending.payload.status, 'pending');

      // ② 批准【前】：鉴权事件被 on() 的闸挡下。这是"用不了"的精确形态——
      //    不是超时、不是静默丢弃，而是一个可断言的负 ack。
      const before = await emitWithAck(client.socket, 'session:history', { sessionId: 'no-such-session' });
      assert.equal(before?.error, 'device_not_approved', `待审设备不该能读历史，实际 ack：${JSON.stringify(before)}`);
      assert.equal(before?.permanent, true, '负 ack 须标 permanent，否则客户端离线队列会空转重试');

      // ③ 走【真实 CLI 进程】批准（不是 devices.js 里的函数）
      const cli = runDeviceCli(['approve', token]);
      assert.equal(cli.status, 0, `device.js approve 应成功退出，stderr=${cli.stderr}`);

      // ④ 门开了：server 靠 fs.watch 感知 trusted-devices.json 变更，无需重启也无需客户端重连
      const approved = await client.waitForType('device_status', 5000, e => e.payload.status === 'approved');
      assert.equal(approved.payload.status, 'approved');
      assert.equal(client.disconnected, false, '批准不该断开连接');

      // ⑤ 门后能走路（一）：unlockSocket 末尾无条件 instancesTo(socket)。收不到它就说明
      //    重放那半截没跑完——设备会卡在"已批准但界面空白"，而 ④ 依然是绿的。
      const instances = await client.waitForType('instances', 5000);
      assert.ok(instances, '批准后应收到重放的 instances');

      // ⑥ 门后能走路（二）：同一条 socket、同一个事件，现在应真正进到业务 handler。
      //    判据是"错在业务上"而不是"被闸挡下"：会话确实不存在，那是正确的业务答复。
      const after = await emitWithAck(client.socket, 'session:history', { sessionId: 'no-such-session' });
      assert.notEqual(after?.error, 'device_not_approved', `批准后不该再被鉴权闸拦，实际 ack：${JSON.stringify(after)}`);
      assert.deepEqual(after?.messages, [], '应拿到业务层的正常空结果');

      client.socket.disconnect();
    });

    test('CLI 拒绝不在待审列表的 ID → 非零退出且信任表不变（防打错 ID 静默放行）', async () => {
      const bogus = `never-requested-${Date.now()}`;
      const cli = runDeviceCli(['approve', bogus]);
      assert.equal(cli.status, 1, 'CLI 应拒绝批准一个从未申请过的 token');

      const listed = runDeviceCli(['list', '--json']);
      assert.equal(listed.status, 0, listed.stderr);
      const snap = JSON.parse(listed.stdout);
      assert.ok(!snap.trusted.includes(bogus), `未申请的 token 绝不能进信任表：${JSON.stringify(snap.trusted)}`);
    });
  },
);
