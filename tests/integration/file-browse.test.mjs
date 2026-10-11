// tests/integration/file-browse.test.mjs —— browse:list / browse:read 接线集成测试
// （FileBrowseHandler，承接 AD-12/FR-07）
// 纯逻辑单测见 tests/unit/file-browse.test.mjs + tests/unit/workdir-scope-guard.test.mjs；本文件验证 app/server.js
// 接线：①正常 list/read 走通；②越界 relPath 被拒（fail-closed，不进程崩溃/不误放行）；③鉴权门未过时不可达。
// 鉴权模式同 tests/integration/rate-limit.test.mjs：测试专用 token + 清 CF_ACCESS_* + 重新 initCfAccess()
// （本机 .env 已配真实鉴权，dotenv 会在 delete 后重新注入——不可用"delete AUTH_TOKEN"假装无鉴权）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { reserveFreePort, waitForServerReady } from './_spawn-server.mjs';

let port, dataDir, projectDir, httpServer, io, socket;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-browse-test-'));
  projectDir = join(dataDir, 'project');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# demo project');
  writeFileSync(join(projectDir, 'src', 'index.js'), 'console.log(1)');
  // macOS tmpdir() 返回 /var/folders/...（符号链接到 /private/var/folders/...），而 app/server.js 的
  // workDirs 经 resolveWorkdirs() realpath 归一后存的是 /private/... 形式——不 realpath 这里的
  // projectDir，下面测试传入的 cwd 会与 workDirs 内的值字面不等，routeCwd 判"越界"后静默回退到
  // 默认查看目录（恰好也是这个项目目录，会让测试"意外通过"但没有真正测到"cwd 命中白名单"这条路径）。
  projectDir = realpathSync(projectDir);

  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(await reserveFreePort());
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = projectDir;
  process.env.AUTH_TOKEN = 'browse-test-token';

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await waitForServerReady(port, 'browse-test-token');
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: 'browse-test-token' }, transports: ['websocket'], reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
    s.once('connect', () => { clearTimeout(timer); resolve(s); });
    s.once('connect_error', err => { clearTimeout(timer); reject(err); });
  });
}

function emitAck(s, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 无响应超时`)), 5000);
    s.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
}

async function cleanup() {
  if (socket) { socket.disconnect(); socket = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe('browse:list / browse:read 接线集成测试', () => {
  test.before(async () => {
    await startServer();
    socket = await connect();
  });
  test.after(async () => { await cleanup(); });

  test('browse:list 正常列出授权目录', async () => {
    const res = await emitAck(socket, 'browse:list', { cwd: projectDir, relPath: '.' });
    assert.equal(res.ok, true);
    const names = res.entries.map(e => e.name).sort();
    assert.deepEqual(names, ['README.md', 'src']);
  });

  test('browse:read 正常读取文件内容', async () => {
    const res = await emitAck(socket, 'browse:read', { cwd: projectDir, relPath: 'README.md' });
    assert.equal(res.ok, true);
    assert.equal(res.content, '# demo project');
    assert.equal(res.binary, false);
  });

  test('browse:list 越界 relPath（../ 逃逸）→ fail-closed 拒绝，不崩溃', async () => {
    const res = await emitAck(socket, 'browse:list', { cwd: projectDir, relPath: '../../etc' });
    assert.equal(res.ok, false);
    assert.ok(typeof res.error === 'string' && res.error.length > 0);
  });

  test('browse:read 越界 relPath（../ 逃逸）→ fail-closed 拒绝', async () => {
    const res = await emitAck(socket, 'browse:read', { cwd: projectDir, relPath: '../../etc/passwd' });
    assert.equal(res.ok, false);
  });

  // FR-19 最小审计记录（承接 Phase 4）：上面两个越界用例应各留一条 scope_violation 审计记录——
  // 复用同一个已鉴权 server 实例，audit.js 落盘目标已被 CCM_DATA_DIR 隔离到本测试的临时目录。
  test('越界拒绝会各写一条 scope_violation 审计记录（via=browse:list / browse:read）', async () => {
    const AU = await import('../../app/src/ops/audit.js');
    const rows = AU.listRecent({ limit: 100, action: 'scope_violation' });
    assert.ok(rows.some(r => r.meta?.via === 'browse:list'), `应有 browse:list 越界审计，实际：${JSON.stringify(rows)}`);
    assert.ok(rows.some(r => r.meta?.via === 'browse:read'), `应有 browse:read 越界审计，实际：${JSON.stringify(rows)}`);
  });

  // 2026-09-24（SCOPE-05）：显式越界从「静默回退当前查看目录」改为拒绝。回退在按项目浏览之后就是错数据——
  // 用户点的是 A，面板里列的却是另一个目录的文件，而且不报任何错。
  test('browse:list 未授权 cwd（不在已连接的文件夹里）→ 拒绝，既不列 /etc 也不偷偷换成别的目录', async () => {
    const res = await emitAck(socket, 'browse:list', { cwd: '/etc', relPath: '.' });
    assert.equal(res.ok, false, `越界 cwd 必须拒绝，实际 ${JSON.stringify(res)}`);
    assert.equal(res.entries, undefined, '拒绝就不该带任何目录项——不管是 /etc 的还是回退目录的');
    assert.match(res.error, /不在已连接的文件夹里/);
  });

  test('未鉴权连接不可达 browse:list（握手层已拦，无 ack 回执）', async () => {
    const bad = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: 'wrong-token' }, transports: ['websocket'], reconnection: false,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bad.disconnect(); reject(new Error('期望 connect_error 但未收到')); }, 5000);
      bad.once('connect_error', () => { clearTimeout(timer); resolve(); });
      bad.once('connect', () => { clearTimeout(timer); bad.disconnect(); reject(new Error('不应连接成功')); });
    });
  });
});
