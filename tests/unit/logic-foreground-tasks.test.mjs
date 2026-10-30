// tests/unit/logic-foreground-tasks.test.mjs —— 转后台（#459）的前端纯逻辑
// normalizeForegroundTasks：foreground_tasks 快照 → 前端用的列表（输入条「转后台」看有没有，工具卡按 toolUseId 对）；
// backgroundTasksErrorText：task:background 回执 → 失败时给用户的一句话（原因分档见 agent.backgroundTasks）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForegroundTasks, backgroundTasksErrorText } from '../../app/public/js/logic.js';

test('normalizeForegroundTasks：只留有 taskId 的条目；toolUseId 缺席记 null（只能整体转后台）', () => {
  assert.deepEqual(normalizeForegroundTasks([
    { taskId: 't1', toolUseId: 'toolu_1', taskType: 'local_bash', description: 'sleep 120' },
    { taskId: 't2', toolUseId: '', taskType: 'local_agent' },
    { toolUseId: 'toolu_x' },
    null,
    'junk',
  ]), [
    { taskId: 't1', toolUseId: 'toolu_1' },
    { taskId: 't2', toolUseId: null },
  ]);
});

test('normalizeForegroundTasks：不是数组（旧 server、坏载荷）→ 空列表', () => {
  for (const raw of [undefined, null, {}, 'x']) assert.deepEqual(normalizeForegroundTasks(raw), []);
});

test('backgroundTasksErrorText：成功回空串；各失败原因写成人话', () => {
  assert.equal(backgroundTasksErrorText({ ok: true }), '');
  assert.equal(backgroundTasksErrorText({ ok: false, reason: 'disabled', error: 'Background tasks are disabled in this session.' }),
    '这个会话禁用了后台任务（CLAUDE_CODE_DISABLE_BACKGROUND_TASKS）');
  assert.equal(backgroundTasksErrorText({ ok: false, reason: 'not_found' }), '这个任务已经不在前台了');
  assert.equal(backgroundTasksErrorText({ ok: false, reason: 'no_instance' }), '会话已经关闭，或正由终端驾驶');
  assert.equal(backgroundTasksErrorText({ ok: false, reason: 'error', error: 'control request timed out' }),
    '转后台失败：control request timed out');
  assert.equal(backgroundTasksErrorText(null), '转后台失败');
});
