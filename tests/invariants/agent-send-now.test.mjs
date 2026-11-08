// tests/invariants/agent-send-now.test.mjs —— 「立即发送」在 agent 这一层的账目：带 priority:'now' 交给 CLI，当前这一轮让路
// 守护：OPS-04（并进当前轮的消息不得让账面永挂；被让路那一轮的 result 不得把账面清零）/ MSG-03（没声明能力位的 CLI 不得这样发；还没开跑时点停止要连它一起停住）
// 测什么：真 AgentSession 喂 CLI 2.1.319 零 token 实测的帧序（/tmp 探针 run1–run4，见 commit）：
//   ① 能力位齐全才放行在途轮期间的发送，消息带 priority:'now' 交给 CLI ② 「让路」形态：A 以 aborted_* 结束、B 单独一轮
//   ③ 「并进」形态：B 只有 lifecycle，没有自己的 result ④ 停止：B 还排在 CLI 时带 cancelQueued，出账并标「已随停止取消」
// 不测什么 + 为什么：① 排队条目怎么交到这里归 message-queue.test.mjs ② socket 与真 server 接线属 S2
//   ③ CLI 怎么选让路方式是 CLI 的事，这里只喂它实测吐出的帧
// 槽位：S1（真 AgentSession，不起子进程）
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSession } from '../helpers/agent-unit.mjs';

const SID = '0b7d5a3e-6c1f-4d2a-9e8b-1f2e3d4c5b6a';
const CAPS = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'interrupt_send_now_v1', 'interrupt_requeue_taken_v1'];
const init = (capabilities = CAPS) => ({ type: 'system', subtype: 'init', session_id: SID, uuid: 'init-1', capabilities });

// 一轮在跑：发 A、泵进 CLI、CLI 报了 init
async function running({ capabilities = CAPS, ...opts } = {}) {
  const { s, events } = makeSession(opts);
  s.q = { interrupt() { return Promise.resolve({ still_queued: [] }); }, setModel() { return Promise.resolve(); } };
  assert.equal(await s.send('A 跑测试'), true, '前提：空闲时发 A');
  const a = s.queue.at(-1).uuid;
  s.queue = [];
  s.map(init(capabilities));
  return { s, events, a };
}

test('能力位齐全：在途轮期间带 priority:now 的发送放行，交给 CLI 的消息带同一个 priority', async () => {
  const { s, events } = await running();
  assert.equal(await s.send('B 先看这个', undefined, { priority: 'now', clientMessageId: 'c-b' }), true,
    '立即发送被在途轮闸拒掉：用户点了没反应');
  assert.equal(s.pendingTurns, 2, 'B 也要记账，否则它跑起来时账面对不上');
  assert.ok(events.some(e => e.type === 'user_message' && e.payload.text === 'B 先看这个'), 'B 的气泡要当场上屏');
  const pumped = await s.inputStream().next();
  assert.equal(pumped.value.priority, 'now', '没带 priority:now，CLI 会把它当普通排队消息，等这一轮跑完才发');
  s.dispose();
});

test('能力位缺一样就不放行：旧 CLI 不认 priority，会把它排在 CLI 队列里，停止也停不住', async () => {
  for (const missing of ['interrupt_send_now_v1', 'interrupt_cancel_queued_v1']) {
    const { s, events } = await running({ capabilities: CAPS.filter(c => c !== missing) });
    assert.equal(await s.send('B', undefined, { priority: 'now' }), false, `缺 ${missing} 时不得在途轮期间放行`);
    assert.equal(s.pendingTurns, 1);
    assert.equal(events.filter(e => e.type === 'user_message').length, 1, '被拒的这条不得上屏');
    s.dispose();
  }
});

test('普通发送在途轮期间照旧拒收（priority 只给立即发送用）', async () => {
  const { s } = await running();
  assert.equal(await s.send('B'), false);
  assert.equal(s.pendingTurns, 1);
  s.dispose();
});

// ── 线上帧序（CLI 2.1.319 实测）──
const lifecycle = (state, commandUuid) => ({ type: 'command_lifecycle', command_uuid: commandUuid, state, uuid: `lc-${state}`, session_id: SID });
const result = over => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {}, terminal_reason: 'completed', ...over });

async function sendNow(s, text = 'B 先看这个') {
  assert.equal(await s.send(text, undefined, { priority: 'now', clientMessageId: 'c-b' }), true);
  const b = s.queue.at(-1).uuid;
  s.queue = [];
  s.map(lifecycle('queued', b));
  return b;
}

// shell 起不到约 3 秒、模型正在输出、审批卡挂着：CLI 停掉 A（subtype success、is_error false），B 单独一轮
test('让路形态：A 的 aborted result 不清零账面、不算这一轮结束；B 自己的 result 才是', async () => {
  const ended = [];
  const { s, events, a } = await running({ onTurnEnded: facts => { ended.push(facts); } });
  const b = await sendNow(s);

  s.map(result({ terminal_reason: 'aborted_tools', user_message_uuid: a }));
  s.map(lifecycle('cancelled', a));
  assert.equal(s.pendingTurns, 1, 'B 还要跑：清零的话停止钮消失、发送闸放行下一条');
  assert.equal(s.isBusy(), true);
  assert.deepEqual(ended, [], '让路不是回合结束：排队模块会以为可以放下一条');
  const aResult = events.filter(e => e.type === 'result').at(-1).payload;
  assert.equal(aResult.interrupted, true);
  assert.equal(aResult.interruptedBy, 'send_now', '不标来源的话前端说「⚠️ 任务被中断」并推送，像出了故障');

  s.map(lifecycle('started', b));
  s.map(result({ user_message_uuid: b }));
  s.map(lifecycle('completed', b));
  assert.equal(s.pendingTurns, 0);
  assert.equal(ended.length, 1, 'B 跑完才是这一轮真正结束');
  assert.equal(events.filter(e => e.type === 'result').at(-1).payload.interrupted, false);
  s.dispose();
});

// shell 已经跑了一阵、前台子 agent：CLI 把它们转后台，B 并进 A 这一轮。B 的 completed 早于 A 的 result
test('并进形态：B 没有自己的 result，按它的 lifecycle 出账；A 的 result 结束这一轮', async () => {
  const ended = [];
  const { s, events, a } = await running({ onTurnEnded: facts => { ended.push(facts); } });
  const b = await sendNow(s);

  s.map(lifecycle('started', b));
  s.map(lifecycle('completed', b));
  assert.equal(s.pendingTurns, 1, 'A 这一轮还没收尾');
  s.map(result({ user_message_uuid: a }));
  s.map(lifecycle('completed', a));
  assert.equal(s.pendingTurns, 0, '等 B 的 result 的话账面永挂：停止钮和「运行中」一直不消失');
  assert.equal(s.isBusy(), false);
  assert.equal(ended.length, 1);
  const last = events.filter(e => e.type === 'result').at(-1).payload;
  assert.equal(last.interrupted, false, '并进不是中断，A 这一轮正常结束');
  assert.equal(await s.send('下一条'), true, '账面归零后发送闸要放行');
  s.dispose();
});

// ── 停止 ──
// 实测：普通 interrupt 回 still_queued:[B]，A 停了 B 照跑；带 cancel_queued 回 cancelled:[B]，B 不跑，只剩 A 的 error result
const stopResult = a => result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', user_message_uuid: a });
function recordingQuery(s, respond) {
  const calls = [];
  s.q = { interrupt(opts) { calls.push(opts); return Promise.resolve(respond()); }, setModel() { return Promise.resolve(); } };
  return calls;
}

for (const order of ['lifecycle 先到', '控制应答先到']) {
  test(`B 还排在 CLI 时点停止：带 cancelQueued，B 出账并标「已随停止取消」（${order}）`, async () => {
    const ended = [];
    const { s, events, a } = await running({ onTurnEnded: facts => { ended.push(facts); } });
    const b = await sendNow(s);
    const calls = recordingQuery(s, () => {
      if (order === 'lifecycle 先到') s.map(lifecycle('cancelled', b));
      return { still_queued: [], cancelled: [b] };
    });

    await s.interrupt();
    if (order === '控制应答先到') s.map(lifecycle('cancelled', b));
    assert.deepEqual(calls, [{ cancelQueued: true }], '普通 interrupt 停不住 B：A 停了，B 紧接着照跑');
    assert.equal(s.pendingTurns, 1, 'B 已取消、不会有 result；A 的 result 还没到');
    const dropped = events.find(e => e.type === 'system' && e.payload.kind === 'queue_dropped');
    assert.deepEqual(dropped?.payload.clientMessageIds, ['c-b'], 'B 的气泡要标「已随停止取消」，否则看着像发出去了');

    s.map(stopResult(a));
    assert.equal(s.pendingTurns, 0);
    assert.equal(ended.length, 1);
    assert.equal(events.filter(e => e.type === 'result').at(-1).payload.interruptedBy, 'user', '是用户按的停止，不是让路');
    s.dispose();
  });
}

test('没有立即发送排在 CLI 时，停止不带 cancelQueued（汇报轮后面排着的手动消息照旧开跑，OPS-04 那条用例的语义）', async () => {
  const { s, a } = await running();
  const calls = recordingQuery(s, () => ({ still_queued: [] }));
  await s.interrupt();
  assert.deepEqual(calls, [undefined]);
  s.map(stopResult(a));
  assert.equal(s.pendingTurns, 0);
  s.dispose();
});

// 实测（run4 absorbed-stop）：B 已并进 A 这一轮时点停止，cancelled:[]，B 的 lifecycle cancelled 先于 A 的 error result
test('B 已并进当前轮再点停止：B 由 lifecycle 出账，A 的 result 归零，不标「已随停止取消」', async () => {
  const { s, events, a } = await running();
  const b = await sendNow(s);
  s.map(lifecycle('started', b));
  const calls = recordingQuery(s, () => ({ still_queued: [], cancelled: [] }));
  await s.interrupt();
  assert.deepEqual(calls, [undefined], 'B 已经开跑，不在 CLI 队列里：普通 interrupt 就能连它一起停');
  s.map(lifecycle('cancelled', b));
  s.map(stopResult(a));
  assert.equal(s.pendingTurns, 0, 'B 没有自己的 result，等它的话账面永挂');
  assert.equal(events.some(e => e.type === 'system' && e.payload.kind === 'queue_dropped'), false, 'B 已经被模型读到，不是「未发送」');
  s.dispose();
});

// PR #544 Codex review P2：SDK 已经把 B 取走、CLI 的 queued 帧还没到时点停止。只看 cliQueued 的话这次停止不带
// cancelQueued，B 照跑
test('B 已交给 CLI、queued 帧还没到就点停止：照样带 cancelQueued，B 出账并标「已随停止取消」', async () => {
  const { s, events, a } = await running();
  assert.equal(await s.send('B', undefined, { priority: 'now', clientMessageId: 'c-b' }), true);
  const b = s.queue.at(-1).uuid;
  s.queue = []; // 输入泵已取走，lifecycle 还没回来
  const calls = recordingQuery(s, () => ({ still_queued: [], cancelled: [b] }));
  await s.interrupt();
  assert.deepEqual(calls, [{ cancelQueued: true }], 'B 还没开跑，不连它一起停的话 A 停了它照跑');
  assert.equal(s.pendingTurns, 1);
  assert.deepEqual(events.find(e => e.type === 'system' && e.payload.kind === 'queue_dropped')?.payload.clientMessageIds, ['c-b']);
  s.map(stopResult(a));
  assert.equal(s.pendingTurns, 0);
  s.dispose();
});
