// test/audit.test.mjs —— audit.js 单测（LLD §4 audit_record 表，承接 FR-19/NFR-06/NFR-16）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let AU;
let TMP_DIR;

test.describe('audit.js 单元测试', () => {
  test.before(async () => {
    TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-audit-test-'));
    process.env.CCM_AUDIT_FILE = join(TMP_DIR, 'audit-records.json');
    AU = await import('../audit.js');
  });

  test.after(() => {
    delete process.env.CCM_AUDIT_FILE;
    if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('recordAudit: 生成 id/ts，字段原样透传', () => {
    const r = AU.recordAudit({ actor: { deviceId: 'dev1', via: 'web' }, action: 'scope_violation', target: '/etc', outcome: 'denied', meta: { relPath: '../x' } });
    assert.ok(typeof r.id === 'string' && r.id.length > 0);
    assert.ok(typeof r.ts === 'number');
    assert.deepEqual(r.actor, { deviceId: 'dev1', via: 'web' });
    assert.equal(r.action, 'scope_violation');
    assert.equal(r.target, '/etc');
    assert.equal(r.outcome, 'denied');
    assert.deepEqual(r.meta, { relPath: '../x' });
  });

  test('recordAudit: 每条记录 id 唯一', () => {
    const a = AU.recordAudit({ action: 'x' });
    const b = AU.recordAudit({ action: 'x' });
    assert.notEqual(a.id, b.id);
  });

  test('recordAudit: actor 缺省时补 { deviceId: null, via: null }', () => {
    const r = AU.recordAudit({ action: 'auth_rate_limited', target: '1.2.3.4' });
    assert.deepEqual(r.actor, { deviceId: null, via: null });
  });

  test('listRecent: 默认最新在前', () => {
    AU.recordAudit({ action: 'order-test-1' });
    AU.recordAudit({ action: 'order-test-2' });
    const rows = AU.listRecent({ limit: 2 });
    assert.equal(rows[0].action, 'order-test-2');
    assert.equal(rows[1].action, 'order-test-1');
  });

  test('listRecent: 按 action 过滤', () => {
    AU.recordAudit({ action: 'filter-target', target: 't1' });
    AU.recordAudit({ action: 'filter-other' });
    const rows = AU.listRecent({ limit: 100, action: 'filter-target' });
    assert.ok(rows.every(r => r.action === 'filter-target'));
    assert.ok(rows.some(r => r.target === 't1'));
  });

  test('listRecent: 按 since 过滤', () => {
    const before = AU.recordAudit({ action: 'since-old' });
    const cutoff = before.ts + 1;
    const after = AU.recordAudit({ action: 'since-new' });
    // 时钟精度可能相同 ts；只断言 old 不在结果里（new 的 ts 若与 cutoff 相同也应保留，>= 语义）
    const rows = AU.listRecent({ limit: 1000, since: after.ts });
    assert.ok(rows.some(r => r.id === after.id));
    assert.ok(!rows.some(r => r.id === before.id) || before.ts >= after.ts);
  });

  test('环形上限：写入超过 capacity() 后自动轮转最旧', async () => {
    const isoDir = mkdtempSync(join(tmpdir(), 'ccm-audit-ring-iso-'));
    const isoFile = join(isoDir, 'audit-records.json');
    const prevFile = process.env.CCM_AUDIT_FILE;
    const prevCap = process.env.AUDIT_RECORD_CAP;
    process.env.CCM_AUDIT_FILE = isoFile;
    process.env.AUDIT_RECORD_CAP = '3'; // 小上限，便于快速验证轮转
    const iso = await import(`../audit.js?t=ring-iso`); // 缓存穿透：独立模块实例，读取新的 CAP 值

    assert.equal(iso.capacity(), 3);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(iso.recordAudit({ action: `ring-${i}` }).id);
    const all = iso.getAll();
    assert.equal(all.length, 3); // 上限=3，只保留最新 3 条
    assert.deepEqual(all.map(r => r.action), ['ring-2', 'ring-3', 'ring-4']); // 最旧 2 条被轮转掉

    process.env.CCM_AUDIT_FILE = prevFile;
    if (prevCap === undefined) delete process.env.AUDIT_RECORD_CAP; else process.env.AUDIT_RECORD_CAP = prevCap;
    rmSync(isoDir, { recursive: true, force: true });
  });

  test('flushSaveSync: 同步落盘后文件内容与 getAll() 一致', () => {
    const r = AU.recordAudit({ action: 'flush-test' });
    AU.flushSaveSync();
    const onDisk = JSON.parse(readFileSync(process.env.CCM_AUDIT_FILE, 'utf8'));
    assert.ok(onDisk.records.some(x => x.id === r.id));
  });

  test('坏 JSON 文件 → 加载为空态，不抛', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'ccm-audit-bad-'));
    const badFile = join(badDir, 'audit-records.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(badFile, 'not json{{{');
    const prevFile = process.env.CCM_AUDIT_FILE;
    process.env.CCM_AUDIT_FILE = badFile;
    const fresh = await import(`../audit.js?t=badjson`);
    assert.deepEqual(fresh.getAll(), []);
    process.env.CCM_AUDIT_FILE = prevFile;
    rmSync(badDir, { recursive: true, force: true });
  });
});
