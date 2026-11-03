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

import { createHistoryLoadGate } from '../../app/public/js/app/history-load-gate.js';

const ev = (instanceId, n) => ({ instanceId, type: 'history_append', payload: { messages: [n] } });

// 可控时钟：把 setTimeout 换成手动触发，直接验看门狗到点后的行为，不真等墙钟。
function fakeTimers() {
  let pending = null;
  let nextId = 1;
  return {
    setTimeout: (fn, ms) => { pending = { fn, ms, id: nextId }; return nextId++; },
    clearTimeout: (id) => { if (pending?.id === id) pending = null; },
    fire() { const p = pending; pending = null; p?.fn(); },
    armed: () => pending != null,
    delay: () => pending?.ms,
  };
}

test('未开闸时不扣任何事件', () => {
  const gate = createHistoryLoadGate();
  assert.equal(gate.hold(ev('inst_1', 1)), false);
});

// —— 看门狗：闸门必须能自己关上 ——
// 隔壁 createReplayBuffer 有 3s 超时兜底（armTimeout，注释写着「不能无限期黑屏攒着」），
// 本闸门原本一个 setTimeout 都没有：只要有任何一条早退路径忘了 abort，闸门就永久开着，
// 此后该实例所有 history_append 被静默吞掉——终端一直在输出，手机上再也不刷新，且无任何报错。
// 实测存在两条这样的路径：
//  ① renderHistoryBubbles 分块渲染中途切走，processChunk 早退，onDone（唯一的 release 调用点）不执行；
//  ② session:history 用的是裸 ack，socket.io-client 断线时 _clearAcks() 会 delete 掉非 withError 的
//     handler 且不调用（见 socket.io-client/build/esm/socket.js），回调永不执行。
// 逐条补 abort 是打地鼠——新增早退路径就会再漏。看门狗保证「无论如何都会关上」。

test('看门狗：超时到点自动放行扣住的事件，闸门关闭', () => {
  const timers = fakeTimers();
  const gate = createHistoryLoadGate({ timers });
  gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));
  gate.hold(ev('inst_1', 2));

  assert.equal(timers.armed(), true, 'begin 就该挂上兜底');
  const flushed = [];
  gate.onTimeout(events => flushed.push(...events));
  timers.fire();

  assert.deepEqual(flushed.map(e => e.payload.messages[0]), [1, 2], '★ 扣住的事件必须放行，不能丢');
  assert.equal(gate.hold(ev('inst_1', 3)), false, '超时后闸门必须已关闭，不再扣新事件');
});

test('看门狗：release 之后不再触发（正常路径不该被兜底二次放行）', () => {
  const timers = fakeTimers();
  const gate = createHistoryLoadGate({ timers });
  gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));

  const flushed = [];
  gate.onTimeout(events => flushed.push(...events));
  gate.release();
  assert.equal(timers.armed(), false, 'release 必须撤掉兜底，否则定时器空挂');
  timers.fire();
  assert.deepEqual(flushed, [], '已 release 的事件不能被兜底再放行一次');
});

test('看门狗：abort 之后不再触发', () => {
  const timers = fakeTimers();
  const gate = createHistoryLoadGate({ timers });
  gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));

  const flushed = [];
  gate.onTimeout(events => flushed.push(...events));
  gate.abort();
  assert.equal(timers.armed(), false);
  timers.fire();
  assert.deepEqual(flushed, []);
});

test('看门狗：begin 换轮时重挂，旧轮的兜底不得放行新轮队列', () => {
  const timers = fakeTimers();
  const gate = createHistoryLoadGate({ timers });
  const flushed = [];
  gate.onTimeout(events => flushed.push(...events));

  gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));
  gate.begin('inst_2');           // 切到另一个会话，接管闸门
  gate.hold(ev('inst_2', 9));
  timers.fire();                  // 只应有一个存活的兜底，且属于 inst_2 这一轮

  assert.deepEqual(flushed.map(e => e.payload.messages[0]), [9]);
});

// 历史分两次传（先最近一段，再补更早的）：第二次的回执也有自己的 15s 超时。看门狗只从 begin 算的话，
// 第一次回来得慢，兜底就会赶在第二次回执之前放行——追平先画进还空着的视图，整窗再插到它下面。
test('看门狗：rearm 从现在起重新计时；别的轮、已关闸的 handle 无效', () => {
  let now = 0;
  let nextId = 1;
  const due = new Map();
  const timers = {
    setTimeout: (fn, ms) => { due.set(nextId, { fn, at: now + ms }); return nextId++; },
    clearTimeout: id => due.delete(id),
  };
  const advance = ms => {
    now += ms;
    for (const [id, t] of [...due]) if (t.at <= now) { due.delete(id); t.fn(); }
  };
  const gate = createHistoryLoadGate({ timers, timeoutMs: 20_000 });
  const flushed = [];
  gate.onTimeout(events => flushed.push(...events.map(e => e.payload.messages[0])));

  const first = gate.begin('inst_1');
  gate.hold(ev('inst_1', 1));
  advance(12_000);
  gate.rearm(first);
  advance(12_000);
  assert.deepEqual(flushed, [], '重挂之后，begin 起算的 20s 不该再放行');
  assert.equal(gate.hold(ev('inst_1', 2)), true, '闸门还开着');
  advance(8_000);
  assert.deepEqual(flushed, [1, 2], '从重挂那一刻再过 20s 照样兜底');

  gate.begin('inst_2');
  gate.hold(ev('inst_2', 3));
  advance(15_000);
  gate.rearm(first);
  advance(5_000);
  assert.deepEqual(flushed, [1, 2, 3], '上一轮的 handle 重挂不动这一轮的兜底');

  const third = gate.begin('inst_3');
  gate.release(third);
  gate.rearm(third);
  advance(60_000);
  assert.equal(gate.hold(ev('inst_3', 4)), false, '已 release 的那轮重挂不会把闸门重新打开');
  assert.deepEqual(flushed, [1, 2, 3]);
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

// —— 代次：同一实例又发起了一次全量加载，上一轮的渲染链要整段作废（#354 review）——
// 手动「重新加载」时实例没变，renderHistoryBubbles 的实例守卫拦不住上一轮：它会把自己那一份 frag 也插进来，
// 和新一轮叠成两份。只认「之后又 begin 过」：release / abort / 看门狗到点都不算顶替——
// 否则慢机上分块渲染超过看门狗的 20s，正常的那一轮会被自己的兜底掐断。
test('superseded：只有之后又 begin 过才算被顶替', () => {
  const timers = fakeTimers();
  const gate = createHistoryLoadGate({ timers });
  const first = gate.begin('inst_1');
  assert.equal(gate.superseded(first), false, '刚开的这一轮不算被顶替');

  timers.fire();
  assert.equal(gate.superseded(first), false, '看门狗到点放行不算被顶替');
  gate.release(first);
  gate.abort(first);
  assert.equal(gate.superseded(first), false, 'release / abort 之后也不算');

  const second = gate.begin('inst_1');
  assert.equal(gate.superseded(first), true, '同实例再 begin 一次，上一轮就被顶替了');
  assert.equal(gate.superseded(second), false);
  gate.release(second);
  assert.equal(gate.superseded(second), false, '最新一轮正常收尾后仍不算被顶替');
});
