// tests/unit/audit.test.mjs —— audit.js 单测（audit_record 表，承接 FR-19/NFR-06/NFR-16）
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
    AU = await import('../../app/src/ops/audit.js');
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

  // 两条必须是不同的事件：完全相同的两条在 60 秒内会合并成一条（下面「合并」那组），id 本来就该相同
  test('recordAudit: 每条记录 id 唯一', () => {
    const a = AU.recordAudit({ action: 'x', target: 'id-a' });
    const b = AU.recordAudit({ action: 'x', target: 'id-b' });
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

  // ★ 原断言 `!rows.some(...) || before.ts >= after.ts` 的后半句在两次同步调用背靠背时几乎恒真
  // （不可能跨毫秒），于是即便 listRecent 完全忽略 since、返回全量，这条测试也会绿。改用显式
  // 传入的 ts 精确构造三个时间点，直接验证 since 的 >= 边界语义（恰好等于某条记录 ts 时应保留）。
  test('listRecent: 按 since 过滤（含 >= 边界：since 恰好等于某条记录 ts 时应保留）', () => {
    const before = AU.recordAudit({ action: 'since-old', ts: 1000 });
    const after = AU.recordAudit({ action: 'since-new', ts: 2000 });
    const rows = AU.listRecent({ limit: 1000, since: 1500 });
    assert.ok(rows.some(r => r.id === after.id), 'since 之后的记录必须保留');
    assert.ok(!rows.some(r => r.id === before.id), 'since 之前的记录必须被过滤掉');

    const boundary = AU.listRecent({ limit: 1000, since: after.ts });
    assert.ok(boundary.some(r => r.id === after.id), 'since 恰好等于该记录 ts 时应保留（>= 语义）');
    assert.ok(!boundary.some(r => r.id === before.id));
  });

  test('环形上限：写入超过 capacity() 后自动轮转最旧', async () => {
    const isoDir = mkdtempSync(join(tmpdir(), 'ccm-audit-ring-iso-'));
    const isoFile = join(isoDir, 'audit-records.json');
    const prevFile = process.env.CCM_AUDIT_FILE;
    const prevCap = process.env.AUDIT_RECORD_CAP;
    process.env.CCM_AUDIT_FILE = isoFile;
    process.env.AUDIT_RECORD_CAP = '3'; // 小上限，便于快速验证轮转
    const iso = await import(`../../app/src/ops/audit.js?t=ring-iso`); // 缓存穿透：独立模块实例，读取新的 CAP 值

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

  // ── 合并完全相同的记录（2026-11-01）──────────────────────────────────────────
  // 一个每 12 秒触发一次的拒绝（抽屉轮询一个已删掉的文件夹）就是每小时 300 条，几小时把 5000 条环形上限里
  // 真正稀有的安全记录（设备批准、吊销、限速锁定）轮转掉。完全相同的记录在首条之后 60 秒内只计数不另起：
  // 信息不丢（第一次、最后一次、几次），占用降到每分钟至多一条。窗口从首条算起，持续的刷屏每分钟仍留一条新记录，
  // 看得出它还在发生。
  test.describe('合并：60 秒内完全相同的记录只计数', () => {
    let M;
    let mergeDir;
    test.before(async () => {
      mergeDir = mkdtempSync(join(tmpdir(), 'ccm-audit-merge-'));
      const prevFile = process.env.CCM_AUDIT_FILE;
      process.env.CCM_AUDIT_FILE = join(mergeDir, 'audit-records.json');
      M = await import('../../app/src/ops/audit.js?t=merge'); // 独立模块实例：记录数从 0 起，不受上面各条干扰
      process.env.CCM_AUDIT_FILE = prevFile;
    });
    test.after(() => { if (mergeDir) rmSync(mergeDir, { recursive: true, force: true }); });
    const rec = (ts, over = {}) => M.recordAudit({ action: 'scope_violation', target: '/gone', outcome: 'denied', meta: { via: 'routeCwd' }, ts, ...over });

    test('两个目标交替刷（两个消失的文件夹被同一轮轮询）：各合并成一条，记次数与最后一次', () => {
      const t0 = 1_000_000;
      for (let i = 0; i < 5; i++) {
        rec(t0 + i * 12_000, { target: '/gone-a' });
        rec(t0 + i * 12_000 + 5, { target: '/gone-b' });
      }
      const rows = M.getAll().filter(r => r.ts >= t0 && r.ts < t0 + 60_000);
      assert.deepEqual(rows.map(r => [r.target, r.repeat, r.lastTs]), [
        ['/gone-a', 5, t0 + 48_000],
        ['/gone-b', 5, t0 + 48_005],
      ]);
    });

    test('从首条起满 60 秒另起一条；首条之后的单条没有 repeat 字段', () => {
      const t0 = 2_000_000;
      const first = rec(t0, { target: '/gone-c' });
      rec(t0 + 59_999, { target: '/gone-c' });
      const next = rec(t0 + 60_000, { target: '/gone-c' });
      assert.notEqual(next.id, first.id);
      assert.equal(first.repeat, 2);
      assert.equal(next.repeat, undefined, '单独一条的形态不变，旧记录与读取方不受影响');
    });

    test('任何一个字段不同都不合并：actor、target、outcome、meta', () => {
      const t0 = 3_000_000;
      const base = { action: 'device_approved', target: 'dev-1', outcome: 'allowed', meta: { via: 'web' }, actor: { deviceId: 'd1', via: 'web' } };
      M.recordAudit({ ...base, ts: t0 });
      M.recordAudit({ ...base, actor: { deviceId: 'd2', via: 'web' }, ts: t0 + 1 });
      M.recordAudit({ ...base, target: 'dev-2', ts: t0 + 2 });
      M.recordAudit({ ...base, outcome: 'error', ts: t0 + 3 });
      M.recordAudit({ ...base, meta: { via: 'cli' }, ts: t0 + 4 });
      const rows = M.getAll().filter(r => r.ts >= t0 && r.ts < t0 + 60_000);
      assert.equal(rows.length, 5);
      assert.ok(rows.every(r => r.repeat === undefined));
    });
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
    const fresh = await import(`../../app/src/ops/audit.js?t=badjson`);
    assert.deepEqual(fresh.getAll(), []);
    process.env.CCM_AUDIT_FILE = prevFile;
    rmSync(badDir, { recursive: true, force: true });
  });
});
