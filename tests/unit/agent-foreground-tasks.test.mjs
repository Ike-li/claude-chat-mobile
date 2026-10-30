// tests/unit/agent-foreground-tasks.test.mjs —— 转后台（#459，SDK backgroundTasks，等价终端 Ctrl+B）
// 覆盖：前台任务集合（输入条「转后台」与工具卡「后台运行」只在它非空时出现）的进出口与全量广播；
//       backgroundTasks(toolUseId?) 的透传与失败分档。
// 前台任务的形态见 agent-background-tasks.test.mjs 那段 2026-09-09 探针记录：跑得久的前台 Bash / 子代理
// 也会发 task_started{is_backgrounded:false}，转后台经 task_updated patch.is_backgrounded=true 到达。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';

const started = (taskId, extra) => ({
  type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `toolu_${taskId}`,
  description: 'sleep 120 && echo done', is_backgrounded: false, task_type: 'local_bash', ...extra,
});
const fgSnapshots = events => events.filter(e => e.type === 'foreground_tasks').map(e => e.payload.tasks);
const lastFg = events => fgSnapshots(events).at(-1);

test.describe('前台任务集合（foreground_tasks 全量快照）', () => {
  test('前台 task_started 进集合，广播全量快照', () => {
    const { s, events } = makeSession();
    s.map(started('t1'));
    assert.deepEqual(lastFg(events), [
      { taskId: 't1', toolUseId: 'toolu_t1', taskType: 'local_bash', description: 'sleep 120 && echo done' },
    ]);
    s.map(started('t2', { task_type: 'local_agent', description: '调研' }));
    assert.deepEqual(lastFg(events).map(t => t.taskId), ['t1', 't2']);
    s.dispose();
  });

  test('后台 task_started、不带 is_backgrounded 的不进集合，也不广播', () => {
    const { s, events } = makeSession();
    s.map(started('bg', { is_backgrounded: true }));
    s.map(started('wf', { is_backgrounded: undefined, task_type: 'local_workflow' }));
    assert.deepEqual(fgSnapshots(events), []);
    s.dispose();
  });

  test('task_updated 转后台（终端 Ctrl+B 或这里点的）→ 出集合', () => {
    const { s, events } = makeSession();
    s.map(started('t1'));
    s.map({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { is_backgrounded: true } });
    assert.deepEqual(lastFg(events), []);
    s.dispose();
  });

  test('task_notification（跑完 / 停掉）→ 出集合', () => {
    const { s, events } = makeSession();
    s.map(started('t1'));
    s.map({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done' });
    assert.deepEqual(lastFg(events), []);
    s.dispose();
  });

  test('本轮结束兜底清空：漏了事件也最多残留到这一轮结束', () => {
    const { s, events } = makeSession();
    s.map(started('t1'));
    s.map({ type: 'result', subtype: 'success', duration_ms: 10, modelUsage: {} });
    assert.deepEqual(lastFg(events), []);
    s.dispose();
  });

  test('集合没变就不重发（task_updated 只改了别的字段、结果到了但本来就空）', () => {
    const { s, events } = makeSession();
    s.map(started('t1'));
    s.map({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } });
    assert.equal(fgSnapshots(events).length, 1);
    const { s: s2, events: events2 } = makeSession();
    s2.map({ type: 'result', subtype: 'success', duration_ms: 10, modelUsage: {} });
    assert.deepEqual(fgSnapshots(events2), []);
    s.dispose();
    s2.dispose();
  });

  test('emitForegroundTasks() 按当前集合重发一次（sync:since 补推用，空集合也发）', () => {
    const { s, events } = makeSession();
    s.emitForegroundTasks();
    assert.deepEqual(lastFg(events), []);
    s.map(started('t1'));
    s.emitForegroundTasks();
    assert.equal(fgSnapshots(events).length, 3);
    assert.deepEqual(lastFg(events).map(t => t.taskId), ['t1']);
    s.dispose();
  });
});

test.describe('backgroundTasks(toolUseId?)', () => {
  test('带 toolUseId 原样透传；不带就是全部转后台（Ctrl+B）', async () => {
    const { s } = makeSession();
    const calls = [];
    s.q = { backgroundTasks(id) { calls.push(id); return Promise.resolve(true); } };
    assert.deepEqual(await s.backgroundTasks('toolu_1'), { ok: true });
    assert.deepEqual(await s.backgroundTasks(), { ok: true });
    assert.deepEqual(calls, ['toolu_1', undefined]);
    s.dispose();
  });

  test('SDK 回 false（给的 toolUseId 没对上前台任务）→ not_found', async () => {
    const { s } = makeSession();
    s.q = { backgroundTasks: () => Promise.resolve(false) };
    assert.deepEqual(await s.backgroundTasks('toolu_gone'), { ok: false, reason: 'not_found' });
    s.dispose();
  });

  test('会话禁用了后台任务 → disabled，带 CLI 原文；其它异常 → error，不向外抛', async () => {
    const { s } = makeSession();
    s.q = { backgroundTasks: () => Promise.reject(new Error('Background tasks are disabled in this session.')) };
    assert.deepEqual(await s.backgroundTasks(), {
      ok: false, reason: 'disabled', error: 'Background tasks are disabled in this session.',
    });
    s.q = { backgroundTasks: () => Promise.reject(new Error('boom')) };
    assert.deepEqual(await s.backgroundTasks(), { ok: false, reason: 'error', error: 'boom' });
    s.dispose();
  });

  test('dispose 之后、没有 q 时不调 SDK', async () => {
    const { s } = makeSession();
    assert.deepEqual(await s.backgroundTasks(), { ok: false, reason: 'no_instance' });
    let called = false;
    s.q = { backgroundTasks() { called = true; return Promise.resolve(true); } };
    s.dispose();
    assert.deepEqual(await s.backgroundTasks(), { ok: false, reason: 'no_instance' });
    assert.equal(called, false);
  });
});
