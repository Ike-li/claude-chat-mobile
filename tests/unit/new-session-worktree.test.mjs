// tests/unit/new-session-worktree.test.mjs —— 新会话「在新 worktree 里开」的分支列表缓存
//
// 【为什么在 unit/ 而不是 invariants/】切工作区的分支竞态不在 tests/README.md 的编号表里：
// 它不伤数据也不破安全边界，代价是「在 B 里按 A 的分支建了一棵 worktree」。按 docs/testing.md
// 判断一，查不到编号就进 unit/ 且不写「守护：」行。
//
// 【测的是什么】ensureBranches 里有一个 await：请求发给 cwd，而返回时 loadedFor 可能已经指向
// 别处。原实现 await 之后无条件写入 branches/currentBranch，于是：
//   ① A 的迟到响应盖掉 B 已经加载好的列表——而 B 的列表看起来完全正常，没有任何迹象说明它是 A 的；
//   ② B 加载期间屏幕上还留着 A 的 currentBranch，这时发第一条消息就拿 A 的分支去 B 建 worktree。
// 两条都要钉：只修其中一条，另一条照样能让人在错的分支上开工。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewSessionWorktree } from '../../app/public/js/app/new-session-worktree.js';

// 手动掌控 ack 到达顺序的假 socket。ackTimeoutMs 传 1：真 timer 会让整个文件空等 4 秒。
function harness() {
  const sent = [];
  const context = { socket: { emit: (ev, payload, cb) => sent.push({ ev, payload, cb }) } };
  return { wt: createNewSessionWorktree(context, { ackTimeoutMs: 1 }), sent };
}

const okBranches = (list, current) => ({ ok: true, branches: list, current });

test.describe('ensureBranches：切工作区时的竞态', () => {
  test('A 的响应比 B 晚到 → 丢弃，不得盖掉 B 的列表', async () => {
    const { wt, sent } = harness();
    const pA = wt.ensureBranches('/repo/a');
    const pB = wt.ensureBranches('/repo/b');
    assert.equal(sent.length, 2, '两个工作区各发一次请求');

    sent[1].cb(okBranches(['b-main', 'b-dev'], 'b-main')); // B 先回
    await pB;
    sent[0].cb(okBranches(['a-main'], 'a-main'));          // A 迟到
    await pA;

    const s = wt.snapshot();
    assert.equal(s.currentBranch, 'b-main', 'A 的迟到响应盖掉了 B —— 会拿 A 的分支去 B 建 worktree');
    assert.deepEqual(s.branches, ['b-main', 'b-dev']);
  });

  test('切到 B 之后、B 返回之前，不得还显示 A 的当前分支', async () => {
    const { wt, sent } = harness();
    const pA = wt.ensureBranches('/repo/a');
    sent[0].cb(okBranches(['a-main'], 'a-main'));
    await pA;
    assert.equal(wt.snapshot().currentBranch, 'a-main');

    const pB = wt.ensureBranches('/repo/b'); // 还没回
    assert.equal(wt.snapshot().currentBranch, null,
      'B 加载期间仍显示 A 的分支 —— 此刻发第一条消息就会用 A 的分支名去 B 建树');
    assert.deepEqual(wt.snapshot().branches, []);

    sent[1].cb(okBranches(['b-main'], 'b-main'));
    await pB;
    assert.equal(wt.snapshot().currentBranch, 'b-main');
  });

  test('同一个 cwd 重复调用只发一次请求（缓存语义不变）', async () => {
    const { wt, sent } = harness();
    const p = wt.ensureBranches('/repo/a');
    sent[0].cb(okBranches(['a-main'], 'a-main'));
    await p;
    await wt.ensureBranches('/repo/a');
    assert.equal(sent.length, 1);
  });

  test('迟到的失败响应同样不得写进 loadError（否则 B 上会挂着 A 的错）', async () => {
    const { wt, sent } = harness();
    const pA = wt.ensureBranches('/repo/a');
    const pB = wt.ensureBranches('/repo/b');
    sent[1].cb(okBranches(['b-main'], 'b-main'));
    await pB;
    sent[0].cb({ ok: false, error: 'A 仓炸了' });
    await pA;

    const s = wt.snapshot();
    assert.equal(s.loadError, null, 'B 上显示了 A 的错误');
    assert.equal(s.currentBranch, 'b-main');
  });
});
