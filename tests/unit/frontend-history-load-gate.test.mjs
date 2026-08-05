// tests/unit/frontend-history-load-gate.test.mjs —— 拉历史在途期间的 OOB 事件闸门。
// 按行为域拆分是硬门禁（见 source-layout.test.mjs）。
//
// 为什么需要它：loadHistory 是异步的（socket 往返 + 分块渲染，2000 条约 50 块），这段窗口里
// 镜像追平的 history_append 完全可能到达。它是 out-of-band、不进 replay buffer，任何时候直接渲染，
// 于是「增量先落地、历史后落地」，用户看到新消息在上、整段旧历史在下。
// 更隐蔽的是时间戳：增量对着尚被清空的 #messages 判定，会命中「会话首条」而带上一条日期分隔行。
// 事后把节点挪回正确位置解决不了后者——marker 已经按错误的基准算出来了。
// 所以这里从根上消掉竞态：在途期间把这些事件扣住，历史落地后按原顺序放行，届时 DOM 已是最终态。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createHistoryLoadGate } from '../../public/js/app/history-load-gate.js';

const ev = (instanceId, n) => ({ instanceId, type: 'history_append', payload: { messages: [n] } });

test('未开闸时不扣任何事件', () => {
  const gate = createHistoryLoadGate();
  assert.equal(gate.hold(ev('inst_1', 1)), false);
});

test('开闸期间扣住同实例事件，release 按原顺序放行', () => {
  const gate = createHistoryLoadGate();
  gate.begin('inst_1');
  assert.equal(gate.hold(ev('inst_1', 1)), true);
  assert.equal(gate.hold(ev('inst_1', 2)), true);
  const released = gate.release();
  assert.deepEqual(released.map(e => e.payload.messages[0]), [1, 2]);
  assert.equal(gate.hold(ev('inst_1', 3)), false, 'release 后闸门关闭，不再扣');
});

// 迟到 ack 守卫已经按 instanceId 丢弃跨实例回调，闸门也必须同口径——
// 否则切走后另一个会话的追平会被莫名扣住，等这边历史落地才放行，那就是真的丢消息了。
test('不扣别的实例的事件', () => {
  const gate = createHistoryLoadGate();
  gate.begin('inst_1');
  assert.equal(gate.hold(ev('inst_2', 1)), false);
  assert.deepEqual(gate.release(), []);
});

test('begin 会清掉上一轮残留，不把旧队列带进新一轮', () => {
  const gate = createHistoryLoadGate();
  gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));
  gate.begin('inst_1');                       // 同实例重新加载（如 gap reload）
  assert.deepEqual(gate.release(), []);
});

// loadHistory 有多条早退路径（空历史、error、迟到 ack 被守卫丢弃）。任何一条走了都必须关闸，
// 否则闸门永远开着，之后所有追平都被静默扣住——表现为「终端在跑但手机上再也不更新」。
test('abort 关闸并丢弃队列', () => {
  const gate = createHistoryLoadGate();
  gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));
  gate.abort();
  assert.equal(gate.hold(ev('inst_1', 2)), false);
  assert.deepEqual(gate.release(), []);
});

test('release 幂等：重复调用不会重放已放行的事件', () => {
  const gate = createHistoryLoadGate();
  gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));
  assert.equal(gate.release().length, 1);
  assert.deepEqual(gate.release(), []);
});

// ★ 双请求交错：A 发起加载后用户切到 B，B 的闸门接管并已扣住若干追平事件，此时 A 的【迟到 ACK】
// 才回来。它必须只结算自己那一轮——若无条件 abort()，会把 B 已扣住的队列一并清空，
// 而 B 随后只能释放空队列：那些没进历史快照的增量就永久消失了（终端在跑、手机上却少了几条）。
// 身份校验用 begin() 返回的 handle，与 replayBuffer 的 WS-001/WS-002 迟到 ACK 守卫同款思路。
test('迟到 ACK 的 abort 不得清掉另一轮已建立的闸门', () => {
  const gate = createHistoryLoadGate();
  const handleA = gate.begin('inst_A');
  const handleB = gate.begin('inst_B');        // 用户切到 B，B 接管闸门
  assert.equal(gate.hold(ev('inst_B', 1)), true);
  assert.equal(gate.hold(ev('inst_B', 2)), true);

  gate.abort(handleA);                          // A 的迟到 ACK 落地

  assert.deepEqual(gate.release(handleB).map(e => e.payload.messages[0]), [1, 2],
    'B 扣住的两条必须原样放行');
});

test('迟到 ACK 的 release 也不得抢走另一轮的队列', () => {
  const gate = createHistoryLoadGate();
  const handleA = gate.begin('inst_A');
  const handleB = gate.begin('inst_B');
  gate.hold(ev('inst_B', 1));

  assert.deepEqual(gate.release(handleA), [], 'A 那轮早已被顶替，只能拿到空');
  assert.deepEqual(gate.release(handleB).map(e => e.payload.messages[0]), [1], 'B 的队列完好');
});
