// tests/v2/server/unread-on-entry.test.mjs —— sync:since 必须把 live 未读算进 unreadOnEntry
// 守护：READ-01 邻域 —— PWA 切后台（socket 未断、presence 上报 hidden）期间累积的未读，
//       重连/切回时必须随 sync:since 的 ack 带回，否则聊天页的未读胶囊恒 0
// 覆盖：前台时 unreadOnEntry=0（没有未读）· 后台累积后 >0 · 非当前查看实例一律 0
// 槽位：S2（真 app/server.js 子进程 + 可驱动假 CLI）
//
// 【从哪来】2026-09-05 阶段 3：把源码文本断言换成行为断言。
// tests/unit/unread-tracker.test.mjs 里那条是 readFileSync(app.js) + 正则匹配
// /unreadOnEntryForSync/ 与 /live:\s*unreadCounts\.get/ —— 钉的是源码长什么样，
// 改个变量名无故变红，保持文本不变而改坏行为照样绿。
//
// 【为什么必须算 live】未读只在「实例是当前查看的【且】没有前台可见客户端」时累积
// （isInstanceBeingWatched）。PWA 切后台时 socket 不断、captureUnreadSnapshot 不会跑，
// 增量只落在 unreadCounts 这个活计数里。只回 snapshot 的话，那条路径上的胶囊恒 0——
// 而「人拿着手机出门、会话继续跑」正是本产品的主用例。
//
// 不测什么 + 为什么：
//  ① 判据纯函数 unreadOnEntryForSync 的分支（instanceId 不匹配、脏入参）已在
//     tests/unit/unread-tracker.test.mjs 逐条覆盖，本层只钉「接线有没有把 live 交进去」。
//  ② 前端胶囊怎么渲染 —— 属 S3。
//  ③ 跨设备已读位点合并（READ-01 本体）—— 归 tests/v2/read-state.test.mjs。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'v2-unread-entry-token';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('sync:since 的 unreadOnEntry 必须含后台期间累积的 live 未读', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-v2-unread-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIR: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'turn',                 // 回合会收尾，才发得出第二条
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
  });

  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'v2-unread-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));

  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const send = payload => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('user:message ack 超时')), 10000);
      sock.emit('user:message', payload, res => { clearTimeout(timer); resolve(res); });
    });
    const syncSince = payload => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sync:since ack 超时')), 10000);
      sock.emit('sync:since', payload, res => { clearTimeout(timer); resolve(res); });
    });
    const maxSeq = () => Math.max(0, ...events.filter(e => e.seq > 0).map(e => e.seq));

    // ① 前台跑一轮：客户端没上报过 hidden，保守按前台算 → 一条未读都不该攒。
    const first = await send({ text: '前台第一条', cwd, clientMessageId: 'un-1' });
    assert.equal(first.ok, true, `首发应被接受，实际 ${JSON.stringify(first)}`);
    await sleep(900);

    const foreground = await syncSince({ sessionId: SESSION_ID, instanceId: first.instanceId, lastSeq: 0 });
    assert.equal(foreground.found, true, 'sync:since 应找得到该实例');
    assert.equal(foreground.unreadOnEntry, 0, '有人在前台看着，不该攒未读');

    // ② 切后台：socket 不断，只上报 hidden。这正是 PWA 出门那条路径——
    //    captureUnreadSnapshot 不会跑，增量只落在 unreadCounts 活计数里。
    sock.emit('client:presence', { hidden: true });
    await sleep(300);

    // ③ 后台期间又跑一轮，产生对话事件。
    const second = await send({ text: '后台第二条', cwd, clientMessageId: 'un-2' });
    assert.equal(second.ok, true, `回合收尾后应能再发，实际 ${JSON.stringify(second)}`);
    await sleep(900);

    const background = await syncSince({
      sessionId: SESSION_ID, instanceId: first.instanceId, lastSeq: maxSeq(),
    });
    assert.ok(
      background.unreadOnEntry > 0,
      `后台累积的未读必须随 ack 带回，实际 ${background.unreadOnEntry}——`
      + '只回 snapshot 的话这里恒 0，手机切回来看不到未读胶囊',
    );

    // 第二信号：换一个不存在的实例 id，unreadOnEntry 必须是 0 且 found=false。
    // 未读只对「当前查看实例」有意义，别的实例的快照要么不存在要么陈旧，不该被误报出去。
    const other = await syncSince({ sessionId: SESSION_ID, instanceId: 'inst_不存在', lastSeq: 0 });
    assert.equal(other.found, false, '不存在的实例应 found=false');
    assert.equal(other.unreadOnEntry, 0, '非当前查看实例不得带出未读数');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
