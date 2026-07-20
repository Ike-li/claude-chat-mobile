// tests/unit/agent-diag-log.test.mjs —— 验证 agent.js 的排队/停止/控制操作正确记入
// diag-log.js 诊断时间线。独立于 agent-control.test.mjs/agent-permissions.test.mjs
// （behavior domain 各自聚焦"操作本身对不对"，这里聚焦"操作是否被诊断时间线正确记录"），
// 避免把断言塞进那两个已逼近 800 行门禁的文件（见 tests/unit/source-layout.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';
import * as diagLog from '../../src/agent/diag-log.js';

test.describe('_raceControlRequest → diag-log race_settle（5 个共享通道调用点）', () => {
  test('set_model 成功 → control/race_settle(ok:true)', async () => {
    const { s } = makeSession({ model: 'sonnet' });
    s.q = { setModel() { return Promise.resolve(); } };
    await s.send('hi', 'opus');
    const diag = diagLog.getDiagLogs(s.logKey()).at(-1);
    assert.equal(diag.subsystem, 'control');
    assert.equal(diag.event, 'race_settle');
    assert.equal(diag.detail.tag, 'set_model');
    assert.equal(diag.detail.ok, true);
    s.dispose();
  });

  test('set_model 挂起超时 → control/race_settle(ok:false, error 含 timeout)', async () => {
    const { s } = makeSession({ model: 'sonnet' });
    s.interruptTimeoutMs = 20;
    s.q = { setModel() { return new Promise(() => {}); } };
    await s.send('hi', 'opus');
    const diag = diagLog.getDiagLogs(s.logKey()).at(-1);
    assert.equal(diag.subsystem, 'control');
    assert.equal(diag.detail.tag, 'set_model');
    assert.equal(diag.detail.ok, false);
    assert.ok(diag.detail.error.includes('set_model_timeout'));
    assert.ok(typeof diag.detail.ms === 'number');
    s.dispose();
  });

  test('interrupt 成功 → interrupt/race_settle(ok:true)', async () => {
    const { s } = makeSession();
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    const race = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'interrupt' && e.event === 'race_settle').at(-1);
    assert.ok(race);
    assert.equal(race.detail.tag, 'interrupt');
    assert.equal(race.detail.ok, true);
    s.dispose();
  });

  test('interrupt 挂起超时 → interrupt/race_settle(ok:false)', async () => {
    const { s } = makeSession();
    s.pendingTurns = 1;
    s.interruptTimeoutMs = 20;
    s.abort = { abort() {} };
    s.q = { interrupt() { return new Promise(() => {}); } };
    await s.interrupt();
    const race = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'interrupt' && e.event === 'race_settle').at(-1);
    assert.ok(race);
    assert.equal(race.detail.ok, false);
    s.dispose();
  });

  test('stop_task 挂起超时 → interrupt/race_settle(tag:stop_task, ok:false)', async () => {
    const { s } = makeSession();
    s.interruptTimeoutMs = 20;
    s.q = { stopTask() { return new Promise(() => {}); } };
    await s.stopTask('task-1');
    const diag = diagLog.getDiagLogs(s.logKey()).at(-1);
    assert.equal(diag.subsystem, 'interrupt');
    assert.equal(diag.detail.tag, 'stop_task');
    assert.equal(diag.detail.ok, false);
    s.dispose();
  });

  test('cancel_async_message 挂起超时 → queue/race_settle(tag:cancel_async_message, ok:false)', async () => {
    const { s } = makeSession();
    s.interruptTimeoutMs = 20;
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    s.queue = [];
    s.q = { cancelAsyncMessage: () => new Promise(() => {}) };
    await s.cancelQueued('c2');
    const diag = diagLog.getDiagLogs(s.logKey()).at(-1);
    assert.equal(diag.subsystem, 'queue');
    assert.equal(diag.detail.tag, 'cancel_async_message');
    assert.equal(diag.detail.ok, false);
    s.dispose();
  });

  test('set_permission_mode 挂起超时 → control/race_settle(tag:set_permission_mode, ok:false)', async () => {
    const { s } = makeSession({ permissionMode: 'default' });
    s.interruptTimeoutMs = 20;
    s.q = { setPermissionMode() { return new Promise(() => {}); } };
    await s.setPermissionMode('plan');
    const diag = diagLog.getDiagLogs(s.logKey()).at(-1);
    assert.equal(diag.subsystem, 'control');
    assert.equal(diag.detail.tag, 'set_permission_mode');
    assert.equal(diag.detail.ok, false);
    s.dispose();
  });

  // 禁用超时（interruptTimeoutMs<=0）与非 promise 退化路径：既有大量单测靠这两条路径避免真等超时，
  // 不应该被诊断埋点污染出多余记录。
  test('interruptTimeoutMs 禁用（<=0）→ 不记录（防污染既有大量单测）', async () => {
    const { s } = makeSession();
    s.interruptTimeoutMs = 0;
    s.q = { interrupt() { return Promise.resolve(); } };
    const beforeCount = diagLog.getDiagLogs(s.logKey()).length; // 本文件共享 instanceId:'test'，只看"新增部分"
    await s.interrupt();
    const newEntries = diagLog.getDiagLogs(s.logKey()).slice(beforeCount);
    // ms<=0 时 _raceControlRequest 直接 return，不应新增 race_settle；interrupt.settled（P0-2）仍会记一条
    assert.equal(newEntries.filter(e => e.event === 'race_settle').length, 0);
    assert.ok(newEntries.some(e => e.event === 'settled'));
    s.dispose();
  });
});

test.describe('interrupt() 整体结果 → diag-log interrupt/settled', () => {
  test('成功 → settled(outcome:success)', async () => {
    const { s } = makeSession();
    s.pendingTurns = 1;
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    const settled = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'interrupt' && e.event === 'settled').at(-1);
    assert.ok(settled);
    assert.equal(settled.detail.outcome, 'success');
    assert.equal(settled.detail.timedOut, false);
    assert.ok(typeof settled.detail.ms === 'number');
    s.dispose();
  });

  test('挂起超时强制收口 → settled(outcome:forced_settle, timedOut:true)', async () => {
    const { s } = makeSession();
    s.pendingTurns = 1;
    s.interruptTimeoutMs = 20;
    s.abort = { abort() {} };
    s.q = { interrupt() { return new Promise(() => {}); } };
    await s.interrupt();
    const settled = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'interrupt' && e.event === 'settled').at(-1);
    assert.ok(settled);
    assert.equal(settled.detail.outcome, 'forced_settle');
    assert.equal(settled.detail.timedOut, true);
    s.dispose();
  });

  test('SDK 抛错且无在途轮 → settled(outcome:no_task)', async () => {
    const { s } = makeSession();
    s.pendingTurns = 0;
    s.q = { interrupt() { return Promise.reject(new Error('no task')); } };
    await s.interrupt();
    const settled = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'interrupt' && e.event === 'settled').at(-1);
    assert.ok(settled);
    assert.equal(settled.detail.outcome, 'no_task');
    s.dispose();
  });

  test('await 期间 disposed → settled(outcome:disposed)', async () => {
    const { s } = makeSession();
    let releaseInterrupt;
    s.q = { interrupt: () => new Promise(r => { releaseInterrupt = r; }) };
    const p = s.interrupt();
    s.dispose();
    releaseInterrupt();
    await p;
    const settled = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'interrupt' && e.event === 'settled').at(-1);
    assert.ok(settled);
    assert.equal(settled.detail.outcome, 'disposed');
  });
});

test.describe('result 分支 → diag-log queue/turn_settled', () => {
  test('正常 result（未中断）→ turn_settled(wasInterrupted:false)', () => {
    const { s } = makeSession();
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    const settled = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'queue' && e.event === 'turn_settled').at(-1);
    assert.ok(settled);
    assert.equal(settled.detail.wasInterrupted, false);
    assert.equal(settled.detail.isError, false);
    assert.equal(settled.detail.durationMs, 10);
    s.dispose();
  });

  test('interrupt() 成功后紧跟的 result → turn_settled(wasInterrupted:true)，一次性消费不残留', async () => {
    const { s } = makeSession();
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    s.map({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, modelUsage: {} });
    const first = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'queue' && e.event === 'turn_settled').at(-1);
    assert.equal(first.detail.wasInterrupted, true);

    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 20, modelUsage: {} });
    const second = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'queue' && e.event === 'turn_settled').at(-1);
    assert.equal(second.detail.wasInterrupted, false, '标记应一次性消费，不残留到下一轮');
    s.dispose();
  });
});
