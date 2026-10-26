// tests/invariants/server/folder-order.test.mjs —— 抽屉文件夹长按拖动排序在真 server 上的接线（取代 #305 置顶）
// 守护：FOLDER-02（手动顺序只改展示顺序，workDirs 与一切回落不读它；只认当前清单的精确排列；存数据目录、不写配置）
// 测什么：真 app/server.js 子进程上 folders:reorder：
//   · 排序只改抽屉清单（instances.projects）的顺序，workDirs（dirs）、不带参数的新会话缺省目录都不动；
//   · 另一台设备收到完整清单，断线期间的变化从重连快照拿到；
//   · 只认当前清单的一个排列：缺根、多出子文件夹 / 前缀相似 / 不存在 / 已移除的根、重复、不是数组一律 invalid_order，
//     存储与广播都不动；
//   · 存在数据目录、不写配置文件：清单来自环境变量时照样能排、重启后还在，配置文件内容与 mtime 不变；
//   · 断开再连接（期间没重新排序）回到原位；升级前置顶留下的存档直接当初始顺序；存档读坏了照常启动、默认顺序、打一行警告。
// 不测什么 + 为什么：① 块排序本身在 S1 tests/unit/projects.test.mjs ② deviceApproved 为 undefined 那一支真 server
//   造不出来（接入路径只赋 true / false），在 tests/unit/socket-folders.test.mjs 用假 socket 测 ③ 前端属 S3
// 槽位：S2（真 app/server.js 子进程 + 假 CLI；HOME、配置文件、数据目录都在一次性目录里）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-folder-order-token';
let root, home, A, B, C;
const servers = [];

const waitFor = async (pred, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = await pred();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};
const writeConfig = (path, config) => writeFileSync(path, `${JSON.stringify({ $schemaVersion: 1, ...config }, null, 2)}\n`);
const connectedOrder = payload => (payload?.projects ?? []).filter(p => p.kind === 'connected').map(p => p.key);

async function startServer({ config, env = {}, dataDir = join(root, `data-${randomUUID().slice(0, 8)}`) } = {}) {
  const configPath = join(root, `ccm.config.${randomUUID().slice(0, 8)}.json`);
  writeConfig(configPath, config ?? {});
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'),
    CCM_DATA_DIR: dataDir, CCM_CONFIG_FILE_PATH: configPath, CCM_ENV_FILE_PATH: join(root, 'no-such.env'),
    WORK_DIRS: '', WORK_DIRS_FILE: '', ...env,
  });
  let output = '';
  server.proc.stdout.on('data', c => { output += c; });
  server.proc.stderr.on('data', c => { output += c; });
  const handle = { server, configPath, dataDir, output: () => output, stop: () => killServer(server.proc) };
  servers.push(handle);
  return handle;
}

async function connect(handle, deviceToken = `inv-order-${randomUUID().slice(0, 8)}`) {
  const events = [];
  const sock = await new Promise((resolve, reject) => {
    const s = ioClient(`http://127.0.0.1:${handle.server.port}`, {
      auth: { token: TOKEN, deviceToken },
      transports: ['websocket'], reconnection: false, timeout: 4000, extraHeaders: { Host: 'localhost' },
    });
    s.on('agent:event', e => events.push(e));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
  const client = {
    sock,
    events,
    instancesEvents: () => events.filter(e => e.type === 'instances').map(e => e.payload),
    latest: () => client.instancesEvents().at(-1),
    emit: (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 10000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    }),
    emitBare: event => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 10000);
      sock.emit(event, res => { clearTimeout(timer); resolve(res); });
    }),
    close: () => { try { sock.close(); } catch { /* 已关闭 */ } },
  };
  await waitFor(() => client.latest(), '连上时的 instances 快照');
  return client;
}

test.before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-folder-order-')));
  home = join(root, 'home');
  [A, B, C] = ['a', 'b', 'c'].map(n => join(home, 'code', n));
  for (const d of [A, B, C, join(A, 'sub'), `${A}2`]) mkdirSync(d, { recursive: true });
});

test.after(async () => {
  for (const s of servers) await s.stop();
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test('排序只改抽屉顺序：另一台设备收到完整清单；dirs 与新会话缺省目录不动；重连快照带断线期间的变化', async () => {
  const srv = await startServer({ config: { WORKDIRS: [A, B, C] } });
  const one = await connect(srv);
  const two = await connect(srv);
  assert.deepEqual(connectedOrder(two.latest()), [A, B, C]);

  assert.deepEqual(await one.emit('folders:reorder', { roots: [C, A, B] }), { ok: true });
  await waitFor(() => connectedOrder(two.latest()).join() === [C, A, B].join(), '另一台设备收到新顺序的完整清单');
  assert.equal((two.latest().projects ?? []).some(p => 'pinned' in p), false, '置顶已取消，清单里不该再有 pinned');

  assert.deepEqual(two.latest().dirs, [A, B, C], '排序不得改授权用的根列表');
  const home0 = await one.emitBare('session:new');
  assert.equal(home0?.ok, true, JSON.stringify(home0));
  await waitFor(() => one.latest()?.viewingCwd === A, '不带参数的新会话仍落在主工作目录 A（不是排在最前的 C）');

  two.close();
  assert.deepEqual(await one.emit('folders:reorder', { roots: [B, C, A] }), { ok: true });
  const back = await connect(srv);
  assert.deepEqual(connectedOrder(back.instancesEvents()[0]), [B, C, A], '重连时的快照没带上断线期间的新顺序');
});

test('只认当前清单的精确排列：缺根、多出别的路径、重复、不是数组都拒绝，存储与广播不动', async () => {
  const srv = await startServer({ config: { WORKDIRS: [A, B, C] } });
  const c = await connect(srv);
  writeConfig(srv.configPath, { WORKDIRS: [A, C] }); // B 被移出清单
  await waitFor(() => c.latest()?.dirs?.length === 2, '热加载后 dirs 只剩 A、C');
  const seen = c.instancesEvents().length;
  const bad = [
    [C], // 缺一个
    [C, A, B], // 带上已移除的根
    [C, join(A, 'sub')], // 子文件夹顶替了根
    [C, `${A}2`], // 前缀相似
    [C, join(home, 'code', 'nope')],
    [C, C], // 重复
    [C, A, A],
    [],
    `${C},${A}`,
    null,
  ];
  for (const roots of bad) {
    assert.deepEqual(await c.emit('folders:reorder', { roots }), { ok: false, error: 'invalid_order' }, JSON.stringify(roots));
  }
  await new Promise(r => setTimeout(r, 400)); // 过了写盘防抖窗
  assert.equal(existsSync(join(srv.dataDir, 'pinned-roots.json')), false, '被拒的顺序写进了存储');
  assert.deepEqual(c.instancesEvents().slice(seen).map(connectedOrder).filter(o => o.join() !== [A, C].join()), [], '被拒的顺序出现在了广播里');
});

test('存在数据目录、不写配置文件：清单来自环境变量也能排序，重启后还在，配置文件内容与 mtime 不变', async () => {
  const dataDir = join(root, 'data-env-source');
  const env = { WORK_DIRS: `${A},${B}` };
  const first = await startServer({ config: {}, env, dataDir });
  const before = { text: readFileSync(first.configPath, 'utf8'), mtime: statSync(first.configPath).mtimeMs };
  const c = await connect(first);
  assert.equal(c.latest().foldersReadonly !== null, true, '前提：清单来自环境变量，手机上改不了 WORKDIRS');
  assert.deepEqual(await c.emit('folders:reorder', { roots: [B, A] }), { ok: true });
  await waitFor(() => connectedOrder(c.latest())[0] === B, '排序生效');
  c.close();
  await first.stop(); // SIGTERM → 退出前同步 flush

  assert.equal(readFileSync(first.configPath, 'utf8'), before.text, '顺序写进了配置文件');
  assert.equal(statSync(first.configPath).mtimeMs, before.mtime, '配置文件被重写过');
  const second = await startServer({ config: {}, env, dataDir });
  const again = await connect(second);
  assert.deepEqual(connectedOrder(again.latest()), [B, A], '重启后顺序丢了');
});

test('断开再连接：期间没重新排序的话记录不清，重新加入后回到原位', async () => {
  const srv = await startServer({ config: { WORKDIRS: [A, B] } });
  const c = await connect(srv);
  assert.deepEqual(await c.emit('folders:reorder', { roots: [B, A] }), { ok: true });
  await waitFor(() => connectedOrder(c.latest())[0] === B, '排序生效');
  writeConfig(srv.configPath, { WORKDIRS: [A] });
  await waitFor(() => c.latest()?.dirs?.length === 1, '热加载移除 B');
  assert.deepEqual(connectedOrder(c.latest()), [A], '移除的根不该还显示在清单里');
  await waitFor(() => existsSync(join(srv.dataDir, 'pinned-roots.json')), '顺序落盘');
  assert.deepEqual(JSON.parse(readFileSync(join(srv.dataDir, 'pinned-roots.json'), 'utf8')), [B, A], '移除时把记录清掉了');
  writeConfig(srv.configPath, { WORKDIRS: [A, B] });
  await waitFor(() => connectedOrder(c.latest()).join() === [B, A].join(), '重新加入后 B 回到最前');
});

test('升级前置顶留下的存档直接当初始顺序：在数组里的在前，其余按配置顺序', async () => {
  const dataDir = join(root, 'data-legacy-pins');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'pinned-roots.json'), JSON.stringify([C]));
  const srv = await startServer({ config: { WORKDIRS: [A, B, C] }, dataDir });
  const c = await connect(srv);
  assert.deepEqual(connectedOrder(c.latest()), [C, A, B]);
});

test('存档读坏了：照常启动，默认顺序，打一行警告', async () => {
  const dataDir = join(root, 'data-corrupt');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'pinned-roots.json'), '{not json');
  const srv = await startServer({ config: { WORKDIRS: [A, B] }, dataDir });
  const c = await connect(srv);
  assert.deepEqual(connectedOrder(c.latest()), [A, B]);
  await waitFor(() => /\[folder-order\].*按默认顺序启动/.test(srv.output()), '读坏档的警告');
});
