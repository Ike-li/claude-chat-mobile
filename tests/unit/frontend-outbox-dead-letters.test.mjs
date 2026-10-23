// tests/unit/frontend-outbox-dead-letters.test.mjs —— 永久拒收、此刻又没地方交还原文的离线条目（PR #232 review）
//
// 重载页面后恢复出来的 outbox 条目没有气泡；它若发往不在眼前的会话、又被服务端永久拒收，提示没有落点，
// outbox 已清，用户打的字就没了。这里暂存它（落盘，活过重载），回到它的会话时再交还；交还之前别的会话看不见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxDeadLetters } from '../../app/public/js/app/outbox-dead-letters.js';
import { outboxItemTargetsViewing } from '../../app/public/js/logic.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}
const A = { viewingInstanceId: 'inst_1', viewingCwd: '/w', viewingSessionId: 'sid-a' };
const B = { viewingInstanceId: 'inst_2', viewingCwd: '/w', viewingSessionId: 'sid-b' };
const itemForA = { instanceId: 'inst_1', sessionId: 'sid-a', cwd: '/w', text: '发往 A 的那条', clientMessageId: 'c1' };

test('暂存后只交给它自己的会话：别的会话拿不到，拿走一次就没了', () => {
  const box = createOutboxDeadLetters({ storage: memoryStorage(), targetsViewing: outboxItemTargetsViewing });
  box.park(itemForA, '⚠️ 会话已删除，已停止重试');
  assert.deepEqual(box.takeFor(B), [], '交到别的会话上，就是把 A 的失败打到 B 上');
  const got = box.takeFor(A);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '发往 A 的那条');
  assert.equal(got[0].message, '⚠️ 会话已删除，已停止重试');
  assert.equal(got[0].instanceId, 'inst_1');
  assert.deepEqual(box.takeFor(A), [], '交还过一次就不再留着');
});

test('回不去的条目（升级前入队，只剩实例号、没有会话号）：落到哪个会话就在哪个会话交出来（验收 O135）', () => {
  // 升级重启后那个实例号不复用，按会话认、按实例号认都等不到它；只等「它自己的会话」就是永远交不出去
  const box = createOutboxDeadLetters({ storage: memoryStorage(), targetsViewing: outboxItemTargetsViewing });
  box.park({ instanceId: 'inst_9', cwd: '/w', text: '升级前离线打的那条' }, '⚠️ 离线时发的一条消息没有发出：目标会话已关闭');
  box.park(itemForA, '已停止重试');
  assert.deepEqual(box.takeFor(B).map(d => d.text), ['升级前离线打的那条'], '能交还的 A 那条仍只交给 A');
  assert.deepEqual(box.takeFor(B), [], '交出来一次就不再留着');
  assert.deepEqual(box.takeFor(A).map(d => d.text), ['发往 A 的那条']);
});

test('落盘：重载页面（新建实例、同一份 storage）后仍在', () => {
  const storage = memoryStorage();
  createOutboxDeadLetters({ storage, targetsViewing: outboxItemTargetsViewing }).park(itemForA, '已停止重试');
  const reloaded = createOutboxDeadLetters({ storage, targetsViewing: outboxItemTargetsViewing });
  assert.equal(reloaded.takeFor(A)[0]?.text, '发往 A 的那条');
  assert.deepEqual(createOutboxDeadLetters({ storage, targetsViewing: outboxItemTargetsViewing }).takeFor(A), [], '拿走之后落盘也跟着清掉');
});

test('有上限：超出时丢最旧的；storage 读写抛错时退回内存，不往外抛', () => {
  const box = createOutboxDeadLetters({ storage: memoryStorage(), targetsViewing: outboxItemTargetsViewing, max: 2 });
  for (const n of [1, 2, 3]) box.park({ ...itemForA, text: `第 ${n} 条` }, 'x');
  assert.deepEqual(box.takeFor(A).map(d => d.text), ['第 2 条', '第 3 条']);

  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  const mem = createOutboxDeadLetters({ storage: broken, targetsViewing: outboxItemTargetsViewing });
  mem.park(itemForA, 'x');
  assert.equal(mem.takeFor(A).length, 1);
});
