// tests/unit/agent-diag-log.test.mjs —— 验证 agent.js 的排队/停止/控制操作正确记入
// diag-log.js 诊断时间线。独立于 agent-control.test.mjs/agent-permissions.test.mjs
// （behavior domain 各自聚焦"操作本身对不对"，这里聚焦"操作是否被诊断时间线正确记录"），
// 避免把断言塞进那两个已逼近 800 行门禁的文件（见 tests/unit/source-layout.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';
import * as diagLog from '../../src/agent/diag-log.js';

test.describe('_raceControlRequest → diag-log race_settle（4 个共享通道调用点）', () => {
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

test.describe('fetchUsage() 失败 → diag-log statusline/rate_reason_change（去重防刷屏）', () => {
  test('无方法首次调用 → 记一条 reason:rpc_no_method，previousReason:null', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-diag-nomethod' });
    s.q = { interrupt: async () => {} }; // 无 usage_EXPERIMENTAL... 方法
    await s.fetchUsage();
    const entries = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'rate_reason_change');
    assert.equal(entries[0].detail.reason, 'rpc_no_method');
    assert.equal(entries[0].detail.previousReason, null);
    s.dispose();
  });

  test('无方法连续两次调用 → 仅记一条（去重，防高频刷新刷屏）', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-diag-nomethod-dedup' });
    s.q = { interrupt: async () => {} };
    await s.fetchUsage();
    await s.fetchUsage();
    const entries = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    s.dispose();
  });

  test('RPC 抛错 → 记一条 reason:rpc_error，detail.message 含错误信息', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-diag-error' });
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('boom'); } };
    await s.fetchUsage();
    const entries = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail.reason, 'rpc_error');
    assert.ok(entries[0].detail.message.includes('boom'));
    assert.equal(entries[0].detail.timedOut, false);
    s.dispose();
  });

  test('RPC 超时 → 记一条 reason:rpc_error，detail.timedOut:true', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-diag-timeout' });
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) };
    await s.fetchUsage(10);
    const entries = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail.reason, 'rpc_error');
    assert.equal(entries[0].detail.timedOut, true);
    s.dispose();
  });

  test('原因切换（无方法→抛错）→ 记两条，reason 依次变化', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-diag-switch' });
    s.q = { interrupt: async () => {} }; // 无方法
    await s.fetchUsage();
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('x'); } };
    await s.fetchUsage();
    const entries = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].detail.reason, 'rpc_no_method');
    assert.equal(entries[1].detail.reason, 'rpc_error');
    assert.equal(entries[1].detail.previousReason, 'rpc_no_method');
    s.dispose();
  });

  test('成功调用 → 不新增记录、不清空 lastRateUnavailableReason（恢复判定交给 statusline 层）', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-diag-success-after-fail' });
    s.q = { interrupt: async () => {} };
    await s.fetchUsage(); // 记一条 rpc_no_method
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true }) };
    await s.fetchUsage(); // 成功：不应记录、不应清空字段
    const entries = diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'statusline');
    assert.equal(entries.length, 1);
    assert.equal(s.lastRateUnavailableReason, 'rpc_no_method');
    s.dispose();
  });
});

test.describe('init 接线 → diagLog.rebindDiagLogs（FRESH 首轮 provisional 记录不丢）', () => {
  test('init 到达前的诊断记录，init 后仍可用真 sessionId 读到', async () => {
    const { s } = makeSession({ instanceId: 'rebind-diag-test' });
    const pk = s.logKey(); // 未定 sessionId：provisional key
    s.interruptTimeoutMs = 20;
    s.q = { interrupt() { return new Promise(() => {}); } };
    await s.interrupt(); // 造一条 provisional 期诊断记录（interrupt/race_settle + interrupt/settled）
    assert.ok(diagLog.getDiagLogs(pk).length > 0, '前置条件：provisional key 下应已有记录');

    s.map({ type: 'system', subtype: 'init', session_id: 'rebind-real-sid', model: 'opus', cwd: '/tmp/test' });

    assert.equal(s.sessionId, 'rebind-real-sid');
    assert.deepEqual(diagLog.getDiagLogs(pk), [], 'rebind 后 provisional key 应清空');
    assert.ok(diagLog.getDiagLogs('rebind-real-sid').length > 0, 'rebind 后应能用真 sessionId 读到 provisional 期记录');
    s.dispose();
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
