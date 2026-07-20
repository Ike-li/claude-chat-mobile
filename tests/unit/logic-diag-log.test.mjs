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
