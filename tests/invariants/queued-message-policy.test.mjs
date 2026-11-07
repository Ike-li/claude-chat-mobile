// tests/invariants/queued-message-policy.test.mjs —— 什么样的回合结束才算「可以替用户发下一条」
// 守护：MSG-03（排队消息只在回合正常结束后发出，停止、出错、额度墙、审批过期、非 completed 死因之后不得自动发）
// 测什么：classifyTurnEnd 对各种回合结局的判定；heldNeedsAttention 判哪些未发送要推送、进「需要你」。夹具是 CLI 2.1.318 零 token 实测的 result 形状：
//   额度墙和 500 都是 subtype:'success' + is_error:true + terminal_reason:'api_error'，本地命令没有 terminal_reason。
// 不测什么 + 为什么：① 判定之后条目怎么走在 message-queue.test.mjs ② 这些事实怎么从 result 帧取出来，
//   接线在 agent.js，S1 见 agent-queued-next.test.mjs ③ 真额度墙要真额度耗尽，归 S5。
// 槽位：S1（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTurnEnd, heldNeedsAttention } from '../../app/src/agent/queued-message-policy.js';

const normal = { isError: false, interrupted: false, approvalExpired: false, terminalReason: 'completed' };

test('正常结束 → 放行', () => {
  assert.deepEqual(classifyTurnEnd(normal), { kind: 'release' });
});

test('本地命令的 result 没有 terminal_reason → 放行（缺字段不算异常）', () => {
  assert.deepEqual(classifyTurnEnd({ ...normal, terminalReason: null }), { kind: 'release' });
});

test('用户或看门狗中断 → hold', () => {
  const r = classifyTurnEnd({ ...normal, isError: true, interrupted: true, terminalReason: 'aborted_streaming' });
  assert.deepEqual(r, { kind: 'hold', reason: 'interrupted' });
});

test('额度墙和 API 错误：subtype 是 success，靠 is_error 才认得出 → hold', () => {
  const r = classifyTurnEnd({ ...normal, isError: true, terminalReason: 'api_error' });
  assert.deepEqual(r, { kind: 'hold', reason: 'turn_error' });
});

test('审批过期：模型可能正常收尾，但操作没执行 → hold', () => {
  const r = classifyTurnEnd({ ...normal, approvalExpired: true });
  assert.deepEqual(r, { kind: 'hold', reason: 'approval_expired' });
});

test('不是错误也不是 completed 的死因 → hold（上游新增枚举时默认停在未发送）', () => {
  for (const terminalReason of ['max_turns', 'budget_exhausted', 'hook_stopped', '上游以后新增的值']) {
    assert.deepEqual(classifyTurnEnd({ ...normal, terminalReason }), { kind: 'hold', reason: 'incomplete' }, terminalReason);
  }
});

test('未发送要不要提醒：用户自己点的停止、关闭会话不提醒——是他刚做的事，再推一条是打扰', () => {
  assert.equal(heldNeedsAttention('stopped'), false);
  assert.equal(heldNeedsAttention('closed'), false);
});

test('未发送要不要提醒：其余原因都提醒——用户多半不在，不推就没人知道这句话没发出去', () => {
  for (const reason of ['interrupted', 'turn_error', 'quota_wall', 'approval_expired', 'incomplete', 'instance_exit',
    'session_changed', 'other_driver', 'unverified', 'diverged', 'location', 'attachment_failed', 'send_failed']) {
    assert.equal(heldNeedsAttention(reason), true, `${reason} 不提醒的话，用户离开时这句话就悄悄停在那里`);
  }
});

test('未发送要不要提醒：认不出的原因按提醒算——漏推比多推一条代价大', () => {
  assert.equal(heldNeedsAttention('some_future_reason'), true);
  assert.equal(heldNeedsAttention(undefined), true);
});
