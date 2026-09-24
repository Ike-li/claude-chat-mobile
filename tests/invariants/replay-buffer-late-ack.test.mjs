// tests/invariants/replay-buffer-late-ack.test.mjs —— 回放 ack 晚于超时兜底时，缓冲里的事件不得被丢掉
// 守护：SYNC-01（重连用 sync:since 补缺口：ack 迟到时缓冲的事件要么按序派发、要么由 ack 路径重载历史，不得只推进基线就丢掉）
// 测什么：超时判 reload 时事件留在缓冲里、基线不动；迟到的 ack 判 flush 照样按序派发；ack 始终不来时 deferMs 到期按 flush 渲染
// 不测什么 + 为什么：① 判 reload 之后调用方真的清屏重载历史——那在 app.js 的 ack 回调里，归 E2E P0-REPLAY-SLOWACK
//         ② 缓冲本身的 OOB 旁路与 discard——模块行为不是这条红线，归 tests/unit/frontend-app-modules.test.mjs
// 槽位：S1（纯函数 + 真定时器）
//
// 【缺陷的真实形态】2026-09-22 review P2：超时兜底判 reload 时只推进基线，重载历史的动作却在调用方的 ack 回调里，
// 超时路径上没人去做。弱网下 ack 晚于 3 秒、缓冲过百条，屏幕上直接缺一段；迟到的 ack 又因 handle 已被顶替成了空操作。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplayBuffer } from '../../app/public/js/app/event-dispatch.js';

// begin() 会挂真实定时器，必须在用例结束时 discard，否则进程要等它烧完才退出（见单测同名 helper 的注释）。
function makeBuffer(t, opts = {}) {
  const dispatched = [];
  let seq = 0;
  const buf = createReplayBuffer({
    dispatch: (e) => dispatched.push(e),
    scrollBottom: () => {},
    withScrollSuppressed: (fn) => fn(),
    setSeq: (v) => { seq = v; },
    setEpoch: () => {},
    timeoutMs: opts.timeoutMs ?? 50,
    deferMs: opts.deferMs ?? 60_000,
    decideTimeoutAction: opts.decideTimeoutAction,
  });
  t.after(() => buf.discard());
  return { buf, dispatched, getSeq: () => seq };
}

test('SYNC-01：超时判 reload 不派发、也不自行丢队列推进基线——事件留给 ack 路径收尾', async (t) => {
  const { buf, dispatched, getSeq } = makeBuffer(t, {
    timeoutMs: 20,
    decideTimeoutAction: ({ bufferedCount }) => (bufferedCount >= 2 ? 'reload' : 'flush'),
  });
  const h = buf.begin('inst-1');
  buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 });
  buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 2 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(dispatched, [], '超阈值不逐条 dispatch（那正是回放缓冲要防的打字机）');
  assert.equal(getSeq(), 0, '基线一推进，这批事件就再也不会被回放——没人去重载时屏幕上就缺一段');
  assert.equal(buf.bufferedCount('inst-1'), 2, '事件留在缓冲里，等 ack 按它的判定收尾');
  // ack 到了、判 reload：这时才丢队列推进基线（调用方随即清屏重载历史）
  buf.resolve(h, 'reload');
  assert.equal(getSeq(), 2);
  assert.deepEqual(dispatched, []);
});

test('SYNC-01：超时判 reload 之后 ack 才到、判 flush（比如该实例正忙）→ 照样按序派发，一条不丢', async (t) => {
  const { buf, dispatched } = makeBuffer(t, { timeoutMs: 20, decideTimeoutAction: () => 'reload' });
  const h = buf.begin('inst-1');
  buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 });
  await new Promise((r) => setTimeout(r, 50));
  // 超时之后、ack 之前到的实时事件同样排在队里，保序
  assert.equal(buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 2 }), true);
  buf.resolve(h, 'flush');
  assert.deepEqual(dispatched.map(e => e.seq), [1, 2], '迟到的 ack 不能是空操作：旧实现在这里一条都不派发');
});

test('SYNC-01：超时判 reload 后 ack 始终没来收尾（回调抛错等）→ deferMs 到期按 flush 渲染，不永久扣住事件', async (t) => {
  const { buf, dispatched } = makeBuffer(t, { timeoutMs: 20, deferMs: 30, decideTimeoutAction: () => 'reload' });
  buf.begin('inst-1');
  buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(dispatched.map(e => e.seq), [1], '宁可晚一点渲染，也不能让这个实例之后的事件一直被扣着');
  assert.equal(buf.bufferedCount('inst-1'), 0);
});
