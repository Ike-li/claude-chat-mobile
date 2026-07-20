// tests/unit/diag-log.test.mjs —— diag-log.js 纯逻辑单测
import test from 'node:test';
import assert from 'node:assert/strict';
import * as diag from '../../src/agent/diag-log.js';

test.describe('diag-log', () => {
  test('getDiagLogs：null/undefined/空 sessionKey → []', () => {
    assert.deepEqual(diag.getDiagLogs(null), []);
    assert.deepEqual(diag.getDiagLogs(undefined), []);
    assert.deepEqual(diag.getDiagLogs(''), []);
  });

  test('getDiagLogs：不存在的 sessionKey → []', () => {
    assert.deepEqual(diag.getDiagLogs('nonexistent'), []);
  });

  test('record + getDiagLogs：正常读写', () => {
    diag.record('s1', 'mirror', 'state_change', { readonly: true });
    const logs = diag.getDiagLogs('s1');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].subsystem, 'mirror');
    assert.equal(logs[0].event, 'state_change');
    assert.deepEqual(logs[0].detail, { readonly: true });
    assert.ok(typeof logs[0].ts === 'number');
  });

  test('record：不同 session 隔离', () => {
    diag.record('iso-1', 'queue', 'enqueued', {});
    diag.record('iso-2', 'interrupt', 'settled', {});
    assert.equal(diag.getDiagLogs('iso-1').length, 1);
    assert.equal(diag.getDiagLogs('iso-2').length, 1);
  });

  test('record：多条按顺序追加', () => {
    diag.record('order-1', 'queue', 'a', { i: 1 });
    diag.record('order-1', 'queue', 'b', { i: 2 });
    const logs = diag.getDiagLogs('order-1');
    assert.equal(logs.length, 2);
    assert.equal(logs[0].event, 'a');
    assert.equal(logs[1].event, 'b');
  });

  test('record：null/undefined/空 sessionKey → 诚实丢弃，不写入', () => {
    diag.record(null, 'mirror', 'x', {});
    diag.record(undefined, 'mirror', 'x', {});
    diag.record('', 'mirror', 'x', {});
    assert.deepEqual(diag.getDiagLogs(null), []);
    assert.deepEqual(diag.getDiagLogs(''), []);
  });

  test('record：detail 缺省 → 空对象', () => {
    diag.record('no-detail', 'control', 'race_settle');
    const logs = diag.getDiagLogs('no-detail');
    assert.deepEqual(logs[0].detail, {});
  });

  test('record：单会话上限 100 条，FIFO 淘汰最旧', () => {
    for (let i = 0; i < 150; i++) diag.record('buf-test', 'queue', 'tick', { i });
    const logs = diag.getDiagLogs('buf-test');
    assert.ok(logs.length <= 100);
    assert.equal(logs[0].detail.i, 50); // 0-49 被挤出
    assert.equal(logs[99].detail.i, 149);
  });

  test('record：detail 序列化超长 → 截断并标记 _truncated', () => {
    const huge = { blob: 'x'.repeat(5000) };
    diag.record('huge-detail', 'mirror', 'entry_lock_decision', huge);
    const entry = diag.getDiagLogs('huge-detail')[0];
    // 截断后的 detail 序列化长度应远小于原始 5000+ 字符
    assert.ok(JSON.stringify(entry.detail).length <= diag.MAX_DETAIL_CHARS + 200);
    assert.equal(entry.detail._truncated, true);
  });

  test('record：正常大小 detail 不触发截断标记', () => {
    diag.record('normal-detail', 'interrupt', 'settled', { outcome: 'success', ms: 42 });
    const entry = diag.getDiagLogs('normal-detail')[0];
    assert.equal(entry.detail._truncated, undefined);
  });

  test('setCallback：record 触发回调', () => {
    let called = null;
    diag.setCallback((key, entry) => { called = { key, subsystem: entry.subsystem, event: entry.event }; });
    diag.record('cb-test', 'queue', 'turn_settled', {});
    assert.ok(called);
    assert.equal(called.key, 'cb-test');
    assert.equal(called.subsystem, 'queue');
    assert.equal(called.event, 'turn_settled');
    diag.setCallback(null);
  });

  // FRESH 首轮：sessionId 未到前用 provisionalKey 缓冲，init 后 rebind 并入真 sessionId。
  // provisionalKey 直接复用 interaction-log.js 的实现，两模块 key 语义必须一致。
  test('provisionalKey：与 interaction-log 共用同一实现', async () => {
    const ilog = await import('../../src/agent/interaction-log.js');
    assert.equal(diag.provisionalKey, ilog.provisionalKey);
    assert.equal(diag.provisionalKey('inst_fresh'), 'inst:inst_fresh');
    assert.equal(diag.provisionalKey(null), null);
  });

  test('rebindDiagLogs：首轮诊断记录不丢', () => {
    const pk = diag.provisionalKey('inst_diag');
    diag.record(pk, 'mirror', 'entry_lock_decision', { locked: true });
    diag.record(pk, 'queue', 'enqueued', {});
    assert.equal(diag.getDiagLogs(pk).length, 2);
    assert.deepEqual(diag.getDiagLogs('real-sid-diag'), []);

    diag.rebindDiagLogs(pk, 'real-sid-diag');
    assert.deepEqual(diag.getDiagLogs(pk), [], 'provisional 键清空');
    const logs = diag.getDiagLogs('real-sid-diag');
    assert.equal(logs.length, 2);
    assert.equal(logs[0].event, 'entry_lock_decision');
    assert.equal(logs[1].event, 'enqueued');

    // rebind 后继续写真 session，追加在后
    diag.record('real-sid-diag', 'interrupt', 'settled', {});
    assert.equal(diag.getDiagLogs('real-sid-diag').length, 3);
    assert.equal(diag.getDiagLogs('real-sid-diag')[2].event, 'settled');
  });

  test('rebindDiagLogs：空/同键/无 pending → no-op 不抛', () => {
    diag.rebindDiagLogs(null, 's');
    diag.rebindDiagLogs('inst:x', null);
    diag.rebindDiagLogs('inst:x', 'inst:x');
    diag.rebindDiagLogs('inst:never-written-diag', 's-empty-diag');
    assert.deepEqual(diag.getDiagLogs('s-empty-diag'), []);
  });

  // 防 buffers 无界增长：常驻 server 长跑下按 sessionKey 无限累积。放最后：本用例创建
  // 大量 session 触发淘汰，会清掉前面用例的缓冲，须在它们跑完后执行（同 interaction.test.mjs 惯例）。
  test('record：会话数超上限 200 → 最旧会话缓冲被 FIFO 淘汰', () => {
    for (let i = 0; i < 400; i++) diag.record(`dlk-${i}`, 'mirror', 'x', {});
    assert.deepEqual(diag.getDiagLogs('dlk-0'), [], '最旧会话缓冲应被淘汰');
    assert.equal(diag.getDiagLogs('dlk-399').length, 1, '最新会话缓冲应保留');
  });
});
