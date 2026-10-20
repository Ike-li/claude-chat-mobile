// tests/unit/mock-transport.test.mjs —— E2E 假后端的就绪探针绑定
// 探针必须绑到【本轮 spawn 的 server】（nonce 匹配）——端口上残留的旧进程回 409，
// 否则 Playwright 会对着一个错误的进程跑完整套 P0 契约并给出假绿/假红。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMockTransport } from '../e2e/mock/transport.js';

test('visual mock transport readiness probe is bound to the current build nonce', async t => {
  const { httpServer } = createMockTransport({ buildNonce: 'test-build-nonce' });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => httpServer.close(resolve)));
  const { port } = httpServer.address();

  const ready = await fetch(`http://127.0.0.1:${port}/__ready?nonce=test-build-nonce`);
  const stale = await fetch(`http://127.0.0.1:${port}/__ready?nonce=another-build`);

  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, nonce: 'test-build-nonce' });
  assert.equal(stale.status, 409);
});

// 用例边界的时间泄漏：mock 一个进程顺序服务同一分片的全部用例，/__reset 只能复位模块状态，复位不了
// 已经在途的 async 尾巴。场景开头从上下文快照了 viewingInstanceId，睡几秒醒来再 io.emit——广播落到
// 【下一条用例】的新页面上，把它刚切过去的视图拽回 inst_1。P0-SYNC-ACK-TIMEOUT 的间歇红就是这个：
// 同片排在它前面的 RECAP-2 发了 test:tool（场景要跑 ~4.4s），用例 0.7s 就结束了。
// 闸放在 transport：客户端每个事件进来时记下当时的用例代数，emit 时代数已变就丢弃，各场景不必各自判断。
import { io as ioClient } from 'socket.io-client';

async function harness(t) {
  let generation = 0;
  const { httpServer, io } = createMockTransport({ caseGeneration: () => generation });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { io.close(); httpServer.close(resolve); }));
  // 场景的形状：收到客户端事件 → await 一段 → 单播 + 广播
  let tailDone;
  const tail = new Promise(resolve => { tailDone = resolve; });
  io.on('connection', socket => {
    socket.on('run-scenario', async ({ waitMs }) => {
      await new Promise(r => setTimeout(r, waitMs));
      socket.emit('agent:event', { type: 'text_delta', payload: { text: 'unicast' } });
      io.emit('agent:event', { type: 'text_delta', payload: { text: 'broadcast' } });
      tailDone();
    });
  });
  const { port } = httpServer.address();
  // mock 不放行无令牌握手（同真 server，见 transport.js 的 io.use）；握手被拒时立刻失败，不在这里干等
  const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, auth: { token: 'mock-transport-test' } });
  t.after(() => client.close());
  const received = [];
  client.on('agent:event', ev => received.push(ev.payload.text));
  await new Promise((resolve, reject) => { client.on('connect', resolve); client.on('connect_error', reject); });
  return { client, received, tail, nextCase: () => { generation += 1; } };
}

test('用例边界：上一条用例里还在睡的场景，醒来后的单播与广播都不得落到下一条用例', async t => {
  const { client, received, tail, nextCase } = await harness(t);
  client.emit('run-scenario', { waitMs: 150 });
  await new Promise(r => setTimeout(r, 30)); // 场景已开始、还在睡
  nextCase(); // /__reset：下一条用例开始
  await tail;
  await new Promise(r => setTimeout(r, 100)); // 给在途的帧留出到达时间
  assert.deepEqual(received, [], '过期尾巴发出的事件落到了新用例上');
});

test('同一条用例内的延迟事件照常送达（闸只认代数变化，不认延迟本身）', async t => {
  const { client, received, tail } = await harness(t);
  client.emit('run-scenario', { waitMs: 50 });
  await tail;
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(received.sort(), ['broadcast', 'unicast']);
});
