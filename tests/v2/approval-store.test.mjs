// tests/v2/approval-store.test.mjs —— 审批持久化台账与重启 fail-closed
// 守护：APPROVAL-02（重启后 pending 全部 expired、decidedBy=system:restart，不可再执行）
// 覆盖：重启 pending 变 expired（decidedBy=system:restart）+ 单向终态 + 重复 reqId 溯源 + 留存清理防越界 + 容错不阻塞
// 槽位：S1（纯函数 + 状态机 + 一次性文件落盘）
// 不测什么 + 为什么：不测真实 AgentSession 的 canUseTool SDK 挂起（属于 S2 server-approval 槽）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let AS;
let AL;
let TMP_DIR;
let STORE_FILE;

test.before(async () => {
  TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-v2-approval-store-'));
  STORE_FILE = join(TMP_DIR, 'approval-requests.json');
  process.env.CCM_APPROVAL_STORE_FILE = STORE_FILE;
  AS = await import('../../app/src/agent/approval-store.js');
  AL = await import('../../app/src/agent/approval-lifecycle.js');
});

test.after(() => {
  delete process.env.CCM_APPROVAL_STORE_FILE;
  if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test.describe('APPROVAL-02: 审批台账记录与状态机单向终态', () => {
  test('recordCreated: 新增记录初始状态为 pending，decided 字段为空', () => {
    AS.recordCreated({
      reqId: 'req-001',
      sessionId: 'sess-001',
      tool: 'Bash',
      args: { command: 'echo hello' },
      cwd: '/workspace',
      fingerprint: 'fp-001',
      risk: null,
      createdAt: 1000,
      expiresAt: 2000,
    });

    const entry = AS.getByReqId('req-001');
    assert.ok(entry);
    assert.equal(entry.status, 'pending');
    assert.equal(entry.decidedBy, null);
    assert.equal(entry.decidedAt, null);
    assert.equal(entry.tool, 'Bash');
    assert.equal(entry.fingerprint, 'fp-001');
  });

  test('recordDecided: 决断后落入终态，记录决断者与时间戳', () => {
    AS.recordCreated({
      reqId: 'req-002',
      sessionId: 'sess-001',
      tool: 'Edit',
      args: { path: 'foo.txt' },
      cwd: '/workspace',
      fingerprint: 'fp-002',
      createdAt: 1000,
      expiresAt: 2000,
    });

    AS.recordDecided('req-002', {
      status: 'approved',
      decidedBy: 'user:device_1',
      decidedAt: 1500,
    });

    const entry = AS.getByReqId('req-002');
    assert.equal(entry.status, 'approved');
    assert.equal(entry.decidedBy, 'user:device_1');
    assert.equal(entry.decidedAt, 1500);
  });

  test('重复 reqId（如跨进程或计数器回绕）：recordDecided 优先匹配处于 pending 的记录', () => {
    // 模拟旧会话有一条已 expired 的同名 reqId
    AS.recordCreated({
      reqId: 'req-dup',
      sessionId: 'sess-old',
      tool: 'Bash',
      args: {},
      cwd: '/workspace',
      fingerprint: 'fp-old',
      createdAt: 100,
      expiresAt: 200,
    });
    AS.recordDecided('req-dup', { status: 'expired', decidedBy: 'system:restart', decidedAt: 300 });

    // 新会话分配了相同 reqId，处于 pending
    AS.recordCreated({
      reqId: 'req-dup',
      sessionId: 'sess-new',
      tool: 'Bash',
      args: {},
      cwd: '/workspace',
      fingerprint: 'fp-new',
      createdAt: 500,
      expiresAt: 600,
    });

    // 决断新请求，必须更新 pending 的新记录，而不得污染旧记录
    AS.recordDecided('req-dup', { status: 'approved', decidedBy: 'user:device_2', decidedAt: 550 });

    const all = AS.getAll().filter(r => r.reqId === 'req-dup');
    assert.equal(all.length, 2);
    assert.equal(all[0].sessionId, 'sess-old');
    assert.equal(all[0].status, 'expired', '旧记录保持 expired 终态');
    assert.equal(all[1].sessionId, 'sess-new');
    assert.equal(all[1].status, 'approved', '新记录被成功批准');
  });

  test('未知 reqId 调用 recordDecided 静默忽略，不抛出异常', () => {
    assert.doesNotThrow(() => {
      AS.recordDecided('req-nonexistent', { status: 'denied', decidedBy: 'system', decidedAt: 100 });
    });
  });
});

test.describe('APPROVAL-02: 重启 fail-closed 与留存治理边界', () => {
  test('expireAllPending: 遗留 pending 记录一律标记 expired，decidedBy=system:restart', () => {
    AS.recordCreated({
      reqId: 'req-restart-1',
      sessionId: 'sess-reboot',
      tool: 'Bash',
      args: {},
      cwd: '/workspace',
      fingerprint: 'fp-rst-1',
      createdAt: 1000,
      expiresAt: 2000,
    });
    AS.recordCreated({
      reqId: 'req-restart-2',
      sessionId: 'sess-reboot',
      tool: 'Bash',
      args: {},
      cwd: '/workspace',
      fingerprint: 'fp-rst-2',
      createdAt: 1000,
      expiresAt: 2000,
    });
    // req-restart-2 提前完成终态
    AS.recordDecided('req-restart-2', { status: 'denied', decidedBy: 'user', decidedAt: 1200 });

    const count = AS.expireAllPending({ decidedBy: 'system:restart', decidedAt: 9999 });
    assert.ok(count >= 1);

    const r1 = AS.getByReqId('req-restart-1');
    assert.equal(r1.status, 'expired');
    assert.equal(r1.decidedBy, 'system:restart');
    assert.equal(r1.decidedAt, 9999);

    const r2 = AS.getByReqId('req-restart-2');
    assert.equal(r2.status, 'denied', '已决断的 denied 记录不被 expireAllPending 覆盖');
    assert.equal(r2.decidedBy, 'user');
  });

  test('expireOrphanedPending: 启动生命周期钩子标记并生成审计日志', () => {
    const mockStore = {
      expireAllPending: ({ decidedBy, decidedAt }) => {
        assert.equal(decidedBy, 'system:restart');
        assert.ok(decidedAt > 0);
        return 3;
      },
    };
    const audits = [];
    const count = AL.expireOrphanedPending({
      store: mockStore,
      recordAudit: (entry) => audits.push(entry),
    });

    assert.equal(count, 3);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'approval_restart_expired');
    assert.equal(audits[0].outcome, 'expired');
    assert.equal(audits[0].meta.count, 3);
  });

  test('purgeTerminalOlderThan: 终态记录超时清理，但 pending 记录绝不因留存清理被误删', () => {
    AS.recordCreated({
      reqId: 'req-pending-alive',
      sessionId: 'sess-alive',
      tool: 'Bash',
      args: {},
      cwd: '/workspace',
      fingerprint: 'fp-alive',
      createdAt: 100,
      expiresAt: 200,
    });

    AS.recordCreated({
      reqId: 'req-old-terminal',
      sessionId: 'sess-old',
      tool: 'Bash',
      args: {},
      cwd: '/workspace',
      fingerprint: 'fp-old',
      createdAt: 100,
      expiresAt: 200,
    });
    AS.recordDecided('req-old-terminal', { status: 'approved', decidedBy: 'user', decidedAt: 250 });

    // 清理 cutoffTs 为 500 前的记录
    const purged = AS.purgeTerminalOlderThan(500);
    assert.ok(purged >= 1);

    // req-old-terminal 的 decidedAt(250) < 500，应被清理
    assert.equal(AS.getByReqId('req-old-terminal'), null);

    // req-pending-alive 虽然 createdAt(100) < 500，但由于 status=pending，必须严格保留！
    assert.ok(AS.getByReqId('req-pending-alive') !== null, 'pending 记录必须豁免留存治理清理');
  });

  test('flushSaveSync: 退出时同步落盘并生成 0600 权限文件', () => {
    AS.flushSaveSync();
    assert.ok(existsSync(STORE_FILE), '台账文件必须已落盘');
    const content = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    assert.ok(Array.isArray(content.requests));
  });
});

// ── 边界：台账两端 ──────────────────────────────────────────────────────────
// 2026-09-05 变异实测补的两条。放在文件最后，因为第一条会先把共享台账清空。
test.describe('APPROVAL-02: 索引 0 与保留期分界', () => {
  // 共享同一个模块实例，先确定性清空：把残留 pending 全部终态化，再用一个【高于所有可能
  // decidedAt】的 cutoff 清掉全部终态记录。cutoff 必须够大——前面的用例用了 250/1200/1500
  // 这类时间戳，随手写个小 cutoff 会把它们留在台账里，让本节的计数断言从一开始就对不上。
  const emptyStore = () => {
    AS.expireAllPending({ decidedBy: 'system:test-reset', decidedAt: 1 });
    AS.purgeTerminalOlderThan(Number.MAX_SAFE_INTEGER);
  };

  // ★ approval-store.js:84 的 `i >= 0` 改成 `i > 0` 时，此前【没有一条用例变红】。
  // 那个倒序循环不是随手写的：注释详述它是为修「张冠李戴」而来的——原来的 find 取首个匹配＝
  // 最旧那条，用户这次的批准被写到早已 expired 的历史记录上，本次的新记录永远停在 pending。
  //
  // `i > 0` 让【索引 0 永不被检查】。既有用例全都在台账里已有别的记录之后才建目标记录
  // （模块状态整份文件共享），目标从来不在索引 0 上，所以恒绿。而索引 0 恰恰是最常见的场景：
  // 全新安装上的第一次审批——那一次的决定会被静默丢弃，台账里查不到任何人批准过。
  test('★ 台账里只有一条记录时也必须找得到（索引 0 不得被跳过）', () => {
    emptyStore();
    AS.recordCreated({
      reqId: 'req-solo',
      sessionId: 'sess-solo',
      tool: 'Bash',
      args: { command: 'ls' },
      cwd: '/workspace',
      fingerprint: 'fp-solo',
      createdAt: 1000,
      expiresAt: 2000,
    });

    AS.recordDecided('req-solo', { status: 'approved', decidedBy: 'user:device_1', decidedAt: 1500 });

    const entry = AS.getByReqId('req-solo');
    assert.ok(entry, '唯一一条记录必须仍在台账里');
    assert.equal(entry.status, 'approved', '索引 0 被跳过时它会停在 pending —— 决定被静默丢弃');
    assert.equal(entry.decidedBy, 'user:device_1');
    assert.equal(entry.decidedAt, 1500);
  });

  // purgeTerminalOlderThan 的判据是 `(r.decidedAt ?? 0) >= cutoffTs` 才【保留】。
  // 改成 `>` 时恰好等于分界的那条会被清掉，而既有用例用的是 250 vs 500（离分界很远），两侧都清。
  test('保留期分界：decidedAt 恰好等于 cutoffTs 的记录必须保留', () => {
    emptyStore();
    const CUTOFF = 5000;
    for (const [reqId, decidedAt] of [['req-at-edge', CUTOFF], ['req-just-below', CUTOFF - 1]]) {
      AS.recordCreated({
        reqId, sessionId: 's', tool: 'Bash', args: {}, cwd: '/w',
        fingerprint: `fp-${reqId}`, createdAt: 1, expiresAt: 2,
      });
      AS.recordDecided(reqId, { status: 'approved', decidedBy: 'user', decidedAt });
    }

    const purged = AS.purgeTerminalOlderThan(CUTOFF);
    assert.equal(purged, 1, '只该清掉严格早于分界的那一条');
    assert.ok(AS.getByReqId('req-at-edge'), 'decidedAt === cutoffTs 属于保留侧');
    assert.equal(AS.getByReqId('req-just-below'), null);
  });
});
