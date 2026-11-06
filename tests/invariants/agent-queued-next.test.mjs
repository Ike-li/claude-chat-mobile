// tests/invariants/agent-queued-next.test.mjs —— agent 怎么把回合结局和 CLI 空闲报给排队，以及 queuedNext 的两个效果
// 守护：MSG-03（回合结局的事实要如实报给判定方）/ NOTIFY-01（带 queuedNext 的 result 不推「任务完成」）
// 测什么：真 AgentSession 喂 CLI 2.1.318 实测形状的帧：
//   ① onTurnEnded 只在账面真的归零时触发，事实取自 result 帧 ② 返回 'release' 时 result 带 queuedNext，不调建议旁路
//   ③ session_state_changed:idle 触发 onCliIdle ④ 回调出错不影响会话 ⑤ sdkChildEnv 打开这个帧
// 不测什么 + 为什么：① 判定规则在 queued-message-policy.test.mjs ② 真帧序在 S2 与零 token 真链路
// 槽位：S1（真 AgentSession，不起子进程）
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSession } from '../helpers/agent-unit.mjs';
import { sdkChildEnv } from '../../app/src/shared/child-env.js';

const result = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {}, terminal_reason: 'completed', ...over,
});
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'f1', session_id: 's1' };
const running = { ...idle, state: 'running' };
const fakeQuery = { interrupt() { return Promise.resolve({ still_queued: [] }); }, setModel() { return Promise.resolve(); } };

async function startTurn(s) {
  s.q = fakeQuery;
  assert.equal(await s.send('跑一下'), true);
  const { uuid } = s.queue.at(-1);
  s.queue = [];
  return uuid;
}

test('正常结束：账面归零时报事实，返回 release 则 result 带 queuedNext', async () => {
  const seen = [];
  const { s, events } = makeSession({ onTurnEnded: (facts) => { seen.push({ facts, pendingTurns: s.pendingTurns }); return 'release'; } });
  const uuid = await startTurn(s);
  s.map(result({ user_message_uuid: uuid }));
  assert.deepEqual(seen, [{
    facts: { isError: false, interrupted: false, approvalExpired: false, terminalReason: 'completed' },
    pendingTurns: 0,
  }]);
  assert.equal(events.findLast(e => e.type === 'result').payload.queuedNext, true);
  s.dispose();
});

test('没有排队消息：result 不带 queuedNext，事件形状不变', async () => {
  const { s, events } = makeSession({ onTurnEnded: () => undefined });
  const uuid = await startTurn(s);
  s.map(result({ user_message_uuid: uuid }));
  assert.equal('queuedNext' in events.findLast(e => e.type === 'result').payload, false);
  s.dispose();
});

test('hold 也不带 queuedNext：这一轮真的结束了，该推就推', async () => {
  const { s, events } = makeSession({ onTurnEnded: () => 'hold' });
  const uuid = await startTurn(s);
  s.map(result({ user_message_uuid: uuid, is_error: true, terminal_reason: 'api_error' }));
  assert.equal('queuedNext' in events.findLast(e => e.type === 'result').payload, false);
  s.dispose();
});

test('额度墙形状的 result：is_error 和 terminal_reason 如实报上去', async () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: (facts) => { seen.push(facts); } });
  const uuid = await startTurn(s);
  s.map(result({ user_message_uuid: uuid, is_error: true, terminal_reason: 'api_error' }));
  assert.equal(seen[0].isError, true);
  assert.equal(seen[0].terminalReason, 'api_error');
  s.dispose();
});

test('本地命令的 result 没有 terminal_reason：报 null', async () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: (facts) => { seen.push(facts); } });
  const uuid = await startTurn(s);
  s.map(result({ user_message_uuid: uuid, terminal_reason: undefined }));
  assert.equal(seen[0].terminalReason, null);
  s.dispose();
});

test('被中断：aborted_* 报成 interrupted', async () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: (facts) => { seen.push(facts); } });
  await startTurn(s);
  s.map(result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }));
  assert.equal(seen[0].interrupted, true);
  s.dispose();
});

test('审批过期：报 approvalExpired，且只报这一轮', async () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: (facts) => { seen.push(facts); } });
  const uuid = await startTurn(s);
  s._approvalExpiredInTurn = true;
  s.map(result({ user_message_uuid: uuid }));
  assert.equal(seen[0].approvalExpired, true);
  const next = await startTurn(s);
  s.map(result({ user_message_uuid: next }));
  assert.equal(seen[1].approvalExpired, false);
  s.dispose();
});

test('汇报轮的 result 没有结算任何槽（applied:false）→ 不触发：人发的那条还排在 CLI 队列里', async () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: () => { seen.push(1); } });
  const uuid = await startTurn(s);
  s.map({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued', uuid: 'f', session_id: 's1' });
  s.map(result());
  assert.deepEqual(seen, []);
  assert.equal(s.pendingTurns, 1);
  s.dispose();
});

test('强制结算之后迟到的 result（applied:false，账面已是 0）→ 不触发：这一轮早就算结束了', async () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: () => { seen.push(1); } });
  await startTurn(s);
  s._forceSettleOpenTurns();
  s.pendingTurns = 0;
  s.map(result());
  assert.deepEqual(seen, []);
  s.dispose();
});

test('账面还有在途轮 → 不触发', async () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: () => { seen.push(1); } });
  await startTurn(s);
  s._openTurnSlot('另一条');
  s.pendingTurns = 2;
  s.map(result());
  assert.deepEqual(seen, []);
  s.dispose();
});

test('Monitor 汇报轮不记账：无槽的 result 账面仍是 0 → 触发，排队消息等到这一轮结束', () => {
  const seen = [];
  const { s } = makeSession({ onTurnEnded: () => { seen.push(1); return 'release'; } });
  s.q = fakeQuery;
  s.map(result());
  assert.deepEqual(seen, [1]);
  s.dispose();
});

test('回调抛错被隔离：result 照常发，会话不受影响', async () => {
  const { s, events } = makeSession({ onTurnEnded: () => { throw new Error('队列炸了'); } });
  const uuid = await startTurn(s);
  assert.doesNotThrow(() => s.map(result({ user_message_uuid: uuid })));
  const last = events.findLast(e => e.type === 'result');
  assert.ok(last);
  assert.equal('queuedNext' in last.payload, false);
  s.dispose();
});

test('queuedNext 时关掉建议条：这条建议注定被丢弃，不为它付一次旁路请求；没有 queuedNext 时照常', async () => {
  for (const [verdict, expected] of [['release', false], [undefined, true]]) {
    let enabled = null;
    const { s } = makeSession({ onTurnEnded: () => verdict });
    s.maybeSuggest = async (o) => { enabled = o.enabled; };
    const uuid = await startTurn(s);
    s.map(result({ user_message_uuid: uuid }));
    assert.equal(enabled, expected, `onTurnEnded 回 ${verdict}`);
    s.dispose();
  }
});

test('CLI 报 idle → onCliIdle；running 不触发；两者都不写「未映射」日志', async () => {
  let idles = 0;
  const { s } = makeSession({ onCliIdle: () => { idles += 1; } });
  s.map(running);
  assert.equal(idles, 0);
  s.map(idle);
  assert.equal(idles, 1);
  s.dispose();
});

test('onCliIdle 抛错被隔离', () => {
  const { s } = makeSession({ onCliIdle: () => { throw new Error('队列炸了'); } });
  assert.doesNotThrow(() => s.map(idle));
  s.dispose();
});

test('SDK 子进程打开会话状态帧：不设这个变量真 CLI 一帧都不吐（2.1.318 实测）', () => {
  assert.equal(sdkChildEnv({ PATH: '/bin' }).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
});
