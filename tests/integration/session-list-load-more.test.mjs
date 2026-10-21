import '../setup/require-disposable-env.mjs';

// 验收 O81（AC-04-13）：一个文件夹超过 50 个会话时，「显示全部」只给前 50 个，没有「加载更多」。
// 守的是 session:list 的接线：pages 真的放宽了窗口（而不是只在纯函数里算对了），canLoadMore 上了回执。
// 窗口怎么算由 tests/unit/workdirs.test.mjs 的 sessionListWindow 用例守，这里不重复边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { getProjectDir } from '../../app/src/sessions/history.js';
import { importServerInProcess, waitForServerReady } from './_spawn-server.mjs';

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const TOKEN = 'session-list-load-more-token';
const COUNT = 55; // 比一页（MAX_SESSION_LIMIT=50）多 5 个
let port, dataDir, workDir, projectDir, httpServer, io;

// 扫清上次被 kill 残留的一次性测试目录（名字含 ccm-load-more-wd 标识，绝不误伤真实项目）。
function sweepStaleTestDirs() {
  try {
    for (const name of readdirSync(PROJECTS_ROOT)) {
      if (name.includes('ccm-load-more-wd')) {
        // safe-rm: name 来自 readdirSync(PROJECTS_ROOT) 的真实目录名，且已按 'ccm-load-more-wd' 过滤——
        // 只可能命中本测试自己 mkdtemp 出来的一次性 workDir 编码名，不是被测代码算出来的路径。
        try { rmSync(join(PROJECTS_ROOT, name), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* PROJECTS_ROOT 可能尚不存在 */ }
}

function seedSessions() {
  mkdirSync(projectDir, { recursive: true });
  const base = Date.now() - 3600_000;
  for (let i = 0; i < COUNT; i += 1) {
    const id = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`;
    const file = join(projectDir, `${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: `load more ${i}` } }) + '\n');
    const at = new Date(base + i * 1000); // 时间各不相同，排序确定
    utimesSync(file, at, at);
  }
}

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-load-more-test-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-load-more-wd-')));
  projectDir = join(PROJECTS_ROOT, getProjectDir(workDir));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = workDir;
  process.env.AUTH_TOKEN = TOKEN;
  seedSessions();

  const serverModule = await importServerInProcess();
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;
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
    // 护栏同 session-delete.test.mjs：projectDir 由被测代码算出，必须严格位于 PROJECTS_ROOT / tmpdir 之下才删。
    const real = p => { try { return resolve(realpathSync(p)); } catch { return resolve(p); } };
    const target = real(d);
    const inside = [PROJECTS_ROOT, tmpdir()]
      .map(real)
      .some(base => target !== base && target.startsWith(base + sep));
    if (!inside) throw new Error(`拒绝删除：目标不在 PROJECTS_ROOT / tmpdir 之下（路径塌了？）: ${d}`);
    // safe-rm: projectDir 由被测代码算出，但正上方护栏要求它严格位于 PROJECTS_ROOT / tmpdir 之下
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dataDir = workDir = projectDir = null;
}

test.describe('session:list「加载更多」', () => {
  let socket;
  test.before(async () => {
    sweepStaleTestDirs();
    await startServer();
    socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
    await new Promise(resolve => socket.once('connect', resolve));
  });
  test.after(async () => { socket?.disconnect(); await cleanup(); });

  test('显示全部的第一页：50 个、还有更早的、可以加载更多', async () => {
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, all: true });
    assert.equal(ack.sessions.length, 50);
    assert.equal(ack.hasMore, true);
    assert.equal(ack.canLoadMore, true);
  });

  test('pages:2 把窗口放宽一页：55 个全回，没有更早的了', async () => {
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, all: true, pages: 2 });
    assert.equal(ack.sessions.length, COUNT);
    assert.equal(ack.hasMore, false);
    assert.equal(ack.canLoadMore, false);
  });

  test('截断态与搜索态不给「加载更多」（入口分别是「显示全部」和搜索本身）', async () => {
    const page = await emitAck(socket, 'session:list', { cwd: workDir });
    assert.equal(page.hasMore, true);
    assert.equal(page.canLoadMore, false);
    const search = await emitAck(socket, 'session:list', { cwd: workDir, query: 'load more', pages: 3 });
    assert.equal(search.canLoadMore, false);
  });
});
