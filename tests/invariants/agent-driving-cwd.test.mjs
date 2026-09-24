// tests/invariants/agent-driving-cwd.test.mjs —— 会话中途换 cwd 时，实例的驾驶轴跟着走
// 守护：SESSION-03（EnterWorktree / ExitWorktree 之后驾驶轴必须跟到新目录；信号以主链 tool_use_result 为准，两路幂等）
// 测什么：SDK 消息流（assistant 的 tool_use + user 的 tool_result/tool_use_result）喂进 map() 之后，
//   实例是否把裁决结果写回 cwd、是否只在真变化时重播 instances；哪些结果不得采信。
// 不测什么 + 为什么：① server 侧的范围判据本身（SCOPE-*，另有文件）② CLI 真的会不会发出这些消息——
//   需要模型真调一次 EnterWorktree，归 S5；这里的夹具形状照真机 transcript `1c401b5d` 的 toolUseResult
//   （{worktreePath, worktreeBranch, message}）与 SDK 公开类型 EnterWorktreeOutput / ExitWorktreeOutput 写。
// 槽位：S1（纯内存，AgentSession 不起 CLI）

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentQueryOptions } from '../../app/src/agent/agent.js';
import { makeSession } from '../helpers/agent-unit.mjs';

const REPO = '/tmp/ccm-repo';
const SIBLING = '/tmp/ccm-repo-feat-x';

// 照 SDK 流的真实顺序：先一条 assistant 带 tool_use，再一条 user 带 tool_result + 消息级 tool_use_result。
const toolUse = (id, name, input = {}, parent = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, toolUseResult, { isError = false, parent = null, text = 'ok' } = {}) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
  tool_use_result: toolUseResult,
});
const enterResult = path => ({
  worktreePath: path,
  worktreeBranch: 'feat/x',
  message: `Entered worktree at ${path} on branch feat/x. The session is now working in the worktree.`,
});

function session(onCwdChanged) {
  let settled = 0;
  const calls = [];
  const { s, dispose } = makeSession({
    cwd: REPO,
    onCwdChanged: (next, prev, meta) => { calls.push({ next, prev, via: meta?.via }); return onCwdChanged(next, prev); },
    onStateSettled: () => { settled += 1; },
  });
  return { s, dispose, calls, settledCount: () => settled };
}

test('EnterWorktree 的结果把驾驶轴带到 worktreePath（CLI 不发 CwdChanged 时唯一的信号）', () => {
  const { s, dispose, calls, settledCount } = session(next => next);
  try {
    s.map(toolUse('toolu_enter', 'EnterWorktree', { path: SIBLING }));
    s.map(toolResult('toolu_enter', enterResult(SIBLING)));
    assert.equal(s.cwd, SIBLING, '驾驶轴停在父仓 = 历史、resume、附件全按一个已经空掉的目录解析');
    assert.deepEqual(calls.map(c => [c.prev, c.next]), [[REPO, SIBLING]]);
    assert.equal(calls[0].via, 'tool_result', '审计要能分清这次换 cwd 是哪条通道报上来的');
    assert.equal(settledCount(), 1, '驾驶轴变了却不重播 instances，前端 entry.cwd 停在旧值');
  } finally { dispose(); }
});

test('ExitWorktree 的结果把驾驶轴带回 originalCwd', () => {
  const { s, dispose } = session(next => next);
  try {
    s.map(toolUse('toolu_enter', 'EnterWorktree', { path: SIBLING }));
    s.map(toolResult('toolu_enter', enterResult(SIBLING)));
    assert.equal(s.cwd, SIBLING, '前提：先得进了 worktree，「回到原目录」才不是空转');
    s.map(toolUse('toolu_exit', 'ExitWorktree', { action: 'keep' }));
    s.map(toolResult('toolu_exit', { action: 'keep', originalCwd: REPO, worktreePath: SIBLING, message: 'Exited worktree' }));
    assert.equal(s.cwd, REPO, '退出 worktree 后驾驶轴必须回到原目录，而不是停在 worktreePath');
  } finally { dispose(); }
});

test('is_error 的结果不采信——工具没成功，CLI 也没换目录', () => {
  const { s, dispose, calls } = session(next => next);
  try {
    s.map(toolUse('toolu_enter', 'EnterWorktree', { path: SIBLING }));
    s.map(toolResult('toolu_enter', enterResult(SIBLING), { isError: true, text: 'Error: not a worktree' }));
    assert.equal(s.cwd, REPO);
    assert.equal(calls.length, 0, '失败的调用不该惊动裁决方');
  } finally { dispose(); }
});

test('子 agent 的 EnterWorktree 不挪主实例——那是子 agent 自己的工作目录', () => {
  const { s, dispose, calls } = session(next => next);
  try {
    s.map(toolUse('toolu_sub', 'EnterWorktree', { path: SIBLING }, 'toolu_agent_parent'));
    s.map(toolResult('toolu_sub', enterResult(SIBLING), { parent: 'toolu_agent_parent' }));
    assert.equal(s.cwd, REPO);
    assert.equal(calls.length, 0);
  } finally { dispose(); }
});

test('别的工具的结果即使长得像也不采信——判据是工具名，不是结果形状', () => {
  const { s, dispose, calls } = session(next => next);
  try {
    s.map(toolUse('toolu_bash', 'Bash', { command: 'echo' }));
    s.map(toolResult('toolu_bash', { worktreePath: SIBLING, stdout: '' }));
    assert.equal(s.cwd, REPO);
    assert.equal(calls.length, 0);
  } finally { dispose(); }
});

test('一条消息里有多个 tool_result 时不采信——tool_use_result 是消息级字段，分不清属于谁', () => {
  const { s, dispose, calls } = session(next => next);
  try {
    s.map(toolUse('toolu_enter', 'EnterWorktree', { path: SIBLING }));
    s.map(toolUse('toolu_other', 'Read', { file_path: '/x' }));
    s.map({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_enter', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_other', content: 'ok' },
      ] },
      tool_use_result: enterResult(SIBLING),
    });
    assert.equal(s.cwd, REPO);
    assert.equal(calls.length, 0);
  } finally { dispose(); }
});

test('裁决拒绝时保持原样、不重播', () => {
  const { s, dispose, settledCount } = session(() => null);
  try {
    s.map(toolUse('toolu_enter', 'EnterWorktree', { path: '/etc' }));
    s.map(toolResult('toolu_enter', enterResult('/etc')));
    assert.equal(s.cwd, REPO, '拒绝必须是「保持原样」，不是回退到别的目录');
    assert.equal(settledCount(), 0);
  } finally { dispose(); }
});

test('hook 与 tool_result 先后到达只重播一次——两条通道报的是同一次换目录', async () => {
  // server 归一：CLI 报的原串与 realpath 后的值不同（macOS /tmp → /private/tmp 同形态）
  const { s, dispose, settledCount } = session(next => `/private${next}`);
  try {
    s.abort = new AbortController();
    const hook = buildAgentQueryOptions(s, { ...process.env })?.hooks?.CwdChanged?.[0]?.hooks?.[0];
    await hook({ hook_event_name: 'CwdChanged', old_cwd: REPO, new_cwd: SIBLING });
    s.map(toolUse('toolu_enter', 'EnterWorktree', { path: SIBLING }));
    s.map(toolResult('toolu_enter', enterResult(SIBLING)));
    assert.equal(s.cwd, `/private${SIBLING}`);
    assert.equal(settledCount(), 1, '同一次换目录重播两次 = 前端多一次无意义重建；归一后相同就是同一个值');
  } finally { dispose(); }
});
