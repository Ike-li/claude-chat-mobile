import '../setup/require-disposable-env.mjs';

// 抽屉「显示更多」（照抄桌面端 Show more，前身是验收 O81 的「显示全部 / 加载更多」）。
// 守的是 session:list 的接线：more 真的按「配置条数 × (1 + more)」放宽了窗口、按 limit + 1 扫才分得清
// 「只多 1 条」（不藏单条），moreCount 上了回执——而不是只在纯函数里算对了。
// 窗口与收尾怎么算由 tests/unit/workdirs.test.mjs 的 sessionListWindow / fitSessionPage 用例守，这里不重复边界。
// 第二组守文件夹「全部标为已读」水位的接线（READ-01）：read:mark {folder} / read:sync folders 记下水位，
// 「显示更多」拉出来的旧会话在回执里就已读——2026-10-26 真机标完已读、展开后冒出 34 个未读。
// 水位怎么合并、怎么折叠由 tests/invariants/read-state.test.mjs 守，这里只证接线。
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
const COUNT = 55; // WORK_DIR 未配 sessionLimit → 每档 6 条（DEFAULT_SESSION_LIMIT）
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

// 整个文件共用一个 server：app/server.js 是 ESM 单例，同一进程里第二次 import 拿到的是已关掉的那个。
// 两组之间靠顺序隔离——「显示更多」那组不写任何已读位点，水位那组排在后面。
let socket;
test.before(async () => {
  sweepStaleTestDirs();
  await startServer();
  socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
  await new Promise(resolve => socket.once('connect', resolve));
});
test.after(async () => { socket?.disconnect(); await cleanup(); });

test.describe('session:list「显示更多」', () => {
  test('没点过：配置条数一档，还有更早的、再点一次多 6 个', async () => {
    const ack = await emitAck(socket, 'session:list', { cwd: workDir });
    assert.equal(ack.sessions.length, 6);
    assert.equal(ack.hasMore, true);
    assert.equal(ack.moreCount, 6);
  });

  test('more:1 把窗口放宽一档，接着原来的往后排', async () => {
    const first = await emitAck(socket, 'session:list', { cwd: workDir });
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, more: 1 });
    assert.equal(ack.sessions.length, 12);
    assert.deepEqual(ack.sessions.slice(0, 6).map(s => s.id), first.sessions.map(s => s.id), '放宽窗口不能打乱已显示的那几行');
    assert.equal(ack.moreCount, 6);
  });

  test('下一档会把剩下的全给时，moreCount 是确切剩余数', async () => {
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, more: 7 }); // 48 条，下一档 54 只差 1 条 → 全给
    assert.equal(ack.sessions.length, 48);
    assert.equal(ack.moreCount, COUNT - 48);
  });

  test('不藏单条：窗口 54、总数 55 时整页全给，没有更早的了', async () => {
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, more: 8 });
    assert.equal(ack.sessions.length, COUNT, '按 limit 扫就看不出只多 1 条，会留一个「显示更多 1 个」');
    assert.equal(ack.hasMore, false);
    assert.equal(ack.moreCount, 0);
  });

  test('搜索态不分档，more 被忽略', async () => {
    const search = await emitAck(socket, 'session:list', { cwd: workDir, query: 'load more', more: 3 });
    assert.equal(search.moreCount, 0);
  });
});

test.describe('session:list × 文件夹「全部标为已读」水位', () => {
  const seenOf = ack => ack.readState?.seen || {};
  // 水位只增不减：后一条用例要证「这次的水位生效了」，它的时刻必须晚于前一条留下的水位
  const laterThanLastMark = () => new Promise(resolve => setTimeout(() => resolve(Date.now()), 5));

  test('越界的文件夹键直接丢弃，不给任何行记位点', async () => {
    socket.emit('read:mark', { folder: '/definitely/not/connected', at: Date.now() });
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, more: 3 });
    assert.deepEqual(seenOf(ack), {});
  });

  test('在第一档标完，再「显示更多」拉出来的旧会话 seen 都不早于水位', async () => {
    const first = await emitAck(socket, 'session:list', { cwd: workDir });
    assert.equal(first.sessions.length, 6);
    const at = Date.now();
    socket.emit('read:mark', { folder: workDir, at });
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, more: 3 });
    const older = ack.sessions.slice(6);
    assert.equal(older.length, 18);
    const stale = older.filter(s => !(seenOf(ack)[s.id] >= at));
    assert.deepEqual(stale.map(s => s.id), [], '这些行从没在屏幕上出现过，只能靠水位算已读');
  });

  test('离线时标的水位随 read:sync 上来（键用前端抽屉的那个 cwd）', async () => {
    const at = await laterThanLastMark();
    const sync = await emitAck(socket, 'read:sync', { seen: {}, manual: {}, folders: { [workDir]: at, '/definitely/not/connected': at } });
    assert.equal(sync.ok, true);
    assert.deepEqual(Object.keys(sync.state).sort(), ['baselineTs', 'manual', 'seen'], 'read:sync 回执形状不变，水位不回传');
    const ack = await emitAck(socket, 'session:list', { cwd: workDir, more: 8 });
    const stale = ack.sessions.filter(s => !(seenOf(ack)[s.id] >= at));
    assert.deepEqual(stale.map(s => s.id), []);
  });
});
