// tests/integration/new-session-compose-routing.test.mjs —— 新会话页的首发开新会话，不落进别人的会话
//
// 形态（验收 O107）：服务端 viewingInstanceId 是全局单值（AD-5）。设备 B 停在新会话页时发第一条消息，
// 消息不带 instanceId，resolveInstanceTarget 回退「当前查看实例」——那可能是设备 A 刚开、正在看的会话，
// B 的话于是进了 A 的会话。修复：新会话页每次发送都带上它的 composeId（每个新会话页一枚），服务端据此
// 开新会话，不回退全局 viewing、不续项目的「当前会话」指针；同一页面的后续消息按 composeId 落回它自己
// 开出来的那个实例。
//
// 不测什么：多设备共享一份视图本身（AD-5，已决不做）；前端什么时候带 composeId 由 E2E/单测管，
// 这里只证明服务端收到它之后的路由。
// 执行位守卫：必须是第一条 import。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';

const TOKEN = 'int-compose-routing-token';

test('新会话页带 composeId 的首发开新会话；同一页面的下一条回到它自己开的实例', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-int-compose-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);

  // turn 档：回合会收尾，实例回到空闲——否则第二条消息被「当前任务运行中」挡下，看不出它路由去了哪
  const server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: repo, CCM_DATA_DIR: join(root, 'data'), CCM_FAKE_CLAUDE_MODE: 'turn' });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'int-compose-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  const turnDone = (instanceId, label) => waitForCondition(
    () => events.some(e => e.type === 'result' && e.instanceId === instanceId), { timeoutMs: 10_000, label });
  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const emit = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 20000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });

    // 设备 A：新会话页发第一条，开出实例 X，服务端 viewing = X
    await emit('session:new', { cwd: repo });
    const a = await emit('user:message', { text: 'A 的会话', cwd: repo, composeId: 'page-a', clientMessageId: 'compose-a1' });
    assert.equal(a?.ok, true, `A 的首发应被接受：${JSON.stringify(a)}`);
    assert.ok(a.instanceId, '前提：A 的首发懒开出实例');
    await turnDone(a.instanceId, 'A 的回合收尾');

    // 设备 B：停在自己的新会话页（前端 viewing 为空，不带 instanceId），服务端全局 viewing 仍是 X
    const b = await emit('user:message', { text: 'B 在新会话页', cwd: repo, composeId: 'page-b', clientMessageId: 'compose-b1' });
    assert.equal(b?.ok, true, `B 的首发应被接受：${JSON.stringify(b)}`);
    assert.notEqual(b.instanceId, a.instanceId, 'B 的第一条落进了 A 的会话——回退了全局 viewing');
    await turnDone(b.instanceId, 'B 的回合收尾');

    // 全局 viewing 被 A 切回 X 之后，B 那一页（广播还没到、或离线重放）再发一条：仍回到 B 自己开的实例
    sock.emit('user:setViewing', { instanceId: a.instanceId });
    const b2 = await emit('user:message', { text: 'B 的第二条', cwd: repo, composeId: 'page-b', clientMessageId: 'compose-b2' });
    assert.equal(b2?.ok, true, `B 的第二条应被接受：${JSON.stringify(b2)}`);
    assert.equal(b2.instanceId, b.instanceId, '同一个新会话页的第二条没回到它自己开的实例');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
