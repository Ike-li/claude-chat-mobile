// tests/invariants/approval-allow-once.test.mjs —— 普通「允许」只放行这一次，不得顺带给整个会话升档
// 守护：APPROVAL-01（所批即所行：批的是这一次写文件，就不能连带把会话切到 acceptEdits、让之后的写删移都不再审批）
// 测什么：app/src/agent/agent.js 的 resolvePermission 怎么处理 CLI 随审批附带的 setMode 建议——普通「允许」
//   不回传给 SDK、不改实例档、不广播 permission_mode；勾了「总是允许」（本会话 / 永久）照旧生效。后一侧同时是
//   正对照：证明这几个观察点看得见档位真的变了，否则「没升档」和「看不见升档」结果一样。
//   夹具形状照真机 server 日志（2026-09-11 的 [canUseTool] 行，规则正文换成占位）：Write 只带一条
//   setMode acceptEdits；越界 Bash 带 addRules(localSettings) + addDirectories(session) + setMode 三条。
// 不测什么 + 为什么：① CLI 收到不带 setMode 的 allow 之后，下一次写文件是不是真的再弹审批——要真模型回合，归 S5
//   ② ExitPlanMode 退出时用户自选的档：批准它本身就是切档，不归这条红线，在 tests/unit/agent-permissions.test.mjs
// 槽位：S1（纯内存，AgentSession 不起 CLI）

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';

const SET_ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
const WRITE = {
  tool: 'Write',
  input: { file_path: '/tmp/test/notes.md', content: 'x' },
  suggestions: [SET_ACCEPT_EDITS],
};
const BASH_OUTSIDE_DIR = {
  tool: 'Bash',
  input: { command: 'mkdir -p /tmp/elsewhere/out' },
  suggestions: [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p /tmp/elsewhere/out' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/tmp/elsewhere'], destination: 'session' },
    SET_ACCEPT_EDITS,
  ],
};

// 照真实链路走一遍：SDK 调 canUseTool → 手机上点「允许」（回传卡片所见的 op）→ 返回 SDK 收到的 PermissionResult。
// always / persist 与前端 answerPerm 发的两个字段同义：persist 只在勾了「总是允许」时才可能为真。
function approve(s, { tool, input, suggestions }, { always = false, persist = false } = {}) {
  const toolUseID = `t-${tool}`;
  const pending = s.handleCanUseTool(tool, input, { signal: new AbortController().signal, toolUseID, suggestions });
  s.resolvePermission(toolUseID, 'allow', always, { tool, args: input, cwd: s.cwd }, persist ? { persistRules: true } : undefined);
  return pending;
}

for (const startMode of ['default', 'plan']) {
  test(`${startMode} 档：Write 附带 setMode 建议，普通「允许」只放行这一次，会话不升档`, async () => {
    const { s, events } = makeSession({ permissionMode: startMode });
    const res = await approve(s, WRITE);
    assert.equal(res.behavior, 'allow', '前提：这一次确实批准了');
    assert.ok(!(res.updatedPermissions || []).some(u => u.type === 'setMode'),
      'setMode 回传给 SDK，CLI 就把整个会话切到 acceptEdits：之后的写、删、移全都不再弹审批');
    assert.equal(s.permissionMode, startMode, '实例档变了，说明这次普通允许被当成了一次切档');
    assert.equal(events.find(e => e.type === 'permission_mode'), undefined, '广播了 permission_mode，手机端的档位图标会被切走');
    s.dispose();
  });
}

test('越界 Bash 附带目录、落盘规则与 setMode 三条建议，普通「允许」一条都不回传', async () => {
  const { s, events } = makeSession();
  const res = await approve(s, BASH_OUTSIDE_DIR);
  assert.equal(res.behavior, 'allow', '前提：这一次确实批准了');
  assert.equal(res.updatedPermissions, undefined, '普通允许不得留下任何持续生效的授权（档位、目录、规则都算）');
  assert.equal(s.permissionMode, 'default', '实例档变了，说明这次普通允许被当成了一次切档');
  assert.equal(events.find(e => e.type === 'permission_mode'), undefined, '广播了 permission_mode，手机端的档位图标会被切走');
  s.dispose();
});

for (const [label, fixture, opts] of [
  ['本会话内总是允许', WRITE, { always: true }],
  ['永久不再问', BASH_OUTSIDE_DIR, { always: true, persist: true }],
]) {
  test(`勾「${label}」：setMode 照旧回传，实例档切到 acceptEdits 并广播（正对照）`, async () => {
    const { s, events } = makeSession();
    const res = await approve(s, fixture, opts);
    assert.deepEqual((res.updatedPermissions || []).filter(u => u.type === 'setMode'), [SET_ACCEPT_EDITS],
      '用户选了「总是允许」，CLI 建议的切档就该回传；这里不红，上面那几条「没升档」才有意义');
    assert.equal(s.permissionMode, 'acceptEdits', '实例档要跟上 SDK 实际所在的档');
    assert.equal(events.find(e => e.type === 'permission_mode')?.payload.mode, 'acceptEdits', '手机端图标靠这条事件跟随');
    s.dispose();
  });
}
