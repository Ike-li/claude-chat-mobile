// tests/invariants/server/device-gate.test.mjs —— 设备审批门在真组装根上的第二因子
// 守护：DEVICE-01（bypass 必须 peer 本机【且】Host 本机；否则未审批设备不得进入数据面）、SEC-01（未审批 socket 不加入 approved 房间，收不到任何会话内容广播）
// 覆盖：本机直连 bypass + 非本机 Host 落待审 + 待审设备只收自身状态
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR）
//
// 不测什么 + 为什么：
//  ① 空 Host 不视为本机（R8，2026-08-06）—— socket.io-client 与 fetch 都必带 Host 头，从客户端侧构造不出来；
//     那是 shouldBypassDeviceApproval 的纯函数分支，已在 tests/invariants/device-gate.test.mjs（S1）覆盖。
//  ② 吊销后已连连接失权 —— 依赖 trusted-devices.json 的文件监听与 macOS/Linux 的 watch 差异
//     （SEC-03 修过的坑），需要等待窗口，属另开的用例；本文件只钉「进不进得来」。
//  ③ 推送正文不含设备 ID（DEVICE-03）—— 那是 notifications 的 body 构造，属 S1。
//     注意 device_status 事件【本身】带 deviceId 是正确的：那是服务端告诉这台设备它自己的状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-device-gate-token';

let dir, server;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-inv-device-'));
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: dir, CCM_DATA_DIR: dir });
});
test.after(async () => {
  if (server) await killServer(server.proc);
  if (dir) rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

// 连一台客户端，收集 2 秒内收到的 agent:event，然后断开。
// hostHeader 决定走不走 bypass 分支——这正是 DEVICE-01 要区分的两条路。
function collectEvents(hostHeader, { deviceToken = randomUUID(), waitMs = 1500 } = {}) {
  return new Promise(resolve => {
    const events = [];
    const sock = ioClient(`http://127.0.0.1:${server.port}`, {
      auth: { token: TOKEN, deviceToken },
      transports: ['websocket'],
      reconnection: false,
      timeout: 4000,
      extraHeaders: { Host: hostHeader },
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* 已关闭 */ }
      resolve(events);
    };
    sock.on('agent:event', e => events.push(e));
    sock.on('connect', () => setTimeout(done, waitMs));
    sock.on('connect_error', () => done());
    setTimeout(done, waitMs + 4000);
  });
}

const typesOf = events => events.map(e => e.type);

test('非本机 Host：不得 bypass，设备落待审并收到自身 pending 状态', async () => {
  // 反代/隧道终止后 peer 常是 127.0.0.1，但 Host 是公网域名。只看 peer 会把
  // 「拿到 AUTH_TOKEN 的远程客户端」当成已通过设备审批——一层防护整个失效。
  const events = await collectEvents('chat.example.com');
  const types = typesOf(events);
  assert.ok(types.includes('device_status'),
    `非本机 Host 必须落待审并收到 device_status，实际收到：${JSON.stringify(types)}`);
  const status = events.find(e => e.type === 'device_status');
  assert.equal(status.payload.status, 'pending');
});

test('待审设备不加入 approved 房间：收不到任何会话内容广播', async () => {
  const events = await collectEvents('chat.example.com');
  const types = new Set(typesOf(events));
  // SEC-01：敏感广播一律 io.to('approved').emit，待审 socket 不在房里。
  for (const sensitive of ['init', 'models', 'assistant', 'result', 'tool_use', 'history_append']) {
    assert.ok(!types.has(sensitive),
      `待审设备收到了敏感事件 ${sensitive}——它不该在 approved 房间里`);
  }
});

test('本机 Host + 本机 peer：bypass 生效，不落待审', async () => {
  const events = await collectEvents('localhost');
  const pending = events.filter(e => e.type === 'device_status' && e.payload?.status === 'pending');
  assert.equal(pending.length, 0,
    '真·本机直连是设备审批的合法 bypass，否则本机自己用还要先批一次自己');
});

test('127.0.0.1 与 localhost 等价（同一条本机判据的两种写法）', async () => {
  const events = await collectEvents('127.0.0.1');
  const pending = events.filter(e => e.type === 'device_status' && e.payload?.status === 'pending');
  assert.equal(pending.length, 0);
});

test('带端口的本机 Host 仍算本机（判据取冒号前那段）', async () => {
  const events = await collectEvents(`localhost:${server.port}`);
  const pending = events.filter(e => e.type === 'device_status' && e.payload?.status === 'pending');
  assert.equal(pending.length, 0, 'Host 头带端口是常态，不能因此把本机判成远程');
});

// 2026-09-06 容器演练：反代（TRUSTED_PROXY=loopback，nginx 追加 XFF）后待审设备卡片上的 IP 恒 127.0.0.1——
// 卡片取的是 peer，限速桶却按 XFF 末跳，同一个来源两处各答一份。接线修成同一份判据后，这里在真组装根上钉住：
// 声明了 TRUSTED_PROXY 且 peer 是 loopback（本测试客户端就是）→ 卡片记 XFF 末跳；未声明 → 仍记 peer（不采信客户端可写的头）。
// 观察面用产品自己的 `node scripts/device.js list --json`：那是维护者「核对再批」时真正看到的东西。
test.describe('待审设备卡片的来源 IP 与限速桶同一份判据（AUTH-04 × DEVICE-01）', () => {
  const ROOT = join(import.meta.dirname, '..', '..', '..');
  const XFF = '203.0.113.9, 198.51.100.7';
  let pdir, pserver;

  test.before(async () => {
    pdir = mkdtempSync(join(tmpdir(), 'ccm-inv-device-xff-'));
    pserver = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: pdir, CCM_DATA_DIR: pdir, TRUSTED_PROXY: 'loopback' });
  });
  test.after(async () => {
    if (pserver) await killServer(pserver.proc);
    if (pdir) rmSync(pdir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  });

  function connectOnce(port, deviceToken) {
    return new Promise((resolve) => {
      const sock = ioClient(`http://127.0.0.1:${port}`, {
        auth: { token: TOKEN, deviceToken },
        transports: ['websocket'],
        reconnection: false,
        timeout: 4000,
        extraHeaders: { Host: 'ccm.proxy.test', 'X-Forwarded-For': XFF },
      });
      const done = () => { try { sock.close(); } catch { /* 已关闭 */ } resolve(); };
      sock.on('connect', () => setTimeout(done, 800));
      sock.on('connect_error', done);
      setTimeout(done, 5000);
    });
  }

  function pendingIpOf(dataDir, deviceToken) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'device.js'), 'list', '--json'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, CCM_DATA_DIR: dataDir },
    });
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(r.stdout).pending.find((p) => p.deviceId === deviceToken);
    assert.ok(rec, '设备没进待审列表，用例前提不成立');
    return rec.ip;
  }

  test('TRUSTED_PROXY=loopback：卡片记 XFF 末跳（反代追加的那一跳），不是首跳、不是 peer', async () => {
    const token = randomUUID();
    await connectOnce(pserver.port, token);
    assert.equal(pendingIpOf(pdir, token), '198.51.100.7', '反代后卡片仍给不出真实来源，「核对再批」无从核对');
  });

  test('未声明 TRUSTED_PROXY：同样的 XFF 不采信，卡片记 peer', async () => {
    const token = randomUUID();
    await connectOnce(server.port, token);
    assert.equal(pendingIpOf(dir, token), '127.0.0.1', '未声明可信反代却采信了客户端可写的 XFF');
  });
});
