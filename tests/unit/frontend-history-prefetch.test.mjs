// tests/unit/frontend-history-prefetch.test.mjs —— 点开非活会话时，历史和 session:switch 并行预取。
//
// 预取在点击那一刻发出，bindView 等 sync:since 回来才来取。中间用户可能又点了别的会话、同一个会话又开了
// 一次，或者视图绑到了另一个工作目录：取的时候必须凭同一次打开（perfTrace 的 open 对象）来认领，
// 别的打开拿不到这份，也不能把它的回执记到自己头上。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHistoryPrefetch } from '../../app/public/js/app/history-prefetch.js';

// socket.io 是外部边界：只记下发了什么，ack 由用例手动回
function fakeSocket() {
  const sent = [];
  return {
    sent,
    timeout(ms) {
      return { emit: (event, payload, ack) => sent.push({ ms, event, payload, ack }) };
    },
  };
}

const openA = { sid: 'A' };
const openB = { sid: 'B' };

test.describe('createHistoryPrefetch：凭打开凭据认领预取的历史', () => {
  test('start 立刻发出 session:history，带上预取标记和超时', () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: openA, sessionId: 'A', cwd: '/w' });
    assert.equal(socket.sent.length, 1);
    assert.deepEqual(
      { ms: socket.sent[0].ms, event: socket.sent[0].event, payload: socket.sent[0].payload },
      { ms: 15000, event: 'session:history', payload: { sessionId: 'A', cwd: '/w', prefetch: true } },
    );
  });

  test('同一次打开来取：拿到这次预取的回执（取的时候回执还没到也行）', async () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: openA, sessionId: 'A', cwd: '/w' });
    const settled = prefetch.take({ open: openA, sessionId: 'A', cwd: '/w' });
    assert.ok(settled, '凭据对得上应当拿到预取');
    const res = { messages: [{ role: 'user', text: 'hi' }], total: 1 };
    socket.sent[0].ack(null, res);
    assert.deepEqual(await settled, { err: null, res });
  });

  test('超时也交给取的人判断', async () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: openA, sessionId: 'A', cwd: '/w' });
    const err = new Error('operation has timed out');
    socket.sent[0].ack(err);
    const got = await prefetch.take({ open: openA, sessionId: 'A', cwd: '/w' });
    assert.equal(got.err, err);
  });

  test('只能取一次：第二次取（同一次打开里又绑了一遍视图）拿不到', () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: openA, sessionId: 'A', cwd: '/w' });
    assert.ok(prefetch.take({ open: openA, sessionId: 'A', cwd: '/w' }));
    assert.equal(prefetch.take({ open: openA, sessionId: 'A', cwd: '/w' }), null);
  });

  test('别的打开来取拿不到：A→B→A 时第二次打开 A 不能用第一次的预取', () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: openA, sessionId: 'A', cwd: '/w' });
    assert.equal(prefetch.take({ open: { sid: 'A' }, sessionId: 'A', cwd: '/w' }), null);
  });

  test('后点的会话顶掉先点的：先点的那次打开再来取拿不到', () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: openA, sessionId: 'A', cwd: '/w' });
    prefetch.start({ open: openB, sessionId: 'B', cwd: '/w' });
    assert.equal(prefetch.take({ open: openA, sessionId: 'A', cwd: '/w' }), null);
    assert.ok(prefetch.take({ open: openB, sessionId: 'B', cwd: '/w' }));
  });

  // 侧栏按行的 cwd 预取，视图绑过来时按实例的 transcriptCwd 拉：会话被搬迁过或在 worktree 里时两者不同，
  // 预取读的不是同一份 transcript，只能照常重新拉
  test('同一次打开但会话或目录对不上：拿不到，这份也作废', () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: openA, sessionId: 'A', cwd: '/w' });
    assert.equal(prefetch.take({ open: openA, sessionId: 'A', cwd: '/w/.claude/worktrees/x' }), null);
    assert.equal(prefetch.take({ open: openA, sessionId: 'A', cwd: '/w' }), null);
  });

  test('没有打开凭据或没有会话 id 就不发', () => {
    const socket = fakeSocket();
    const prefetch = createHistoryPrefetch({ socket, timeoutMs: 15000 });
    prefetch.start({ open: null, sessionId: 'A', cwd: '/w' });
    prefetch.start({ open: openA, sessionId: null, cwd: '/w' });
    assert.equal(socket.sent.length, 0);
  });
});
