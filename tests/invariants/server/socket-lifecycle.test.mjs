// tests/invariants/server/socket-lifecycle.test.mjs —— 连接生命周期与 Agent 生命周期是两件事
// 守护：SOCKET-01（socket 断开不得杀 Agent：任务独立于连接存活；断开也不得产生任何对外广播副作用）
// 覆盖：驾驶 socket 断开后实例仍在且 turnRunning + 断开不惊动其他在线 socket + 断开后在途轮仍占着槽（busy 为独立证据）
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR；CLAUDE_BIN 走 stub，无真 turn）
//
// ★ 方案原判「SOCKET-01 在 S2 做不到，需要能驱动 agent turn 的假 CLI」——2026-09-05 实测推翻。
//   这条不变量要证的是【服务端状态在断开前后没变】，而那份状态（agents 表 / pendingTurns）
//   不依赖 CLI 产出任何东西。stub 不吐 result 反而把条件变强了：轮次永远停在「运行中」，
//   于是「断开后它还在跑吗」这个问题有了一个持续存在的观察对象。
//
// 为什么要三个独立信号，而不是只看一眼 instances 快照：
//   快照是服务端自己算出来发的。一个「把 agent 杀了但快照条目还留着」的实现能让单看快照的断言全绿。
//   所以另外两个信号必须来自别的通道——广播副作用（断开是否惊动别人）与 busy 拒绝
//   （pendingTurns 是否还占着，那是 agent 实例上的活字段，agent 没了就归零）。
//
// 不测什么 + 为什么：
//  ① 断线重连后的历史回放 —— 属回放机制（SYNC-01），与「断开杀不杀 agent」是两条不变量。
//     实测裸连收不到 user_message 回放、session:open 无 ack，入口尚未查清；查清前写它必定是假绿。
//  ② IDLE_TIMEOUT 到点回收实例 —— 那是【该】被回收的路径，与本文件方向相反，另开用例。
//  ③ 设备被吊销时的强制断连（disconnectDeviceSockets）—— 归 device-gate.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-socket-lifecycle-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let dir, server;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-inv-socket-'));
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIR: dir, CCM_DATA_DIR: dir });
});
test.after(async () => {
  if (server) await killServer(server.proc);
  if (dir) rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

// 每条连接用不同 deviceToken：同一台 server 上并存多条，互不借用对方的设备身份。
async function connect(tag) {
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: `inv-socket-${tag}` },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连：bypass 设备门，本文件只测连接生命周期
  });
  sock.on('agent:event', e => events.push(e));
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error(`socket ${tag} 未能在 5s 内连上`)), 5000);
  });
  const send = payload => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag} 的 user:message ack 超时`)), 8000);
    sock.emit('user:message', payload, res => { clearTimeout(timer); resolve(res); });
  });
  return { sock, events, send, tag };
}

const lastInstances = c => c.events.filter(e => e.type === 'instances').pop()?.payload;
const instanceOf = (c, id) => (lastInstances(c)?.instances ?? []).find(i => i.instanceId === id);

// 全文件共用一个实例：由 driver 开出、driver 断开、再由旁观者与后来者分别检查。
// 顺序耦合是有意的——SOCKET-01 讲的就是「同一个 agent 跨越一次断开」这条时间线。
let instanceId;
let bystander;          // 全程在线，用来观察断开有没有溅出副作用
let bystanderBaseline;  // driver 断开【前】bystander 收到的事件条数

test('前置：driver 开出一个实例并留下在途轮；bystander 同步看得见', async () => {
  bystander = await connect('bystander');
  const driver = await connect('driver');

  const ack = await driver.send({ text: '开一轮，stub 不会回 result，于是它一直跑着', clientMessageId: 'sl-1' });
  assert.equal(ack.ok, true, `首发应被接受，实际 ${JSON.stringify(ack)}`);
  instanceId = ack.instanceId;
  assert.ok(instanceId, 'ack 必须带回落点实例');

  await sleep(300);
  assert.ok(bystander.events.some(e => e.type === 'user_message'),
    '同房间的另一条连接应同步收到气泡广播——这是后面「断开不再溅出事件」的对照组');

  // driver 就此退场。断开【不带】任何显式清理指令：SOCKET-01 要证的正是「服务端自己别多事」。
  bystanderBaseline = bystander.events.length;
  driver.sock.disconnect();
  await sleep(500);
});

// ⚠ 这条必须紧跟前置、排在任何新连接【之前】：后面的用例会各连一条 socket，
// 而新连接本身就会引发一批广播，混进来就把「断开有没有溅出事件」这个观察污染掉了。
test('SOCKET-01：断开不惊动其他在线连接（零副作用广播）', () => {
  // 断开若触发了 agent 回收、实例表变更或状态重算，都会以广播的形式在这里露出来。
  // 只列黑名单（不含 result/error）是不够的：disposeInstance 溅出的是 instances 变更，
  // 那既不是 result 也不是 error，黑名单式断言对它全绿（2026-09-05 注入实测确认）。
  const spilled = bystander.events.slice(bystanderBaseline).map(e => e.type);
  assert.deepEqual(spilled, [],
    `别人断开连接这件事，不该让本连接收到任何东西，实际溅出：${JSON.stringify(spilled)}`);
  assert.equal(bystander.sock.connected, true, '别人的连接不该被牵连');
});

test('SOCKET-01：驾驶者断开后，实例仍在且轮次仍在跑', async () => {
  const later = await connect('later');
  await sleep(500);
  const inst = instanceOf(later, instanceId);
  assert.ok(inst, `断开后实例应仍在，实际 instances=${JSON.stringify(lastInstances(later)?.instances)}`);
  assert.equal(inst.turnRunning, true,
    '轮次必须还在跑：手机锁屏/切 app 会断连，若那时任务被杀，用户回来看到的是一次凭空消失的执行');
  assert.equal(inst.state, 'busy');
  later.sock.close();
});

test('SOCKET-01：在途轮仍占着槽——新连接来发消息会被 busy 挡下', async () => {
  // 这是独立于 instances 快照的第二个证据源。busy 判据读的是 AgentSession.pendingTurns，
  // 那是 agent 实例上的活字段；agent 若已被回收，这里拿到的不会是 busy
  // （要么开出一个新实例返回 ok，要么找不到实例报错）。
  const newcomer = await connect('newcomer');
  await sleep(300);
  const ack = await newcomer.send({ text: '想插一条', clientMessageId: 'sl-2' });
  assert.equal(ack.busy, true,
    `在途轮应仍占着槽，实际 ${JSON.stringify(ack)}——不是 busy 就说明那个 agent 已经不在了`);
  assert.equal(ack.ok, false);
  newcomer.sock.close();
  bystander.sock.close();
});
