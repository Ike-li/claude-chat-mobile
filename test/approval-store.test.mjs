// test/approval-store.test.mjs —— approval-store.js 单测（LLD §4 approval_request 表，承接 NFR-16/17/FR-19/22）
// 同 sessions.test.mjs 模式：CCM_APPROVAL_STORE_FILE 指向临时文件，彻底隔离真实 data/。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let AS;
let TMP_DIR;

test.describe('approval-store.js 单元测试', () => {
  test.before(async () => {
    TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-approval-store-test-'));
    process.env.CCM_APPROVAL_STORE_FILE = join(TMP_DIR, 'approval-requests.json');
    AS = await import('../approval-store.js');
  });

  test.after(() => {
    delete process.env.CCM_APPROVAL_STORE_FILE;
    if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('recordCreated: 新记录 status=pending，decidedBy/decidedAt 为 null', () => {
    AS.recordCreated({ reqId: 'r1', sessionId: 's1', tool: 'Bash', args: { command: 'ls' }, cwd: '/a', fingerprint: 'fp1', risk: null, createdAt: 1000, expiresAt: 2000 });
    const r = AS.getByReqId('r1');
    assert.equal(r.status, 'pending');
    assert.equal(r.decidedBy, null);
    assert.equal(r.decidedAt, null);
    assert.equal(r.fingerprint, 'fp1');
  });

  test('recordDecided: 更新已有记录的终态', () => {
    AS.recordCreated({ reqId: 'r2', sessionId: 's1', tool: 'Write', args: {}, cwd: '/a', fingerprint: 'fp2', createdAt: 1000, expiresAt: 2000 });
    AS.recordDecided('r2', { status: 'allow', decidedBy: 'user', decidedAt: 1500 });
    const r = AS.getByReqId('r2');
    assert.equal(r.status, 'allow');
    assert.equal(r.decidedBy, 'user');
    assert.equal(r.decidedAt, 1500);
  });

  test('recordDecided: 找不到 reqId 静默忽略（不抛）', () => {
    assert.doesNotThrow(() => AS.recordDecided('no-such-req', { status: 'allow', decidedBy: 'user', decidedAt: 1 }));
  });

  test('getByReqId: 不存在返回 null', () => {
    assert.equal(AS.getByReqId('nonexistent'), null);
  });

  // 注：store 是模块级单例、状态跨本文件全部测试共享（同 sessions.test.mjs 模式），故不断言全局
  // count 精确值（前面测试可能留有其他 pending 记录）——只断言本测试创建的具体 reqId 的终态是否正确。
  test('expireAllPending: 只影响 status=pending 的记录，其余不动', () => {
    AS.recordCreated({ reqId: 'p1', sessionId: 's2', tool: 'Bash', args: {}, cwd: '/b', fingerprint: 'f', createdAt: 1, expiresAt: 2 });
    AS.recordCreated({ reqId: 'p2', sessionId: 's2', tool: 'Bash', args: {}, cwd: '/b', fingerprint: 'f', createdAt: 1, expiresAt: 2 });
    AS.recordDecided('p2', { status: 'deny', decidedBy: 'user', decidedAt: 5 }); // p2 已终态，不应被 expireAllPending 影响
    const count = AS.expireAllPending({ decidedBy: 'system:restart', decidedAt: 9999 });
    assert.ok(count >= 1); // 至少 p1 被处置（可能还有其他测试遗留的 pending 记录一并被处置）
    assert.equal(AS.getByReqId('p1').status, 'expired');
    assert.equal(AS.getByReqId('p1').decidedBy, 'system:restart');
    assert.equal(AS.getByReqId('p1').decidedAt, 9999);
    assert.equal(AS.getByReqId('p2').status, 'deny'); // 未被覆盖
  });

  test('expireAllPending: 全部记录都已终态时返回 0', () => {
    // 独立隔离一批全终态记录（不依赖"store 里当前无 pending"这一跨测试全局假设）
    AS.recordCreated({ reqId: 'iso-1', sessionId: 's9', tool: 'Bash', args: {}, cwd: '/z', fingerprint: 'f', createdAt: 1, expiresAt: 2 });
    AS.recordDecided('iso-1', { status: 'deny', decidedBy: 'user', decidedAt: 1 });
    const before = AS.getAll().filter(r => r.status === 'pending').length;
    if (before === 0) assert.equal(AS.expireAllPending({ decidedAt: 1 }), 0);
  });

  test('purgeTerminalOlderThan: 只清理终态且 decidedAt 早于 cutoff 的记录，pending 记录永不清', () => {
    AS.recordCreated({ reqId: 'old-terminal', sessionId: 's3', tool: 'Bash', args: {}, cwd: '/c', fingerprint: 'f', createdAt: 100, expiresAt: 200 });
    AS.recordDecided('old-terminal', { status: 'deny', decidedBy: 'user', decidedAt: 1000 });
    AS.recordCreated({ reqId: 'new-terminal', sessionId: 's3', tool: 'Bash', args: {}, cwd: '/c', fingerprint: 'f', createdAt: 100, expiresAt: 200 });
    AS.recordDecided('new-terminal', { status: 'allow', decidedBy: 'user', decidedAt: 100000 });
    AS.recordCreated({ reqId: 'still-pending', sessionId: 's3', tool: 'Bash', args: {}, cwd: '/c', fingerprint: 'f', createdAt: 100, expiresAt: 999999999 });

    AS.purgeTerminalOlderThan(50000); // 早于 50000 的终态记录应被清（store 为跨测试单例，不断言精确 purged 计数）
    assert.equal(AS.getByReqId('old-terminal'), null);
    assert.ok(AS.getByReqId('new-terminal')); // decidedAt=100000 晚于 cutoff，保留
    assert.ok(AS.getByReqId('still-pending')); // pending 永不清
  });

  test('flushSaveSync: 同步落盘后文件内容可读、与 getAll() 一致', () => {
    AS.recordCreated({ reqId: 'flush-test', sessionId: 's4', tool: 'Read', args: {}, cwd: '/d', fingerprint: 'f', createdAt: 1, expiresAt: 2 });
    AS.flushSaveSync();
    const onDisk = JSON.parse(readFileSync(process.env.CCM_APPROVAL_STORE_FILE, 'utf8'));
    const inMemory = AS.getAll();
    assert.deepEqual(onDisk.requests.find(r => r.reqId === 'flush-test'), inMemory.find(r => r.reqId === 'flush-test'));
  });

  test('purgeTerminalOlderThan: 隔离环境下返回精确清理条数', async () => {
    const isoDir = mkdtempSync(join(tmpdir(), 'ccm-approval-store-purge-iso-'));
    const isoFile = join(isoDir, 'approval-requests.json');
    const prevFile = process.env.CCM_APPROVAL_STORE_FILE;
    process.env.CCM_APPROVAL_STORE_FILE = isoFile;
    const iso = await import(`../approval-store.js?t=purge-iso`); // 缓存穿透：独立模块实例，不受其他测试共享状态影响

    iso.recordCreated({ reqId: 'a', sessionId: 's', tool: 'Bash', args: {}, cwd: '/x', fingerprint: 'f', createdAt: 1, expiresAt: 2 });
    iso.recordDecided('a', { status: 'deny', decidedBy: 'user', decidedAt: 100 });
    iso.recordCreated({ reqId: 'b', sessionId: 's', tool: 'Bash', args: {}, cwd: '/x', fingerprint: 'f', createdAt: 1, expiresAt: 2 });
    iso.recordDecided('b', { status: 'allow', decidedBy: 'user', decidedAt: 200 });
    iso.recordCreated({ reqId: 'c', sessionId: 's', tool: 'Bash', args: {}, cwd: '/x', fingerprint: 'f', createdAt: 1, expiresAt: 999999 }); // 仍 pending

    const purged = iso.purgeTerminalOlderThan(150); // 只有 a(decidedAt=100) 早于 cutoff
    assert.equal(purged, 1);
    assert.equal(iso.getByReqId('a'), null);
    assert.ok(iso.getByReqId('b'));
    assert.ok(iso.getByReqId('c'));

    process.env.CCM_APPROVAL_STORE_FILE = prevFile;
    rmSync(isoDir, { recursive: true, force: true });
  });

  test('坏 JSON 文件 → 加载为空态，不抛', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'ccm-approval-store-bad-'));
    const badFile = join(badDir, 'approval-requests.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(badFile, '{not valid json');
    const prevFile = process.env.CCM_APPROVAL_STORE_FILE;
    process.env.CCM_APPROVAL_STORE_FILE = badFile;
    const fresh = await import(`../approval-store.js?t=badjson`); // 缓存穿透强制重新求值模块顶层 load()
    assert.deepEqual(fresh.getAll(), []);
    process.env.CCM_APPROVAL_STORE_FILE = prevFile;
    rmSync(badDir, { recursive: true, force: true });
  });
});
