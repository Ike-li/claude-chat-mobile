// 验收 O66：离线重放撞上在途轮的条目排队，本轮结束按序自动续发（一轮一条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAfterTurnResend, findOutboxTargetInstance, sameOutboxTarget } from '../../app/public/js/logic.js';

const A = { instanceId: 'i1', sessionId: 's1' };
const B = { instanceId: 'i2', sessionId: 's2' };
const entry = (target, extra = {}) => ({ target, sawRunning: true, inFlight: false, ...extra });

test('本轮还在跑就不发；结束了放同一会话的队首，一轮一条', () => {
  const first = entry(A), second = entry(A);
  assert.equal(pickAfterTurnResend([first, second], [{ instanceId: 'i1', sessionId: 's1', turnRunning: true }]), null);
  assert.equal(pickAfterTurnResend([first, second], [{ instanceId: 'i1', sessionId: 's1', turnRunning: false }]), first);
  // 队首在发：同一会话后面的都等着
  assert.equal(pickAfterTurnResend([{ ...first, inFlight: true }, second], [{ instanceId: 'i1', sessionId: 's1' }]), null);
});

test('上一条发出后还没看到这一会话开跑，不算本轮结束（迟到的旧广播不能把下一条提前放出去）', () => {
  assert.equal(pickAfterTurnResend([entry(A, { sawRunning: false })], [{ instanceId: 'i1', sessionId: 's1', turnRunning: false }]), null);
});

test('不同会话各排各的：A 在跑不挡 B', () => {
  const a = entry(A), b = entry(B);
  const instances = [{ instanceId: 'i1', sessionId: 's1', turnRunning: true }, { instanceId: 'i2', sessionId: 's2', turnRunning: false }];
  assert.equal(pickAfterTurnResend([a, b], instances), b);
});

test('目标实例按会话认（置换后实例号变了也认得出）；认不出就不发', () => {
  const swapped = [{ instanceId: 'i1_swapped', sessionId: 's1', turnRunning: false }];
  assert.equal(findOutboxTargetInstance(A, swapped), swapped[0]);
  assert.equal(pickAfterTurnResend([entry(A)], swapped)?.target, A);
  assert.equal(pickAfterTurnResend([entry(A)], []), null, '实例被关掉了：不替用户把会话重新开起来');
  assert.equal(findOutboxTargetInstance({ instanceId: 'i9' }, [{ instanceId: 'i9' }])?.instanceId, 'i9', '没带会话按实例号');
  assert.equal(findOutboxTargetInstance(null, [{ instanceId: 'i9' }]), null);
});

test('sameOutboxTarget：有会话按会话比，没有按实例号比', () => {
  assert.equal(sameOutboxTarget(A, { instanceId: 'other', sessionId: 's1' }), true);
  assert.equal(sameOutboxTarget(A, B), false);
  assert.equal(sameOutboxTarget({ instanceId: 'i3' }, { instanceId: 'i3' }), true);
});
