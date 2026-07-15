import test from 'node:test';
import assert from 'node:assert/strict';

import { approvalRetentionMs, expireOrphanedPending, startApprovalRetentionSweep } from '../../src/agent/approval-lifecycle.js';

test.describe('approvalRetentionMs（APPROVAL_RETENTION_DAYS 解析）', () => {
  const DAY = 24 * 60 * 60 * 1000;
  test('默认 90 天', () => {
    assert.equal(approvalRetentionMs({}), 90 * DAY);
  });
  test('合法正数按天换算', () => {
    assert.equal(approvalRetentionMs({ APPROVAL_RETENTION_DAYS: '7' }), 7 * DAY);
  });
  test('0/负数/非数字回落默认 90 天', () => {
    assert.equal(approvalRetentionMs({ APPROVAL_RETENTION_DAYS: '0' }), 90 * DAY);
    assert.equal(approvalRetentionMs({ APPROVAL_RETENTION_DAYS: '-3' }), 90 * DAY);
    assert.equal(approvalRetentionMs({ APPROVAL_RETENTION_DAYS: 'abc' }), 90 * DAY);
  });
});

test('expireOrphanedPending：有遗留 pending → 标 expired 并记审计', () => {
  const calls = { expire: null, audit: [] };
  const n = expireOrphanedPending({
    store: { expireAllPending: (arg) => { calls.expire = arg; return 3; } },
    recordAudit: (rec) => calls.audit.push(rec),
  });
  assert.equal(n, 3);
  assert.equal(calls.expire.decidedBy, 'system:restart');
  assert.equal(calls.audit.length, 1);
  assert.equal(calls.audit[0].action, 'approval_restart_expired');
  assert.equal(calls.audit[0].meta.count, 3);
});

test('expireOrphanedPending：无遗留 → 不记审计', () => {
  const audits = [];
  const n = expireOrphanedPending({
    store: { expireAllPending: () => 0 },
    recordAudit: (rec) => audits.push(rec),
  });
  assert.equal(n, 0);
  assert.equal(audits.length, 0);
});

test('startApprovalRetentionSweep：启动即清一次、清理数>0 记审计、定时器已 unref', () => {
  const audits = [];
  let purgeCalls = 0;
  let unrefed = false;
  const timer = startApprovalRetentionSweep({
    env: { APPROVAL_RETENTION_DAYS: '30' },
    store: { purgeTerminalOlderThan: () => { purgeCalls++; return purgeCalls === 1 ? 2 : 0; } },
    recordAudit: (rec) => audits.push(rec),
    setIntervalImpl: (fn, ms) => {
      assert.equal(ms, 24 * 60 * 60 * 1000);
      return { unref: () => { unrefed = true; } };
    },
  });
  assert.equal(purgeCalls, 1); // 启动即跑一次
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'retention_cleanup');
  assert.equal(audits[0].meta.count, 2);
  assert.equal(unrefed, true);
  assert.ok(timer);
});
