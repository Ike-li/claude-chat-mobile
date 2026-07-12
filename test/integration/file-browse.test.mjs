// test/integration/file-browse.test.mjs —— browse:list / browse:read 接线集成测试
// （LLD §3.4.2 FileBrowseHandler，承接 AD-12/FR-07）
// 纯逻辑单测见 test/file-browse.test.mjs + test/workdir-scope-guard.test.mjs；本文件验证 server.js
// 接线：①正常 list/read 走通；②越界 relPath 被拒（fail-closed，不进程崩溃/不误放行）；③鉴权门未过时不可达。
// 鉴权模式同 test/integration/rate-limit.test.mjs：测试专用 token + 清 CF_ACCESS_* + 重新 initCfAccess()
// （机主本机 .env 已配真实鉴权，dotenv 会在 delete 后重新注入——不可用"delete AUTH_TOKEN"假装无鉴权）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
let port, dataDir, projectDir, httpServer, io, socket;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-browse-test-'));
  projectDir = join(dataDir, 'project');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# demo project');
  writeFileSync(join(projectDir, 'src', 'index.js'), 'console.log(1)');
  // macOS tmpdir() 返回 /var/folders/...（符号链接到 /private/var/folders/...），而 server.js 的
  // workDirs 经 resolveWorkdirs() realpath 归一后存的是 /private/... 形式——不 realpath 这里的
  // projectDir，下面测试传入的 cwd 会与 workDirs 内的值字面不等，routeCwd 判"越界"后静默回退到
  // 默认查看目录（恰好也是这个项目目录，会让测试"意外通过"但没有真正测到"cwd 命中白名单"这条路径）。
  projectDir = realpathSync(projectDir);

  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = projectDir;
  process.env.AUTH_TOKEN = 'browse-test-token';

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../cf-access.js');
  cfAccess.initCfAccess();
  await sleep(500);
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

test.describe('browse:list / browse:read 接线集成测试', process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : {}, () => {
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

  test('browse:list 未授权 cwd（不在白名单）→ 归位当前 cwd 后仍在范围内正常返回（不是任意穿越）', async () => {
    // routeCwd 对不在白名单的 cwd 会回退到当前查看目录（同 session:list 现状），不是"拒绝连接"，
    // 但归位后的目录仍受 WorkdirScopeGuard 约束——不会因传了个野路径就打开任意目录。
    const res = await emitAck(socket, 'browse:list', { cwd: '/etc', relPath: '.' });
    assert.equal(res.ok, true); // 归位到授权目录后正常返回，而不是列出 /etc
    const names = res.entries.map(e => e.name).sort();
    assert.deepEqual(names, ['README.md', 'src']); // 证明确实回落到 projectDir，不是 /etc 内容
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
