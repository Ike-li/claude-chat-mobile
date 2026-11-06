// tests/integration/saved-environments.test.mjs —— 保存的环境在真 server 上的接线
// 测什么：真 app/server.js 子进程上 environments:*：
//   · 已连接的文件夹能存能列；防抖窗内收到 SIGTERM 也不丢（退出时的 flush 接上了），重启后还在；
//   · 范围外的文件夹、「无文件夹」的键都存不进去；
//   · 文件夹断开后 available 变 false、环境不丢，重新连接后恢复。
// 不测什么 + 为什么：① 名字、重名、损坏文件在 S1 tests/unit/saved-environments.test.mjs ② deviceApproved 为 undefined
//   那一支真 server 造不出来，在 tests/unit/socket-environments.test.mjs 用假 socket 测 ③ 前端属 S3
// 槽位：S2（真 app/server.js 子进程 + 假 CLI；HOME、配置文件、数据目录都在一次性目录里）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';

const TOKEN = 'inv-saved-environments-token';
let root, home, A, OUTSIDE;
const servers = [];
const sockets = [];

const writeConfig = (path, config) => writeFileSync(path, `${JSON.stringify({ $schemaVersion: 1, ...config }, null, 2)}\n`);
const waitFor = async (pred, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = await pred();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};

async function startServer({ configPath, dataDir }) {
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'),
    CCM_DATA_DIR: dataDir, CCM_CONFIG_FILE_PATH: configPath, CCM_ENV_FILE_PATH: join(root, 'no-such.env'),
    WORK_DIRS: '', WORK_DIRS_FILE: '',
  });
  const handle = { server, stop: () => killServer(server.proc) };
  servers.push(handle);
  return handle;
}

async function connect(handle) {
  const events = [];
  const sock = await new Promise((resolve, reject) => {
    const s = ioClient(`http://127.0.0.1:${handle.server.port}`, {
      auth: { token: TOKEN, deviceToken: `inv-env-${randomUUID().slice(0, 8)}` },
      transports: ['websocket'], reconnection: false, timeout: 4000, extraHeaders: { Host: 'localhost' },
    });
    s.on('agent:event', e => events.push(e));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
  sockets.push(sock);
  const client = {
    latest: () => events.filter(e => e.type === 'instances').at(-1)?.payload,
    emit: (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 10000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    }),
    list: async () => (await client.emit('environments:list', {})).environments,
  };
  await waitFor(() => client.latest(), '连上时的 instances 快照');
  return client;
}

const fresh = () => {
  const id = randomUUID().slice(0, 8);
  const configPath = join(root, `ccm.config.${id}.json`);
  writeConfig(configPath, { WORKDIRS: [A] });
  return { configPath, dataDir: join(root, `data-${id}`) };
};
const ENV = () => ({ name: '日常', cwd: A, model: 'opus', effort: 'xhigh', worktree: true });

test.before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-int-saved-env-')));
  home = join(root, 'home');
  A = join(home, 'code', 'a');
  OUTSIDE = join(home, 'code', 'outside');
  for (const d of [A, OUTSIDE]) mkdirSync(d, { recursive: true });
});

test.after(async () => {
  for (const s of sockets) s.close();
  for (const s of servers) await s.stop();
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test('存了就列得出来；防抖窗内收到 SIGTERM 也不丢，重启后还在', async () => {
  const paths = fresh();
  const srv = await startServer(paths);
  const c = await connect(srv);
  assert.deepEqual(await c.list(), []);

  const saved = await c.emit('environments:save', ENV());
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await srv.stop(); // 紧跟着退出：还在 200ms 防抖窗内，靠退出时的 flush 落盘

  assert.deepEqual(JSON.parse(readFileSync(join(paths.dataDir, 'environments.json'), 'utf8')).map(e => e.name), ['日常']);
  const again = await connect(await startServer(paths));
  assert.deepEqual(await again.list(), [{ ...ENV(), id: saved.environment.id, available: true }]);
});

test('范围外的文件夹、「无文件夹」的键都存不进去', async () => {
  const c = await connect(await startServer(fresh()));
  const { scratchRoot } = c.latest();
  assert.ok(scratchRoot, 'instances 快照要带 scratchRoot');
  for (const cwd of [OUTSIDE, scratchRoot, join(A, '..', 'outside')]) {
    assert.deepEqual(await c.emit('environments:save', { ...ENV(), cwd }), { ok: false, error: 'out_of_range' }, cwd);
  }
  assert.deepEqual(await c.list(), []);
});

test('文件夹断开后环境还在、标 available=false，能改名；重新连接后恢复', async () => {
  const paths = fresh();
  const c = await connect(await startServer(paths));
  const { environment } = await c.emit('environments:save', ENV());

  writeConfig(paths.configPath, { WORKDIRS: [OUTSIDE] });
  await waitFor(() => c.latest()?.dirs?.includes(OUTSIDE), '热加载后 A 被断开');
  assert.equal((await c.list())[0].available, false);
  const renamed = await c.emit('environments:save', { ...ENV(), id: environment.id, name: '改名' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));

  writeConfig(paths.configPath, { WORKDIRS: [A] });
  await waitFor(() => c.latest()?.dirs?.includes(A), '热加载后 A 重新连接');
  const [env] = await c.list();
  assert.equal(env.available, true);
  assert.equal(env.name, '改名');
});
