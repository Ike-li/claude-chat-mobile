// tests/unit/logic-diag-log.test.mjs —— 诊断时间线前端渲染纯函数单测（零 DOM/零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagLogEntry, filterConsoleEntries } from '../../public/js/logic.js';

test.describe('formatDiagLogEntry：判定过的一句话 + severity，不裸吐 JSON', () => {
  test('*/race_settle 成功 → 中性文案带 tag 中文名与耗时', () => {
    const r = formatDiagLogEntry({ ts: 1, subsystem: 'control', event: 'race_settle', detail: { tag: 'set_model', ok: true, ms: 42 } });
    assert.equal(r.type, 'diag_control');
    assert.equal(r.severity, 'neutral');
    assert.ok(r.text.includes('42ms') || r.text.includes('42'));
    assert.ok(!r.text.includes('{'), '不应裸吐 JSON');
  });

  test('*/race_settle 超时失败 → severity=danger，带 error 文案', () => {
    const r = formatDiagLogEntry({ ts: 1, subsystem: 'interrupt', event: 'race_settle', detail: { tag: 'interrupt', ok: false, ms: 5000, error: 'interrupt_timeout' } });
    assert.equal(r.severity, 'danger');
    assert.ok(r.text.includes('interrupt_timeout'));
  });

  test('mirror/state_change：readonly=true/false 各自文案，带 reason', () => {
    const locked = formatDiagLogEntry({ ts: 1, subsystem: 'mirror', event: 'state_change', detail: { reason: 'entry_lock', readonly: true, prevReadonly: false, stale: false } });
    assert.equal(locked.type, 'diag_mirror');
    assert.ok(locked.text.includes('entry_lock'));
    assert.ok(locked.text.includes('锁定') || locked.text.includes('🔒'));

    const unlocked = formatDiagLogEntry({ ts: 1, subsystem: 'mirror', event: 'state_change', detail: { reason: 'view_cleared', readonly: false } });
    assert.ok(unlocked.text.includes('view_cleared'));
    assert.ok(unlocked.text.includes('解锁') || unlocked.text.includes('🔓'));
  });

  test('mirror/entry_lock_decision：locked=true/false 各自文案', () => {
    const locked = formatDiagLogEntry({ ts: 1, subsystem: 'mirror', event: 'entry_lock_decision', detail: { tailVerdict: 'pending', locked: true, agedOutStale: false } });
    assert.ok(locked.text.includes('pending'));

    const unlockedStale = formatDiagLogEntry({ ts: 1, subsystem: 'mirror', event: 'entry_lock_decision', detail: { tailVerdict: 'pending', locked: false, agedOutStale: true } });
    assert.ok(unlockedStale.text.includes('陈旧') || unlockedStale.text.includes('过期'));

    const unlockedSettled = formatDiagLogEntry({ ts: 1, subsystem: 'mirror', event: 'entry_lock_decision', detail: { tailVerdict: 'settled', locked: false, agedOutStale: false } });
    assert.ok(unlockedSettled.text.includes('settled'));
  });

  test('interrupt/settled：outcome 四态各自文案', () => {
    const success = formatDiagLogEntry({ ts: 1, subsystem: 'interrupt', event: 'settled', detail: { outcome: 'success', ms: 10, droppedCount: 2, timedOut: false } });
    assert.ok(success.text.includes('2'));
    assert.equal(success.severity, 'neutral');

    const forced = formatDiagLogEntry({ ts: 1, subsystem: 'interrupt', event: 'settled', detail: { outcome: 'forced_settle', ms: 5000, timedOut: true } });
    assert.equal(forced.severity, 'warning');
    assert.ok(forced.text.includes('超时') || forced.text.includes('强制'));

    const noTask = formatDiagLogEntry({ ts: 1, subsystem: 'interrupt', event: 'settled', detail: { outcome: 'no_task' } });
    assert.ok(noTask.text.includes('无') && noTask.text.includes('任务'));

    const disposed = formatDiagLogEntry({ ts: 1, subsystem: 'interrupt', event: 'settled', detail: { outcome: 'disposed' } });
    assert.ok(disposed.text.length > 0);
  });

  test('queue/turn_settled：wasInterrupted 区分文案', () => {
    const interrupted = formatDiagLogEntry({ ts: 1, subsystem: 'queue', event: 'turn_settled', detail: { wasInterrupted: true, durationMs: 100 } });
    assert.ok(interrupted.text.includes('中断'));

    const normal = formatDiagLogEntry({ ts: 1, subsystem: 'queue', event: 'turn_settled', detail: { wasInterrupted: false, durationMs: 100 } });
    assert.ok(!normal.text.includes('中断'));
  });

  // 2026-07-30：resume 不再释放（SIGTERM）CLI 后台锁，hadLock 这一路连同「先释放后台锁」文案一并撤掉。
  // 若哪天又冒出「锁」字样，说明那套破坏性逻辑被加回来了——见 src/ops/cli-bg-session-lock.js 头注释。
  test('resume/settled：带 ms 的简短文案，不再提「锁」', () => {
    const r = formatDiagLogEntry({ ts: 1, subsystem: 'resume', event: 'settled', detail: { ms: 850 } });
    assert.ok(r.text.includes('850'));
    assert.ok(!r.text.includes('锁'));
    // 陈旧 detail（老 server 推的 hadLock）不得让文案退回去
    const legacy = formatDiagLogEntry({ ts: 1, subsystem: 'resume', event: 'settled', detail: { hadLock: true, ms: 300 } });
    assert.ok(legacy.text.includes('300'));
    assert.ok(!legacy.text.includes('锁'));
  });

  test('catchup/tick：带 ms 的简短文案', () => {
    const r = formatDiagLogEntry({ ts: 1, subsystem: 'catchup', event: 'tick', detail: { ms: 12 } });
    assert.ok(r.text.includes('12'));
    assert.ok(!r.text.includes('{'));
  });

  test('message/enqueued：hasAttachments=true/false 各自文案，带 ms', () => {
    const withAttach = formatDiagLogEntry({ ts: 1, subsystem: 'message', event: 'enqueued', detail: { hasAttachments: true, ms: 500 } });
    assert.ok(withAttach.text.includes('500'));
    assert.ok(withAttach.text.includes('附件'));

    const noAttach = formatDiagLogEntry({ ts: 1, subsystem: 'message', event: 'enqueued', detail: { hasAttachments: false, ms: 80 } });
    assert.ok(noAttach.text.includes('80'));
    assert.ok(!noAttach.text.includes('附件'));
  });

  test('statusline/rate_reason_change：四种 reason 各自文案，third_party_auth=neutral，其余=warning', () => {
    const noMethod = formatDiagLogEntry({ ts: 1, subsystem: 'statusline', event: 'rate_reason_change', detail: { reason: 'rpc_no_method', previousReason: null } });
    assert.equal(noMethod.type, 'diag_statusline');
    assert.equal(noMethod.severity, 'warning');
    assert.ok(!noMethod.text.includes('{'));

    const rpcError = formatDiagLogEntry({ ts: 1, subsystem: 'statusline', event: 'rate_reason_change', detail: { reason: 'rpc_error', message: 'usage timeout', previousReason: null } });
    assert.equal(rpcError.severity, 'warning');
    assert.ok(rpcError.text.includes('usage timeout'), 'message 应拼进文案');

    const thirdParty = formatDiagLogEntry({ ts: 1, subsystem: 'statusline', event: 'rate_reason_change', detail: { reason: 'third_party_auth', previousReason: null } });
    assert.equal(thirdParty.severity, 'neutral', '第三方鉴权是预期状态，非故障');
    assert.ok(thirdParty.text.includes('鉴权'));

    const noWindow = formatDiagLogEntry({ ts: 1, subsystem: 'statusline', event: 'rate_reason_change', detail: { reason: 'no_valid_window', previousReason: null } });
    assert.equal(noWindow.severity, 'warning');
    assert.ok(!noWindow.text.includes('{'));
  });

  test('statusline/rate_reason_change：reason 为空 → 恢复文案，引用 previousReason 对应文案', () => {
    const recovered = formatDiagLogEntry({ ts: 1, subsystem: 'statusline', event: 'rate_reason_change', detail: { reason: null, previousReason: 'third_party_auth' } });
    assert.ok(recovered.text.includes('恢复'));
    assert.ok(recovered.text.includes('鉴权'), '应引用此前 third_party_auth 对应的文案');
  });

  test('未识别的 (subsystem,event) 组合 → 兜底渲染，不静默吞掉', () => {
    const r = formatDiagLogEntry({ ts: 1, subsystem: 'mirror', event: 'some_future_event', detail: { foo: 'bar' } });
    assert.ok(r.text.includes('mirror'));
    assert.ok(r.text.includes('some_future_event'));
    assert.equal(r.type, 'diag_mirror');
  });

  test('detail 缺省 → 不抛异常', () => {
    assert.doesNotThrow(() => formatDiagLogEntry({ ts: 1, subsystem: 'queue', event: 'turn_settled' }));
  });
});

test.describe('filterConsoleEntries：全部|交互|诊断 三态过滤', () => {
  const entries = [
    { type: 'user_in', text: 'hi' },
    { type: 'diag_mirror', text: 'locked' },
    { type: 'agent_result', text: 'done' },
    { type: 'diag_queue', text: 'settled' },
  ];

  test('"all" → 原样返回', () => {
    assert.deepEqual(filterConsoleEntries(entries, 'all'), entries);
  });

  test('"diag" → 只保留 type 以 diag_ 开头的条目', () => {
    const r = filterConsoleEntries(entries, 'diag');
    assert.equal(r.length, 2);
    assert.ok(r.every(e => e.type.startsWith('diag_')));
  });

  test('"interaction" → 排除 diag_ 前缀条目', () => {
    const r = filterConsoleEntries(entries, 'interaction');
    assert.equal(r.length, 2);
    assert.ok(r.every(e => !e.type.startsWith('diag_')));
  });

  test('未知 filter 值 → 原样返回（保守兜底）', () => {
    assert.deepEqual(filterConsoleEntries(entries, 'bogus'), entries);
  });

  test('空数组 → 空数组', () => {
    assert.deepEqual(filterConsoleEntries([], 'diag'), []);
  });
});
