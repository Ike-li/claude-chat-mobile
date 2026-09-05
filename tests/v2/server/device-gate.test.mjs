// tests/v2/server/device-gate.test.mjs —— 设备审批门在真组装根上的第二因子
// 守护：DEVICE-01（bypass 必须 peer 本机【且】Host 本机；否则未审批设备不得进入数据面）、
//       SEC-01（未审批 socket 不加入 approved 房间，收不到任何会话内容广播）
// 覆盖：本机直连 bypass + 非本机 Host 落待审 + 待审设备只收自身状态
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR）
//
// 不测什么 + 为什么：
//  ① 空 Host 不视为本机（R8）—— socket.io-client 与 fetch 都必带 Host 头，从客户端侧构造不出来；
//     那是 shouldBypassDeviceApproval 的纯函数分支，已在 tests/v2/device-gate.test.mjs（S1）覆盖。
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
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'v2-device-gate-token';

let dir, server;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-v2-device-'));
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIR: dir, CCM_DATA_DIR: dir });
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
