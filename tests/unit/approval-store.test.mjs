// tests/unit/approval-store.test.mjs —— approval-store.js 单测（docs/design.md approval_request 表，承接 NFR-16/17/FR-19/22）
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
    AS = await import('../../src/agent/approval-store.js');
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
    const iso = await import(`../../src/agent/approval-store.js?t=purge-iso`); // 缓存穿透：独立模块实例，不受其他测试共享状态影响

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
    const fresh = await import(`../../src/agent/approval-store.js?t=badjson`); // 缓存穿透强制重新求值模块顶层 load()
    assert.deepEqual(fresh.getAll(), []);
    process.env.CCM_APPROVAL_STORE_FILE = prevFile;
    rmSync(badDir, { recursive: true, force: true });
  });
});

// reqId 在跨进程/跨实例时会重复：toolUseID 由 SDK 给，而回落分支 `perm_${++this.permSeq}` 更是
// 每实例从 0 起的计数器。终态记录留存 90 天（purgeTerminalOlderThan 之前一直在数组里），而
// recordDecided 用 find 取【首个】匹配 = 最旧的那条 —— 于是用户这次的批准被写到一条早已 expired 的
// 历史记录上，本次真实的新记录永远停在 pending。事后审计张冠李戴：查不到谁批准了什么。
// 这条在本次代码审查里真实触发过（绕过测试隔离写进生产台账的旧 store-t1 被新请求命中）。
test('recordDecided 落到仍 pending 的那条，不改写同 reqId 的历史终态', async () => {
  // 隔离方式与 purge 用例一致：先建独立临时文件并改 env，再缓存穿透 import —— 顺序反了的话新实例
  // 仍会读到共享文件里其它用例的记录。
  const isoDir = mkdtempSync(join(tmpdir(), 'ccm-approval-store-dup-iso-'));
  const prevFile = process.env.CCM_APPROVAL_STORE_FILE;
  process.env.CCM_APPROVAL_STORE_FILE = join(isoDir, 'approval-requests.json');
  const iso = await import('../../src/agent/approval-store.js?t=dup-reqid-iso');
  try {
    const reqId = 'dup-reqid';
    const base = { reqId, sessionId: 's1', tool: 'Bash', args: { command: 'ls' }, cwd: '/tmp/p', fingerprint: 'fp', createdAt: 1, expiresAt: 9_999_999_999_999 };

    iso.recordCreated(base);                                        // 上一进程遗留的同 reqId 记录
    iso.expireAllPending({ decidedBy: 'system:restart', decidedAt: 2 });
    iso.recordCreated({ ...base, sessionId: 's2', createdAt: 3 });  // 本次新请求，reqId 撞上了

    iso.recordDecided(reqId, { status: 'allow', decidedBy: 'user', decidedAt: 4 });

    const rows = iso.getAll().filter(r => r.reqId === reqId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'expired', '历史终态不得被改写成 allow');
    assert.equal(rows[0].decidedBy, 'system:restart');
    assert.equal(rows[1].status, 'allow', '真正落定的必须是本次那条 pending');
    assert.equal(rows[1].decidedBy, 'user');
  } finally {
    iso.flushSaveSync();
    if (prevFile === undefined) delete process.env.CCM_APPROVAL_STORE_FILE;
    else process.env.CCM_APPROVAL_STORE_FILE = prevFile;
    rmSync(isoDir, { recursive: true, force: true });
  }
});
