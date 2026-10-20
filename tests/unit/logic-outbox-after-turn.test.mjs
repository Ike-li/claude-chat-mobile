// 验收 O66：离线重放撞上在途轮的条目排队，本轮结束按序自动续发（一轮一条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAfterTurnResend, findOutboxTargetInstance, sameOutboxTarget, nextOutboxLazyOpenAnchor, planOutboxBlockedTarget } from '../../app/public/js/logic.js';

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

// 普通工作区新会话页上离线连发：条目都是 {instanceId:null}。第一条懒开实例；后面各条被服务端经 viewing 投给它、
// 撞上它那一轮被拒收。拿着 {instanceId:null} 去排队，本轮结束时认不出目标，永远不续发。
test('懒开锚点：同一批第一条普通新会话条目送达后，记下它开出来的实例', () => {
  const fresh = { instanceId: null, cwd: '/w' };
  const ok = { outcome: 'ok', instanceId: 'inst_fresh' };
  assert.equal(nextOutboxLazyOpenAnchor(fresh, ok, null, '/scratch'), 'inst_fresh');
  assert.equal(nextOutboxLazyOpenAnchor(fresh, ok, 'inst_a', '/scratch'), 'inst_a', '已有锚点不覆盖');
  assert.equal(nextOutboxLazyOpenAnchor(fresh, { outcome: 'blocked' }, null, '/scratch'), null, '没送达不立锚');
  assert.equal(nextOutboxLazyOpenAnchor({ instanceId: 'i1', cwd: '/w' }, ok, null, '/scratch'), null, '本来就带实例的条目不是懒开');
  assert.equal(nextOutboxLazyOpenAnchor({ instanceId: null, cwd: '/w', useWorktree: true }, ok, null, '/scratch'), null, 'worktree 有自己的锚');
  assert.equal(nextOutboxLazyOpenAnchor({ instanceId: null, cwd: '/scratch' }, ok, null, '/scratch'), null, '无文件夹有自己的锚');
});

test('被拒收的普通新会话条目按锚点登记目标，本轮结束才认得出是哪个会话', () => {
  const fresh = { instanceId: null, cwd: '/w', text: 'x' };
  const planned = planOutboxBlockedTarget(fresh, 'inst_fresh');
  assert.equal(planned.instanceId, 'inst_fresh');
  assert.equal(planned.text, 'x');
  assert.equal(findOutboxTargetInstance(planned, [{ instanceId: 'inst_fresh', turnRunning: false }])?.instanceId, 'inst_fresh');
  assert.equal(planOutboxBlockedTarget(fresh, null), fresh, '没有锚点原样返回');
  const own = { instanceId: 'i1', cwd: '/w' };
  assert.equal(planOutboxBlockedTarget(own, 'inst_fresh'), own, '本来就带实例的不改投');
});
