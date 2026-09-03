// tests/unit/agent-diag-log.test.mjs —— 验证 agent.js 的排队/停止/控制操作正确记入
// diag-log.js 诊断时间线。独立于 agent-control.test.mjs/agent-permissions.test.mjs
// （behavior domain 各自聚焦"操作本身对不对"，这里聚焦"操作是否被诊断时间线正确记录"），
// 避免把断言塞进那两个已各自成域的文件（拆分判据见 tests/unit/source-layout.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';
import * as diagLog from '../../app/src/agent/diag-log.js';

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

// 契约反转（2026-08-01）：fetchUsage 此前自己写 statusline/rate_reason_change，但 agent 层看不到
// 下游的快照回落结果，只能以「这一拍 RPC 成不成功」为准——单拍超时即翻转、下一拍成功再翻回，
// 一次瞬时抖动被放大成两条醒目日志，而那一刻状态栏上的额度其实一直在（rateFromSnapshot 垫底）。
// 判定与写入现已【整体上移】到 app/src/ops/statusline.js#resolveRateReason / recordRateReasonIfChanged，
// 那里能看到 p.rate 的最终值。本层只留结构化事实，不写任何 diag。别把判定挪回来。
test.describe('fetchUsage() 只留结构化事实，自己不写 diag（判定已上移 statusline 层）', () => {
  const statuslineEntries = s => diagLog.getDiagLogs(s.logKey()).filter(e => e.subsystem === 'statusline');

  test('无 usage 方法 → 不写 diag，原因留在 lastUsageFetchFailure', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-fact-nomethod' });
    s.q = { interrupt: async () => {} }; // 无 usage_EXPERIMENTAL... 方法
    assert.equal(await s.fetchUsage(), null);
    assert.equal(statuslineEntries(s).length, 0);
    assert.equal(s.lastUsageFetchFailure.reason, 'rpc_no_method');
    s.dispose();
  });

  test('RPC 抛错 → 不写 diag，lastUsageFetchFailure 含 message 且 timedOut:false', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-fact-error' });
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('boom'); } };
    assert.equal(await s.fetchUsage(), null);
    assert.equal(statuslineEntries(s).length, 0);
    assert.equal(s.lastUsageFetchFailure.reason, 'rpc_error');
    assert.ok(s.lastUsageFetchFailure.message.includes('boom'));
    assert.equal(s.lastUsageFetchFailure.timedOut, false);
    s.dispose();
  });

  test('RPC 超时 → 不写 diag，timedOut:true 且带耗时 ms（判断 1500ms 是否太紧的实测依据）', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-fact-timeout' });
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) };
    assert.equal(await s.fetchUsage(10), null);
    assert.equal(statuslineEntries(s).length, 0);
    assert.equal(s.lastUsageFetchFailure.reason, 'rpc_error');
    assert.equal(s.lastUsageFetchFailure.timedOut, true);
    assert.ok(Number.isFinite(s.lastUsageFetchFailure.ms));
    s.dispose();
  });

  test('成功 → 清空 lastUsageFetchFailure、记录 lastUsageOkMs，仍不写 diag', async () => {
    const { s } = makeSession({ instanceId: 'fetchusage-fact-success' });
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('x'); } };
    await s.fetchUsage();
    assert.equal(s.lastUsageFetchFailure.reason, 'rpc_error');
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true }) };
    await s.fetchUsage(1500, { minIntervalMs: 0 }); // 绕开节流窗，直取本拍结果
    assert.equal(statuslineEntries(s).length, 0);
    assert.equal(s.lastUsageFetchFailure, null);
    assert.ok(Number.isFinite(s.lastUsageOkMs));
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
