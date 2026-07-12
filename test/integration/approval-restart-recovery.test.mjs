// test/integration/approval-restart-recovery.test.mjs —— 重启后 pending 审批 fail-closed 处置的
// 集成测试（LLD §4，承接 HLD AD-7/NFR-09/11，Phase 4）。
//
// 不需要真 claude 子进程/token——重启恢复是 server.js 模块顶层的一段同步逻辑（在 httpServer.listen
// 之前跑完），只要能触发一次 server.js 的模块求值就能验证，走"可靠集成"档（默认 npm test 就跑，
// 不像 claude-lifecycle 那样需要 RUN_CLAUDE_INTEGRATION）。
//
// 手法：先手写一份 approval-requests.json（模拟"上一个进程留下的 pending 审批"），再动态 import
// server.js 触发它的启动流程，验证该记录被标记为 expired + decidedBy='system:restart'，且写了一条
// 汇总 audit_record。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dataDir, httpServer, io;

async function startServerWithSeededPendingApproval() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-restart-recovery-test-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CCM_APPROVAL_STORE_FILE', 'CCM_AUDIT_FILE', 'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  // 显式覆盖（而非只靠 CCM_DATA_DIR 兜底）：npm test 的 --import ./test/_preload-env.mjs 已经在本进程
  // 全局设过 CCM_APPROVAL_STORE_FILE/CCM_AUDIT_FILE（优先级高于 CCM_DATA_DIR），若不在此显式覆盖，
  // approval-store.js 实际读写的会是预加载脚本给的另一个空临时文件，下面手写的种子数据根本读不到
  // （踩过这个坑：单跑本文件不带 --import 时能过，混进 npm test 全量跑时才炸——先取教训写在这）。
  const approvalStoreFile = join(dataDir, 'approval-requests.json');
  process.env.CCM_APPROVAL_STORE_FILE = approvalStoreFile;
  process.env.CCM_AUDIT_FILE = join(dataDir, 'audit-records.json');
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  delete process.env.AUTH_TOKEN;

  // 模拟"上一个进程崩溃/被 kill -9，遗留一条永远等不到 canUseTool 回调兑现的 pending 审批"——
  // 真实字段形状抄 approval-store.js 的 recordCreated。已终态记录的 decidedAt 用"最近"时间戳
  // （而非久远过去）：本测试关心的是重启恢复本身不误碰已终态记录，不是留存治理的清理阈值——
  // 若用久远时间戳，服务端启动时紧接着跑的 NFR-16 留存清理会先把它当"超期"清掉，干扰断言。
  const recentPast = Date.now() - 60_000;
  writeFileSync(approvalStoreFile, JSON.stringify({
    requests: [
      { reqId: 'leftover-1', sessionId: 'sess-old', tool: 'Bash', args: { command: 'ls' }, cwd: dataDir,
        fingerprint: 'deadbeef', risk: null, createdAt: 1000, expiresAt: 2000, status: 'pending', decidedBy: null, decidedAt: null },
      { reqId: 'already-terminal', sessionId: 'sess-old', tool: 'Write', args: {}, cwd: dataDir,
        fingerprint: 'cafef00d', risk: null, createdAt: 1000, expiresAt: 2000, status: 'allow', decidedBy: 'user', decidedAt: recentPast },
      // 真正超过 90 天保留期的终态记录（NFR-16 留存治理，与重启恢复是两回事、同一次启动流程里紧接着跑）：
      // decidedAt=1000（1970 年）必然早于任何"90 天前"的 cutoff，验证启动时的留存清理会把它扫掉。
      { reqId: 'ancient-terminal', sessionId: 'sess-old', tool: 'Read', args: {}, cwd: dataDir,
        fingerprint: 'ba5eba11', risk: null, createdAt: 1000, expiresAt: 2000, status: 'deny', decidedBy: 'user', decidedAt: 1000 },
    ]
  }, null, 2));

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../cf-access.js');
  cfAccess.initCfAccess();
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe('重启后 pending 审批 fail-closed 处置（Phase 4）', process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : {}, () => {
  test.before(async () => { await startServerWithSeededPendingApproval(); });
  test.after(async () => { await cleanup(); });

  test('遗留 pending 记录在启动时被标记 expired，decidedBy=system:restart；已终态记录不受影响', async () => {
    const AS = await import('../../approval-store.js');
    const leftover = AS.getByReqId('leftover-1');
    assert.equal(leftover.status, 'expired');
    assert.equal(leftover.decidedBy, 'system:restart');
    assert.ok(typeof leftover.decidedAt === 'number' && leftover.decidedAt > 0);

    const terminal = AS.getByReqId('already-terminal');
    assert.equal(terminal.status, 'allow'); // 未被重启恢复逻辑误碰
    assert.equal(terminal.decidedBy, 'user');
  });

  test('重启恢复写了一条汇总 audit_record（不含被处置记录的具体内容）', async () => {
    const AU = await import('../../audit.js');
    const rows = AU.listRecent({ limit: 100, action: 'approval_restart_expired' });
    assert.ok(rows.length >= 1);
    const r = rows[0];
    assert.equal(r.outcome, 'expired');
    assert.equal(typeof r.meta.count, 'number');
    assert.ok(r.meta.count >= 1);
    // 不含被处置记录的具体内容（NFR-06）——meta 只应有汇总计数，不应出现 tool/args/cwd 等字段
    assert.deepEqual(Object.keys(r.meta), ['count']);
  });

  test('NFR-16 留存治理：启动时超过保留期的终态记录被清理，写了汇总 audit_record', async () => {
    const AS = await import('../../approval-store.js');
    assert.equal(AS.getByReqId('ancient-terminal'), null); // 1970 年的终态记录应已被清理

    const AU = await import('../../audit.js');
    const rows = AU.listRecent({ limit: 100, action: 'retention_cleanup' });
    assert.ok(rows.length >= 1);
    const r = rows[0];
    assert.equal(r.meta.table, 'approval_request');
    assert.ok(r.meta.count >= 1);
  });
});
