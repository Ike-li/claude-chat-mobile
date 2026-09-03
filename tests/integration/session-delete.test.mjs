// tests/integration/session-delete.test.mjs —— 彻底删除集成测试
//
// transcript 目录的现实约束：deletePermanent 走 SDK 官方 deleteSession，它只操作真实 ~/.claude/projects（无
// 自定义根的口子），history.js 的读也只认这个真实根——两者必须一致，故本测试**必然操作真实
// ~/.claude/projects**，无法像 approval-store/audit 那样重定向到临时目录。风险控制到可接受：
//   ①workDir 是一次性 mkdtemp 随机目录 → 编码后的 project 目录名（含 ccm-session-delete-wd 标识）独一无二，
//     SDK deleteSession 只在这个独一无二的 project dir 里删指定 UUID，碰不到任何真实项目的会话；
//   ②before 先扫清任何上次被 kill 残留的 *ccm-session-delete-wd* 目录（防累积）；③after 清理本次目录。
// 零 token 成本（手写假 .jsonl，不起真 claude 子进程）、走"可靠集成"档（默认 npm test 就跑）。
//
// 2026-08-26：L1 软隐藏（session:delete）已移除，本文件只覆盖 deletePermanent。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { getProjectDir } from '../../app/src/sessions/history.js';
import { waitForServerReady } from './_spawn-server.mjs';

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects'); // 真实 CLI transcript 根（SDK deleteSession 与 history 同源）
// 显式测试专用 token（客户端握手带上它）：不能用 delete AUTH_TOKEN 假装无鉴权——dotenv 在 import
// app/server.js 时会从 .env 重新注入真实 AUTH_TOKEN，client 不带 token 就握手失败（rate-limit.test.mjs 同款）。
const TOKEN = 'session-delete-test-token';
let port, dataDir, workDir, projectDir, httpServer, io;

// 扫清上次被 kill 残留的一次性测试目录（名字含 ccm-session-delete-wd 标识，绝不误伤真实项目）。
function sweepStaleTestDirs() {
  try {
    for (const name of readdirSync(PROJECTS_ROOT)) {
      if (name.includes('ccm-session-delete-wd')) {
        // safe-rm: name 来自 readdirSync(PROJECTS_ROOT) 的真实目录名，且已被上面这行按
        // 'ccm-session-delete-wd' 过滤——只可能命中本测试自己 mkdtemp 出来的一次性 workDir
        // 编码名。它不是被测代码算出来的路径，塌不了。
        try { rmSync(join(PROJECTS_ROOT, name), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* PROJECTS_ROOT 可能尚不存在 */ }
}

function writeFakeSession(sessionId, { quiet = true } = {}) {
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  if (quiet) {
    // 活跃保护②要求 mtime 距今 ≥ 静默阈值——测试把阈值设到很短（见 startServer），仍需 mtime 明确落在过去。
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
  }
  return file;
}

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-session-delete-test-'));
  // realpathSync 与 app/server.js preflight 内部对 WORK_DIR 的归一化对齐——否则 macOS 的 /var→/private/var
  // 符号链接会让 getProjectDir(workDir) 算出的目录名与 app/server.js 实际读写的目录名不一致。
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-session-delete-wd-')));
  projectDir = join(PROJECTS_ROOT, getProjectDir(workDir));

  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR', 'SESSION_DELETE_QUIET_MS',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = workDir;
  process.env.AUTH_TOKEN = TOKEN; // 显式设，dotenv config 时已存在→不覆盖，server 用本值
  process.env.SESSION_DELETE_QUIET_MS = '1000'; // 1s：测试用短阈值，避免真等 5 分钟

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await waitForServerReady(port, TOKEN);
}

function emitAck(socket, event, payload) {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  for (const d of [dataDir, workDir, projectDir]) {
    if (!d || !existsSync(d)) continue;
    // ★ projectDir 是 join(PROJECTS_ROOT, getProjectDir(workDir))——【被测代码算出来的】。
    // getProjectDir 一旦返回 ''，它就塌成 PROJECTS_ROOT 本身，下面这个 recursive+force 会把本机
    // 所有项目的 transcript 与 memory 一次删光。2026-08-02 真实发生过：变异检查把 getProjectDir 的
    // `String(cwd || '')` 改成 `&&` ⇒ 恒返回 ''，整棵 ~/.claude/projects 没了（靠 APFS 快照恢复）。
    // 同型第二处在 tests/unit/history-list-sdk-fastpath.test.mjs（那边另外还跑在假 HOME 下）。
    // 护栏放在执行删除的那一刻：不管路径为什么塌（变异、bug、上游改编码规则），这里都拦得住。
    //
    // 判据是「必须【严格位于】允许的根之下」，不是「不等于 PROJECTS_ROOT」。只比相等的写法恰好
    // 只挡得住 getProjectDir 返回 '' 这一种塌法：返回 '..' 会落到 ~/.claude（PROJECTS_ROOT 的父
    // 目录）上，相等判据放行、rmSync 把整个 CLI 配置连同所有项目一起删掉。今天 getProjectDir 的
    // 实现产不出 '..'，但这条护栏的立身之本就是"不依赖被测代码今天长什么样"（2026-08-03 review）。
    //
    // 两侧都过 realpath 再比：macOS 的 tmpdir() 是 /var/folders/…，而 workDir 建好后做过
    // realpathSync 变成 /private/var/folders/…，不归一化的话前缀判据会把正常清理也拦下来。
    const real = p => { try { return resolve(realpathSync(p)); } catch { return resolve(p); } };
    const target = real(d);
    const inside = [PROJECTS_ROOT, tmpdir()]
      .map(real)
      .some(base => target !== base && target.startsWith(base + sep));
    if (!inside) {
      throw new Error(`拒绝删除：目标不在 PROJECTS_ROOT / tmpdir 之下（路径塌了？）: ${d}`);
    }
    // safe-rm: projectDir 确实由被测代码算出（无法避免——SDK deleteSession 只认真实根），
    // 但正上方的护栏要求它严格位于 PROJECTS_ROOT / tmpdir 之下，塌到根上或根之外都会抛错。
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dataDir = workDir = projectDir = null;
}

test.describe(
  '彻底删除会话',
  () => {
    test.before(async () => { sweepStaleTestDirs(); await startServer(); });
    test.after(async () => { await cleanup(); });

    test('deletePermanent：真删磁盘文件，session:list 也不再出现', async () => {
      const sessionId = '22222222-2222-4222-8222-222222222222';
      const file = writeFakeSession(sessionId);
      const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
      await new Promise(resolve => socket.once('connect', resolve));

      const delRes = await emitAck(socket, 'session:deletePermanent', { sessionId, cwd: workDir });
      assert.equal(delRes.ok, true, JSON.stringify(delRes));
      assert.ok(!existsSync(file), '应真删底层 transcript 文件');

      const after = await emitAck(socket, 'session:list', { cwd: workDir, all: true });
      assert.ok(!after.sessions.some(s => s.id === sessionId));

      socket.disconnect();
    });

    test('活跃保护②：transcript mtime 太新（可能正被终端使用）→ 拒绝，文件不删', async () => {
      const sessionId = '33333333-3333-4333-8333-333333333333';
      const file = writeFakeSession(sessionId, { quiet: false }); // mtime = 现在，未回拨
      const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
      await new Promise(resolve => socket.once('connect', resolve));

      const delRes = await emitAck(socket, 'session:deletePermanent', { sessionId, cwd: workDir });
      assert.equal(delRes.ok, false);
      assert.match(delRes.error, /终端/);
      assert.ok(existsSync(file), '保护②拒绝时文件不应被删');

      socket.disconnect();
    });

    test('不存在的 sessionId → fail-closed 拒绝', async () => {
      const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
      await new Promise(resolve => socket.once('connect', resolve));

      const res = await emitAck(socket, 'session:deletePermanent', { sessionId: 'never-existed', cwd: workDir });
      assert.equal(res.ok, false);
      assert.match(res.error, /不存在/);

      socket.disconnect();
    });

    test('删除后写 audit_record（不含被删内容）', async () => {
      const AU = await import('../../app/src/ops/audit.js');
      const l2Rows = AU.listRecent({ limit: 100, action: 'session_delete_l2' });
      const l2 = l2Rows.find(r => r.target === '22222222-2222-4222-8222-222222222222');
      assert.ok(l2);
      assert.equal(l2.outcome, 'success');
      assert.deepEqual(Object.keys(l2.meta), ['cwd']); // 不含被删内容，只有 cwd
    });
  },
);
